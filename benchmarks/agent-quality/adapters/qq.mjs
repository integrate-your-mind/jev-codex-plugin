import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';

const DEFAULT_MODEL = 'openai-codex/gpt-6.1-sol';
const DEFAULT_EFFORT = 'high';
const DISCOVERY = join(homedir(), 'Library/Application Support/dev.qq.qq/runtime/server.ron');
const ROUTES = {
  capabilities: '/v1/capabilities', resolve: '/v1/workspaces/resolve', create: '/v1/sessions',
  prompt: '/v1/sessions/prompts', profile: '/v1/sessions/profile', model: '/v1/sessions/model',
  effort: '/v1/sessions/effort', approval: '/v1/sessions/approval-mode', delete: '/v1/sessions/delete',
};

function safeName(value) { return String(value ?? 'trial').replace(/[^a-zA-Z0-9._-]/g, '_'); }
function finite(value) { return Number.isFinite(value) ? value : null; }
function jsonHeaders(token) { return { authorization: `Bearer ${token}`, 'content-type': 'application/json' }; }

/** Parse server.ron without ever returning the bearer token in a receipt/error. */
export function parseDiscovery(text) {
  const address = text.match(/address:\s*"([^"]+)"/)?.[1];
  const token = text.match(/token:\s*"([^"]+)"/)?.[1];
  const version = text.match(/version:\s*"([^"]+)"/)?.[1] ?? null;
  const protocolVersion = finite(Number(text.match(/protocol_version:\s*(\d+)/)?.[1]));
  if (!address || !token) throw new Error('QQ server discovery is missing address or token');
  return { address: `http://${address}`, token, version, protocolVersion };
}

async function atomicJson(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temp, path);
}

function commandId() { return randomUUID().replaceAll('-', ''); }
function requestFor(command) { return { command_id: commandId(), command }; }
function modelSelection(model) { return { model_is_fallback: false, model }; }
function profileSummary(capabilities, profile) {
  const profiles = capabilities?.profiles ?? [];
  return profiles.find((item) => (item?.id?.value ?? item?.id) === profile) ?? null;
}
function usageFrom(value) {
  if (!value || typeof value !== 'object') return { inputTokens: null, cachedInputTokens: null, outputTokens: null, reasoningTokens: null };
  return { inputTokens: finite(value.input_tokens ?? value.inputTokens), cachedInputTokens: finite(value.cache_read_input_tokens ?? value.cachedInputTokens), outputTokens: finite(value.output_tokens ?? value.outputTokens), reasoningTokens: finite(value.reasoning_tokens ?? value.reasoningTokens) };
}
function costFrom(value) {
  const nanos = finite(value?.estimated_cost_usd_nanos ?? value?.estimatedCostUsdNanos);
  return nanos == null ? null : nanos / 1e9;
}
function eventValue(item) { return item?.event ?? item?.data ?? item; }
function sseLines(text) {
  const events = [];
  for (const block of String(text).split(/\n\n+/)) {
    const data = block.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('\n');
    if (!data || data === '[DONE]') continue;
    try { events.push(JSON.parse(data)); } catch { /* raw malformed SSE is retained separately */ }
  }
  return events;
}
function jevReceipt(events) {
  const reviews = events.filter((entry) => eventValue(entry)?.type === 'checkpoint_reviewed' || eventValue(entry)?.type === 'CheckpointReviewed');
  const attempts = events.filter((entry) => ['checkpoint_started', 'CheckpointStarted'].includes(eventValue(entry)?.type));
  const requestIds = [];
  for (const entry of reviews) {
    const event = eventValue(entry);
    for (const key of ['request_id', 'requestId', 'delegate_request_id', 'delegateRequestId']) if (typeof event?.[key] === 'string' && event[key]) requestIds.push(event[key]);
  }
  return { enabled: reviews.length > 0 || attempts.length > 0, attempts: attempts.length, responses: reviews.length, validatedResponses: reviews.filter((entry) => /support|approved|valid/i.test(String(eventValue(entry)?.outcome ?? ''))).length, abstentions: reviews.filter((entry) => /abstain|low_confidence/i.test(String(eventValue(entry)?.outcome ?? ''))).length, requestIds: [...new Set(requestIds)], observerOnly: false, requestIdEvidence: requestIds.length ? 'qq-event' : 'not-exposed-by-qq-event-protocol' };
}
function terminal(events) {
  return [...events].reverse().find((entry) => ['run_finished', 'RunFinished', 'completed', 'failed'].includes(eventValue(entry)?.type));
}

