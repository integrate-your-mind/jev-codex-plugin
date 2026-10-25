import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { performance } from 'node:perf_hooks';

const DEFAULT_MODEL = 'openai-codex/gpt-6.1-sol';
const DEFAULT_EFFORT = 'high';
const DISCOVERY = join(homedir(), 'Library/Application Support/dev.qq.qq/runtime/server.ron');
const ROUTES = {
  snapshot: '/v1/workspaces/snapshot', capabilities: '/v1/capabilities', resolve: '/v1/workspaces/resolve', create: '/v1/sessions',
  prompt: '/v1/sessions/prompts', profile: '/v1/sessions/profile', model: '/v1/sessions/model',
  effort: '/v1/sessions/effort', approval: '/v1/sessions/approval-mode', toolApproval: '/v1/tools/approvals', delete: '/v1/sessions/delete',
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
function cursorString(cursor) {
  if (typeof cursor === 'string') return cursor;
  if (cursor && cursor.store_id && cursor.workspace_id && Number.isFinite(cursor.sequence)) return `${cursor.store_id}:${cursor.workspace_id}:${cursor.sequence}`;
  return null;
}
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
function jevReceipt(events, ownedRunId, arm) {
  const owned = ownedRunId ? events.filter((entry) => (entry?.run_id ?? eventValue(entry)?.run_id) === ownedRunId) : events;
  const reviews = owned.filter((entry) => eventValue(entry)?.type === 'checkpoint_reviewed' || eventValue(entry)?.type === 'CheckpointReviewed');
  const attempts = owned.filter((entry) => ['checkpoint_started', 'CheckpointStarted'].includes(eventValue(entry)?.type));
  const requestIds = [];
  for (const entry of reviews) {
    const event = eventValue(entry);
    for (const key of ['request_id', 'requestId', 'delegate_request_id', 'delegateRequestId']) if (typeof event?.[key] === 'string' && event[key]) requestIds.push(event[key]);
  }
  const adviceDeliveries = reviews.filter((entry) => String(eventValue(entry)?.feedback ?? '').trim().length > 0).length;
  const dispatched = reviews.some((entry) => eventValue(entry)?.spend != null);
  return { enabled: reviews.length > 0 || attempts.length > 0, contacted: arm === 'off' ? false : (dispatched ? true : null), providerContacted: arm === 'off' ? false : (dispatched ? true : null), scope: 'owned-run-event-filter', attempts: attempts.length, responses: reviews.length, validatedResponses: null, adviceDeliveries, abstentions: reviews.filter((entry) => /abstain|low_confidence/i.test(String(eventValue(entry)?.outcome ?? ''))).length, requestIds: [...new Set(requestIds)], observerOnly: false, requestIdEvidence: requestIds.length ? 'qq-event' : 'not-exposed-by-qq-event-protocol' };
}
function terminal(events) {
  return [...events].reverse().find((entry) => ['run_finished', 'RunFinished', 'completed', 'failed'].includes(eventValue(entry)?.type));
}

async function defaultTransport() {
  return {
    async request(method, url, body, headers, timeoutMs, signal) {
      const controller = new AbortController();
      if (signal) { if (signal.aborted) controller.abort(); else signal.addEventListener('abort', () => controller.abort(), { once: true }); }
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(url, { method, headers, body: body == null ? undefined : JSON.stringify(body), signal: controller.signal });
        const text = await response.text();
        let parsed; try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = text; }
        if (!response.ok) { const detail = typeof parsed === 'string' ? parsed : JSON.stringify(parsed); throw new Error(`QQ HTTP ${response.status}: ${String(detail).slice(0, 4096)}`); }
        return { status: response.status, body: parsed, headers: Object.fromEntries(response.headers.entries()) };
      } finally { clearTimeout(timer); }
    },
    async stream(url, headers, timeoutMs, onEvent, signal) {
      const controller = new AbortController();
      if (signal) { if (signal.aborted) controller.abort(); else signal.addEventListener('abort', () => controller.abort(), { once: true }); }
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(url, { headers, signal: controller.signal });
        if (!response.ok || !response.body) { const detail = await response.text().catch(() => ''); throw new Error(`QQ events HTTP ${response.status}: ${detail.slice(0, 4096)}`); }
        const reader = response.body.getReader(); let buffer = '';
        while (true) { const { done, value } = await reader.read(); if (done) break; buffer += new TextDecoder().decode(value); const parts = buffer.split(/\n\n+/); buffer = parts.pop() ?? ''; for (const event of sseLines(parts.join('\n\n'))) { if (await onEvent(event)) { await reader.cancel().catch(() => {}); return; } } }
      } finally { clearTimeout(timer); }
    },
  };
}

export function approvalDecision(event, workspace) {
  const call = eventValue(event)?.tool_call;
  const command = typeof eventValue(event)?.shell?.command === 'string' ? eventValue(event).shell.command : '';
  const deny = (basis, args = {}) => ({ decision: { type: 'deny' }, basis, call, args, command });
  if (!call || !['exec', 'edit_file', 'write_file'].includes(call.name)) return deny('unsupported-tool');
  let args = {};
  try { args = call.arguments ? (typeof call.arguments === 'string' ? JSON.parse(call.arguments) : call.arguments) : {}; } catch { return deny('malformed-tool-arguments'); }
  const root = resolve(workspace);
  const inside = (value) => {
    if (typeof value !== 'string' || value.startsWith('/') || value.includes('\\0')) return false;
    const candidate = resolve(root, value || '.');
    return candidate === root || candidate.startsWith(`${root}/`);
  };
  const unquotedOperator = (value) => {
    let quote = null; let escaped = false;
    for (const char of value) {
      if (escaped) { escaped = false; continue; }
      if (char === '\\' && quote !== "'") { escaped = true; continue; }
      if (quote) { if (char === quote) quote = null; continue; }
      if (char === "'" || char === '"') { quote = char; continue; }
      if ('|;&<>'.includes(char)) return true;
    }
    return Boolean(quote || escaped);
  };
  const argv = Array.isArray(args.args) ? args.args : [];
  const program = args.program ?? args.command;
  const code = argv[argv.indexOf('-e') + 1] ?? '';
  const localCode = typeof code === 'string' && !/(?:child_process|process\.env|fetch\s*\(|https?:|writeFile|unlink|rm\s)/i.test(code) && !/(?:from|import)\s*['"]\//i.test(code);
  const testFiles = argv.filter((arg) => typeof arg === 'string' && !arg.startsWith('-'));
  const nodeTest = program === 'node' && argv.includes('--test') && testFiles.length > 0 && testFiles.every(inside);
  const nodeAssertion = program === 'node' && argv.includes('--input-type=module') && argv.includes('-e') && localCode;
  const safeExec = call.name === 'exec' && inside(args.cwd ?? '.') && !unquotedOperator(command) && (nodeTest || nodeAssertion);
  const safeFile = ['edit_file', 'write_file'].includes(call.name) && inside(args.path);
  const safe = safeExec || safeFile;
  return { decision: { type: safe ? 'approve_once' : 'deny' }, basis: safe ? 'owned-workspace-node-study-allowlist' : 'outside-owned-node-study-allowlist', call, args, command };
}

/** Run one QQ trial. Provider submission is deliberately gated by authorizeProvider. */
export async function runTrial(options = {}) {
  const { workspace, prompt, followups = [], arm, outputDir, pluginRoot = null, runId = randomUUID(), model = DEFAULT_MODEL, effort = DEFAULT_EFFORT, timeoutMs = 15 * 60_000, approvalMode = 'auto', authorizeProvider = false, discoveryPath = DISCOVERY, transport: suppliedTransport } = options;
  const callerSignal = options.signal;
  if (callerSignal?.aborted) throw new Error('QQ trial aborted before start');
  if (!workspace || !prompt || !outputDir || !['off', 'on'].includes(arm)) throw new TypeError('workspace, prompt, arm, and outputDir are required');
  if (followups.length) throw new TypeError('QQ adapter does not yet support native continuation; followups must be empty');
  if (arm === 'on' && !pluginRoot) throw new TypeError('pluginRoot is required for the on arm');
  const runRoot = resolve(outputDir, safeName(runId)); await mkdir(runRoot, { recursive: true, mode: 0o700 });
  const eventsPath = join(runRoot, 'events.json'); const receiptPath = join(runRoot, 'receipt.json');
  const started = performance.now();
  const deadline = started + timeoutMs;
  const remaining = () => Math.max(1, deadline - performance.now());
  const deadlineController = new AbortController();
  const deadlineTimer = setTimeout(() => deadlineController.abort(), timeoutMs);
  if (callerSignal) callerSignal.addEventListener('abort', () => deadlineController.abort(), { once: true });
  let discovery; let events = []; let approvals = []; let sessionId = null; let workspaceId = null; let ownedRunId = null; let cancelOwnedRun = null; let waitOwnedRun = null; let terminalObserved = false; let resolvedModel = null; let resolvedEffort = null; let setupError = null;
  try {
    discovery = parseDiscovery(await readFile(discoveryPath, 'utf8'));
    const transport = suppliedTransport ?? await defaultTransport();
    const headers = jsonHeaders(discovery.token);
    const request = (route, body) => { const left = remaining(); if (left <= 0) throw new Error('QQ trial deadline exceeded'); return transport.request('POST', `${discovery.address}${route}`, body, headers, left, deadlineController.signal); };
    cancelOwnedRun = async () => {
      if (!ownedRunId) return null;
      // Cancellation is cleanup, so it must remain possible after the trial
      // deadline signal aborts the main request stream.
      return transport.request('POST', `${discovery.address}/v1/runs/cancel`, requestFor({ type: 'cancel_run', run_id: ownedRunId }), headers, 2_000);
    };
    const handleEvent = async (event) => {
      events.push(event);
      const body = eventValue(event);
      if (body?.type === 'tool_approval_requested' && (event?.run_id ?? body?.run_id) === ownedRunId) {
        const plan = approvalDecision(event, resolve(workspace));
        if (plan) {
          const response = await request(ROUTES.toolApproval, requestFor({ type: 'respond_tool_approval', run_id: ownedRunId, tool_call_id: plan.call?.id, decision: plan.decision }));
          approvals.push({ toolCallId: plan.call?.id ?? null, tool: plan.call?.name ?? null, decision: plan.decision.type, basis: plan.basis, command: plan.command || null, outcome: response.body?.outcome?.type ?? null });
        }
      }
      const done = body?.type === 'run_finished' && (event?.run_id ?? body?.run_id) === ownedRunId;
      if (done) terminalObserved = true;
      return done;
    };
    // The capabilities schema is workspace-scoped for profiles. Probe the
    // protocol first, resolve the disposable workspace, then read the actual
    // profile summaries that this server will apply to the session.
    const health = await request('/v1/capabilities', {});
    const resolved = await request(ROUTES.resolve, requestFor({ type: 'resolve_workspace', path: resolve(workspace) }));
    workspaceId = resolved.body?.outcome?.workspace_id ?? resolved.body?.workspace_id ?? resolved.body?.workspaceId;
    if (!workspaceId) throw new Error('QQ workspace resolution did not return a workspace id');
    const capabilitiesResponse = await request('/v1/capabilities', { workspace_id: workspaceId });
    const capabilities = capabilitiesResponse.body ?? {};
    const profile = arm === 'on' ? 'jev' : 'default';
    const selected = profileSummary(capabilities, profile);
    if (arm === 'on' && !selected) throw new Error('QQ on-arm treatment unavailable: trusted jev profile is not advertised by capabilities');
    // Routing must remain off for both arms. Newer servers expose this in the
    // capability document; when absent we retain the profile as the source of
    // truth and record the limitation in the receipt rather than guessing.
    if (arm === 'on' && (capabilities.jev_routing === true || capabilities.jevRouting === true || capabilities.routing === 'on')) throw new Error('QQ on-arm treatment unavailable: routing is enabled');
    if (!selected && profile === 'default' && capabilities.profiles && !profileSummary(capabilities, 'default')) throw new Error('QQ default profile is not advertised by capabilities');
    const create = await request(ROUTES.create, requestFor({ type: 'create_session', workspace_id: workspaceId, parent_id: null, model: modelSelection(model), approval_mode: approvalMode, profile, reasoning_effort: effort, correlation: {} }));
    sessionId = create.body?.outcome?.session_id ?? create.body?.session_id ?? create.body?.sessionId;
    if (!sessionId) throw new Error('QQ session creation did not return a session id');
    resolvedModel = create.body?.outcome?.model ?? create.body?.model ?? null;
    resolvedEffort = create.body?.outcome?.reasoning_effort ?? create.body?.reasoning_effort ?? null;
    const readback = await request(ROUTES.snapshot, { workspace_id: workspaceId, focused_session_id: sessionId, include_sessions: [], session_limit: 1, message_limit: 1 });
    const sessionReadback = readback.body?.focused ?? readback.body?.included?.find((item) => item?.session_id === sessionId) ?? null;
    resolvedModel = sessionReadback?.model ?? resolvedModel;
    resolvedEffort = sessionReadback?.reasoning_effort ?? resolvedEffort;
    const configuration = { arm, profile, modelRequested: model, effortRequested: effort, approvalMode, routingDisabled: true, routingEvidence: capabilities.jev_routing !== undefined || capabilities.jevRouting !== undefined || capabilities.routing !== undefined ? 'capabilities' : 'server-capabilities-did-not-expose-routing', reviewEvidence: arm === 'on' ? 'trusted-profile-advertised; review-mode detail is server-owned' : 'default-profile', serverVersion: discovery.version, protocolVersion: discovery.protocolVersion, treatment: arm === 'on' ? 'native-checkpoint-review' : 'no-jev', treatmentEvidence: selected ? 'capabilities-profile' : 'default-profile', pluginRoot: arm === 'on' ? resolve(pluginRoot) : null, workspace: resolve(workspace) };
    if (!authorizeProvider) {
      clearTimeout(deadlineTimer);
  const receipt = { runId, arm, exitCode: null, completion: 'not_started', requestedModel: model, resolvedModel, requestedEffort: effort, resolvedEffort, usage: usageFrom(null), cost: { reportedUsd: null, estimatedUsd: null, billedUsd: null, attribution: 'unavailable' }, wallMs: Math.round(performance.now() - started), sessionId, workspaceId, jev: { enabled: arm === 'on', attempts: 0, responses: 0, validatedResponses: 0, abstentions: 0, requestIds: [], observerOnly: false, requestIdEvidence: 'not-started', contacted: arm === 'on' ? null : false, providerContacted: arm === 'on' ? null : false, adviceDeliveries: 0 }, configuration, isolation: { cwd: resolve(workspace), privateReceipt: receiptPath, sameApprovalModeAcrossArms: true }, error: 'provider execution requires explicit authorizeProvider:true' };
      await atomicJson(eventsPath, events); await atomicJson(receiptPath, receipt); clearTimeout(deadlineTimer); return receipt;
    }
    const submit = async (text) => {
      if (callerSignal?.aborted) throw new Error('QQ trial aborted before prompt submission');
      return request(ROUTES.prompt, requestFor({ type: 'submit_prompt', session_id: sessionId, input: [{ type: 'text', text }], limits: {}, correlation: {}, output: null }));
    };
    const first = await submit(prompt); const runIdFromServer = first.body?.outcome?.run_id ?? first.body?.run_id; ownedRunId = runIdFromServer;
    waitOwnedRun = async (afterCursor) => {
      const cursor = cursorString(afterCursor) ?? '0';
      await transport.stream(`${discovery.address}/v1/workspaces/${encodeURIComponent(workspaceId)}/events`, { ...headers, 'last-event-id': cursor }, 2_000, handleEvent);
    };
    const cursor = cursorString(first.body?.committed_through) ?? '0';
    await transport.stream(`${discovery.address}/v1/workspaces/${encodeURIComponent(workspaceId)}/events`, { ...headers, 'last-event-id': String(cursor) }, remaining(), handleEvent, deadlineController.signal);
    const finish = events.slice().reverse().find((entry) => eventValue(entry)?.type === 'run_finished' && (!runIdFromServer || (entry?.run_id ?? eventValue(entry)?.run_id) === runIdFromServer)) ?? null; const event = eventValue(finish); const usage = usageFrom(event?.usage); const estimated = costFrom(event?.usage ?? event); const outcomeType = typeof event?.outcome === 'string' ? event.outcome : event?.outcome?.type; const success = Boolean(finish && outcomeType === 'completed');
    resolvedModel = event?.session?.model ?? resolvedModel; resolvedEffort = event?.session?.reasoning_effort ?? resolvedEffort;
    const receipt = { runId, arm, exitCode: success ? 0 : 1, completion: success, requestedModel: model, resolvedModel, requestedEffort: effort, resolvedEffort, usage, cost: { reportedUsd: null, estimatedUsd: estimated, billedUsd: null, attribution: estimated == null ? 'unavailable' : 'qq-reported-estimate' }, wallMs: Math.round(performance.now() - started), sessionId, workspaceId, serverRunId: runIdFromServer ?? null, jev: jevReceipt(events, runIdFromServer, arm), configuration, isolation: { cwd: resolve(workspace), privateReceipt: receiptPath, sameApprovalModeAcrossArms: true }, raw: { eventsPath }, approvals, error: success ? null : 'QQ run did not produce a successful terminal event' };
    await atomicJson(eventsPath, events); await atomicJson(receiptPath, receipt); clearTimeout(deadlineTimer); return receipt;
  } catch (error) {
    setupError = error;
    if (cancelOwnedRun && ownedRunId) {
      try { const cancelled = await cancelOwnedRun(); if (waitOwnedRun) await waitOwnedRun(cancelled?.body?.committed_through); } catch { /* preserve the original run failure and cleanupRequired evidence */ }
    }
  }
  clearTimeout(deadlineTimer);
  const receipt = { runId, arm, exitCode: null, completion: false, requestedModel: model, resolvedModel, requestedEffort: effort, resolvedEffort, usage: usageFrom(null), cost: { reportedUsd: null, estimatedUsd: null, billedUsd: null, attribution: 'unavailable' }, wallMs: Math.round(performance.now() - started), sessionId, workspaceId, jev: { enabled: arm === 'on', attempts: 0, responses: 0, validatedResponses: 0, abstentions: 0, requestIds: [], observerOnly: false, requestIdEvidence: 'not-started', contacted: arm === 'on' ? null : false, providerContacted: arm === 'on' ? null : false, adviceDeliveries: 0 }, configuration: { arm, profile: arm === 'on' ? 'jev' : 'default', modelRequested: model, effortRequested: effort, approvalMode, routingDisabled: true, workspace: resolve(workspace), pluginRoot: arm === 'on' ? resolve(pluginRoot) : null }, isolation: { cwd: resolve(workspace), privateReceipt: receiptPath, sameApprovalModeAcrossArms: true, cleanupRequired: Boolean(ownedRunId && !terminalObserved) }, error: setupError?.message ?? 'QQ setup failed' };
  await atomicJson(eventsPath, events); await atomicJson(receiptPath, receipt); return receipt;
}

export const defaults = { model: DEFAULT_MODEL, effort: DEFAULT_EFFORT, discoveryPath: DISCOVERY };