async function defaultTransport() {
  return {
    async request(method, url, body, headers, timeoutMs) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(url, { method, headers, body: body == null ? undefined : JSON.stringify(body), signal: controller.signal });
        const text = await response.text();
        let parsed; try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = text; }
        if (!response.ok) throw new Error(`QQ HTTP ${response.status}`);
        return { status: response.status, body: parsed, headers: Object.fromEntries(response.headers.entries()) };
      } finally { clearTimeout(timer); }
    },
    async stream(url, headers, timeoutMs, onEvent) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(url, { headers, signal: controller.signal });
        if (!response.ok || !response.body) throw new Error(`QQ events HTTP ${response.status}`);
        const reader = response.body.getReader(); let buffer = '';
        while (true) { const { done, value } = await reader.read(); if (done) break; buffer += new TextDecoder().decode(value); const parts = buffer.split(/\n\n+/); buffer = parts.pop() ?? ''; for (const event of sseLines(parts.join('\n\n'))) await onEvent(event); }
      } finally { clearTimeout(timer); }
    },
  };
}

/** Run one QQ trial. Provider submission is deliberately gated by authorizeProvider. */
export async function runTrial(options = {}) {
  const { workspace, prompt, followups = [], arm, outputDir, pluginRoot = null, runId = randomUUID(), model = DEFAULT_MODEL, effort = DEFAULT_EFFORT, timeoutMs = 15 * 60_000, approvalMode = 'read_only', authorizeProvider = false, discoveryPath = DISCOVERY, transport: suppliedTransport } = options;
  if (!workspace || !prompt || !outputDir || !['off', 'on'].includes(arm)) throw new TypeError('workspace, prompt, arm, and outputDir are required');
  if (arm === 'on' && !pluginRoot) throw new TypeError('pluginRoot is required for the on arm');
  const runRoot = resolve(outputDir, safeName(runId)); await mkdir(runRoot, { recursive: true, mode: 0o700 });
  const eventsPath = join(runRoot, 'events.json'); const receiptPath = join(runRoot, 'receipt.json');
  const started = Date.now(); let discovery; let events = []; let sessionId = null; let workspaceId = null; let resolvedModel = null; let resolvedEffort = null; let setupError = null;
  try {
    discovery = parseDiscovery(await readFile(discoveryPath, 'utf8'));
    const transport = suppliedTransport ?? await defaultTransport();
    const headers = jsonHeaders(discovery.token);
    const request = (route, body) => transport.request('POST', `${discovery.address}${route}`, body, headers, timeoutMs);
    const health = await request('/v1/capabilities', { workspace_id: null });
    const capabilities = health.body ?? {};
    const profile = arm === 'on' ? 'jev' : 'default';
    const selected = profileSummary(capabilities, profile);
    if (arm === 'on' && !selected) throw new Error('QQ on-arm treatment unavailable: trusted jev profile is not advertised by capabilities');
    // Routing must remain off for both arms. Newer servers expose this in the
    // capability document; when absent we retain the profile as the source of
    // truth and record the limitation in the receipt rather than guessing.
    if (arm === 'on' && (capabilities.jev_routing === true || capabilities.jevRouting === true || capabilities.routing === 'on')) throw new Error('QQ on-arm treatment unavailable: routing is enabled');
    if (!selected && profile === 'default' && capabilities.profiles && !profileSummary(capabilities, 'default')) throw new Error('QQ default profile is not advertised by capabilities');
    const resolved = await request(ROUTES.resolve, requestFor({ type: 'resolve_workspace', path: resolve(workspace) }));
    workspaceId = resolved.body?.outcome?.workspace_id ?? resolved.body?.workspace_id ?? resolved.body?.workspaceId;
    if (!workspaceId) throw new Error('QQ workspace resolution did not return a workspace id');
    const create = await request(ROUTES.create, requestFor({ type: 'create_session', workspace_id: workspaceId, parent_id: null, model: modelSelection(model), approval_mode: approvalMode, profile, reasoning_effort: effort, correlation: {} }));
    sessionId = create.body?.outcome?.session_id ?? create.body?.session_id ?? create.body?.sessionId;
    if (!sessionId) throw new Error('QQ session creation did not return a session id');
    resolvedModel = create.body?.outcome?.model ?? create.body?.model ?? model;
    resolvedEffort = create.body?.outcome?.reasoning_effort ?? create.body?.reasoning_effort ?? effort;
    const configuration = { arm, profile, modelRequested: model, effortRequested: effort, approvalMode, routingDisabled: true, routingEvidence: capabilities.jev_routing !== undefined || capabilities.jevRouting !== undefined || capabilities.routing !== undefined ? 'capabilities' : 'server-capabilities-did-not-expose-routing', reviewEvidence: arm === 'on' ? 'trusted-profile-advertised; review-mode detail is server-owned' : 'default-profile', serverVersion: discovery.version, protocolVersion: discovery.protocolVersion, treatment: arm === 'on' ? 'native-checkpoint-review' : 'no-jev', treatmentEvidence: selected ? 'capabilities-profile' : 'default-profile', pluginRoot: arm === 'on' ? resolve(pluginRoot) : null, workspace: resolve(workspace) };
    if (!authorizeProvider) {
      const receipt = { runId, arm, exitCode: null, completion: 'not_started', requestedModel: model, resolvedModel, requestedEffort: effort, resolvedEffort, usage: usageFrom(null), cost: { reportedUsd: null, estimatedUsd: null, billedUsd: null, attribution: 'unavailable' }, wallMs: Date.now() - started, sessionId, workspaceId, jev: { enabled: arm === 'on', attempts: 0, responses: 0, validatedResponses: 0, abstentions: 0, requestIds: [], observerOnly: false, requestIdEvidence: 'not-started' }, configuration, isolation: { cwd: resolve(workspace), privateReceipt: receiptPath, sameApprovalModeAcrossArms: true }, error: 'provider execution requires explicit authorizeProvider:true' };
      await atomicJson(eventsPath, events); await atomicJson(receiptPath, receipt); return receipt;
    }
    const submit = async (text) => request(ROUTES.prompt, requestFor({ type: 'submit_prompt', session_id: sessionId, input: [{ type: 'text', text }], limits: {}, correlation: {}, output: null }));
    const first = await submit(prompt); const runIdFromServer = first.body?.outcome?.run_id ?? first.body?.run_id;
    const cursor = first.body?.committed_through?.sequence ?? 0;
    await transport.stream(`${discovery.address}/v1/workspaces/${encodeURIComponent(workspaceId)}/events`, { ...headers, 'last-event-id': String(cursor) }, timeoutMs, (event) => { events.push(event); });
    for (const followup of followups) { await submit(followup); }
    const finish = terminal(events); const event = eventValue(finish); const usage = usageFrom(event?.usage); const estimated = costFrom(event?.usage ?? event); const success = Boolean(finish && !/fail|error/i.test(String(event?.outcome ?? event?.status ?? '')));
    resolvedModel = event?.session?.model ?? resolvedModel; resolvedEffort = event?.session?.reasoning_effort ?? resolvedEffort;
    const receipt = { runId, arm, exitCode: success ? 0 : 1, completion: success, requestedModel: model, resolvedModel, requestedEffort: effort, resolvedEffort, usage, cost: { reportedUsd: null, estimatedUsd: estimated, billedUsd: null, attribution: estimated == null ? 'unavailable' : 'qq-reported-estimate' }, wallMs: Date.now() - started, sessionId, workspaceId, serverRunId: runIdFromServer ?? null, jev: jevReceipt(events), configuration, isolation: { cwd: resolve(workspace), privateReceipt: receiptPath, sameApprovalModeAcrossArms: true }, raw: { eventsPath }, error: success ? null : 'QQ run did not produce a successful terminal event' };
    await atomicJson(eventsPath, events); await atomicJson(receiptPath, receipt); return receipt;
  } catch (error) { setupError = error; }
  const receipt = { runId, arm, exitCode: null, completion: false, requestedModel: model, resolvedModel, requestedEffort: effort, resolvedEffort, usage: usageFrom(null), cost: { reportedUsd: null, estimatedUsd: null, billedUsd: null, attribution: 'unavailable' }, wallMs: Date.now() - started, sessionId, workspaceId, jev: { enabled: arm === 'on', attempts: 0, responses: 0, validatedResponses: 0, abstentions: 0, requestIds: [], observerOnly: false, requestIdEvidence: 'not-started' }, configuration: { arm, profile: arm === 'on' ? 'jev' : 'default', modelRequested: model, effortRequested: effort, approvalMode, routingDisabled: true, workspace: resolve(workspace), pluginRoot: arm === 'on' ? resolve(pluginRoot) : null }, isolation: { cwd: resolve(workspace), privateReceipt: receiptPath, sameApprovalModeAcrossArms: true }, error: setupError?.message ?? 'QQ setup failed' };
  await atomicJson(eventsPath, events); await atomicJson(receiptPath, receipt); return receipt;
}

export const defaults = { model: DEFAULT_MODEL, effort: DEFAULT_EFFORT, discoveryPath: DISCOVERY };
