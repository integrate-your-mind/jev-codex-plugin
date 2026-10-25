import { mkdir, writeFile, readdir, readFile, cp } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { spawn as nodeSpawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { homedir } from 'node:os';

const DEFAULT_CLAUDE = '/opt/homebrew/bin/claude';
const DEFAULT_MODEL = 'claude-opus-5-5[1m]';
const DEFAULT_EFFORT = 'high';
const TASK_TOOLS = [
  'Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash(node:*)',
  'mcp__plugin_jev-workflows_jev-workflows__*', 'mcp__jev-workflows__*',
];
const SECRET_ENV_KEYS = ['TYPESAFE_API_KEY', 'JEV_API_KEY', 'OPENAI_API_KEY', 'CODEX_API_KEY', 'ANTHROPIC_API_KEY'];

const STRUCTURED_SCHEMA = JSON.stringify({
  type: 'object',
  additionalProperties: true,
});

function safeName(value) {
  return String(value ?? 'trial').replace(/[^a-zA-Z0-9._-]/g, '_');
}

function eventModel(event) {
  return event?.model ?? event?.modelUsage?.model ?? event?.message?.model ?? null;
}

function collectUsage(events) {
  const usage = { inputTokens: null, cachedInputTokens: null, cacheCreationTokens: null, outputTokens: null, reasoningTokens: null };
  let cost = null;
  for (const event of events) {
    const candidates = [event?.usage, event?.message?.usage, event?.result?.usage, event?.modelUsage];
    for (const item of candidates) {
      if (!item || typeof item !== 'object') continue;
      if (Number.isFinite(item.input_tokens)) usage.inputTokens = item.input_tokens;
      if (Number.isFinite(item.inputTokens)) usage.inputTokens = item.inputTokens;
      if (Number.isFinite(item.cache_read_input_tokens)) usage.cachedInputTokens = item.cache_read_input_tokens;
      if (Number.isFinite(item.cachedInputTokens)) usage.cachedInputTokens = item.cachedInputTokens;
      if (Number.isFinite(item.cache_creation_input_tokens)) usage.cacheCreationTokens = item.cache_creation_input_tokens;
      if (Number.isFinite(item.cacheCreationTokens)) usage.cacheCreationTokens = item.cacheCreationTokens;
      if (Number.isFinite(item.output_tokens)) usage.outputTokens = item.output_tokens;
      if (Number.isFinite(item.outputTokens)) usage.outputTokens = item.outputTokens;
      if (Number.isFinite(item.reasoning_tokens)) usage.reasoningTokens = item.reasoning_tokens;
      if (Number.isFinite(item.reasoningTokens)) usage.reasoningTokens = item.reasoningTokens;
    }
    if (Number.isFinite(event?.total_cost_usd)) cost = event.total_cost_usd;
    if (Number.isFinite(event?.cost_usd)) cost = event.cost_usd;
    if (Number.isFinite(event?.result?.total_cost_usd)) cost = event.result.total_cost_usd;
  }
  return { usage, cost };
}

export async function readJevAccounting(directory, events = []) {
  const result = { attempts: 0, responses: 0, validatedResponses: 0, abstentions: 0, requestIds: [], receipts: 0, fetchInvoked: 0, deliveryReceipts: 0, adviceDeliveries: 0, usage: { inputTokens: null, cachedInputTokens: null, cacheCreationTokens: null, outputTokens: null }, latenciesMs: [] };
  const requestIds = new Set();
  const deliveryIds = new Set();
  const providerReceiptIds = new Set();
  const validatedReceiptIds = new Set();
  const abstentionReceiptIds = new Set();
  const adviceDeliveryIds = new Set();
  async function visit(path) {
    let entries;
    try { entries = await readdir(path, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) await visit(child);
      else if (entry.isFile() && entry.name.endsWith('.json')) {
        try {
          const value = JSON.parse(await readFile(child, 'utf8'));
          if (path.includes(`${join('decision-hook-v1', '')}`) && path.includes('invocations')) result.attempts++;
          if (value.receiptId || value.status) result.receipts++;
          const status = value.status ?? value.assessmentStatus;
          if (value.transport?.fetchInvoked === true && typeof value.receiptId === 'string' && !providerReceiptIds.has(value.receiptId)) {
            providerReceiptIds.add(value.receiptId);
            result.fetchInvoked++;
            if (status === 'abstained') abstentionReceiptIds.add(value.receiptId);
            if (value.transport?.validatedResponse === true) validatedReceiptIds.add(value.receiptId);
            if (Number.isFinite(value.usage?.input_tokens)) result.usage.inputTokens = (result.usage.inputTokens ?? 0) + value.usage.input_tokens;
            if (Number.isFinite(value.usage?.output_tokens)) result.usage.outputTokens = (result.usage.outputTokens ?? 0) + value.usage.output_tokens;
            if (Number.isFinite(value.usage?.cache_read_input_tokens)) result.usage.cachedInputTokens = (result.usage.cachedInputTokens ?? 0) + value.usage.cache_read_input_tokens;
            if (Number.isFinite(value.usage?.cache_creation_input_tokens)) result.usage.cacheCreationTokens = (result.usage.cacheCreationTokens ?? 0) + value.usage.cache_creation_input_tokens;
            if (Number.isFinite(value.latencyMs)) result.latenciesMs.push(value.latencyMs);
          }
          const id = value.transport?.providerRequestId ?? value.transport?.requestId ?? value.transport?.provider?.requestId ?? value.providerRequestId ?? value.requestId;
          if (typeof id === 'string' && id) requestIds.add(id);
        } catch { /* bounded local accounting is best effort */ }
      }
    }
  }
  await visit(directory);
  for (const event of events) {
    const text = [event?.output, event?.stdout, event?.content].filter((value) => typeof value === 'string').join('\n');
    for (const match of text.matchAll(/receipt=([a-f0-9-]{36})/gi)) deliveryIds.add(match[1]);
    for (const match of text.matchAll(/request(?:Id|_id)[=:]\s*([A-Za-z0-9_-]+)/gi)) requestIds.add(match[1]);
    const assessed = /JEV advisory:\s*status=assessed\b/i.test(text);
    if (assessed) for (const id of deliveryIds) adviceDeliveryIds.add(id);
  }
  result.deliveryReceipts = deliveryIds.size;
  result.adviceDeliveries = adviceDeliveryIds.size;
  result.responses = providerReceiptIds.size;
  result.validatedResponses = validatedReceiptIds.size;
  result.abstentions = abstentionReceiptIds.size;
  result.requestIds = [...requestIds];
  return result;
}

function parseEvents(stdout) {
  const events = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { events.push(JSON.parse(line)); } catch { /* preserve malformed raw output */ }
  }
  return events;
}

function pluginIsolation(events, arm) {
  const toolLists = events.map((event) => event.tools).filter(Array.isArray);
  const metadata = events.flatMap((event) => [event.plugins, event.loadedPlugins, event.enabledPlugins].filter((value) => value !== undefined));
  const names = metadata.flatMap((value) => Array.isArray(value) ? value : value && typeof value === 'object' ? Object.keys(value) : [value])
    .filter((value) => typeof value === 'string');
  const foreignMetadata = names.filter((name) => !name.includes('jev-workflows') && !name.startsWith('classify-') && !name.startsWith('diagnose-') && !name.startsWith('check-'));
  if (toolLists.length === 0 && metadata.length === 0) return { status: 'unknown', contaminated: false, observedMcpTools: [], observedMetadata: [] };
  const observedMcpTools = [...new Set(toolLists.flat().filter((tool) => typeof tool === 'string' && tool.startsWith('mcp__')) )];
  const contaminated = foreignMetadata.length > 0 || (arm === 'off'
    ? observedMcpTools.some((tool) => tool.includes('jev-workflows'))
    : observedMcpTools.some((tool) => !tool.startsWith('mcp__plugin_jev-workflows_jev-workflows__') && !tool.startsWith('mcp__jev-workflows__')));
  return { status: contaminated ? 'contaminated' : 'verified', contaminated, observedMcpTools, observedMetadata: names };
}

function killGroup(child, signal) {
  if (!child?.pid) return;
  try {
    if (process.platform === 'win32') child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch (error) {
    if (error?.code !== 'ESRCH') child.kill(signal);
  }
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

async function ambientPluginIds() {
  try {
    const value = JSON.parse(await readFile(join(homedir(), '.claude', 'settings.json'), 'utf8'));
    return Object.keys(value.enabledPlugins ?? {});
  } catch { return []; }
}

function shellQuote(value) { return `'${String(value).replaceAll("'", "'\\''")}'`; }

function removeEnvAssignment(command, name) {
  const quoted = "'(?:[^']|'\\\\'')*'";
  return command.replace(new RegExp(`${name}=(?:${quoted}|[^\\s]+)\\s*`, 'g'), '');
}

export async function stagePlugin(source, destination, stateDir) {
  await cp(resolve(source), destination, { recursive: true, force: false, errorOnExist: true });
  const hooksPath = join(destination, 'hooks', 'hooks.json');
  try {
    const hooks = JSON.parse(await readFile(hooksPath, 'utf8'));
    const assignment = `JEV_STATE_DIRECTORY=${shellQuote(stateDir)}${process.env.JEV_API_KEY_FILE ? ` JEV_API_KEY_FILE=${shellQuote(process.env.JEV_API_KEY_FILE)}` : ''} `;
    for (const groups of Object.values(hooks.hooks ?? {})) for (const group of groups) {
      for (const hook of group.hooks ?? []) if (hook.type === 'command' && typeof hook.command === 'string') {
        const clean = removeEnvAssignment(removeEnvAssignment(hook.command, 'JEV_STATE_DIRECTORY'), 'JEV_API_KEY_FILE');
        hook.command = assignment + clean;
      }
    }
    await writeJson(hooksPath, hooks);
  } catch (error) { if (error?.code !== 'ENOENT') throw error; }
  return destination;
}

/** Run one Claude Code trial. The optional spawnFn is for deterministic adapter tests only. */
export async function runTrial(options) {
  const {
    workspace,
    prompt,
    followups = [],
    arm,
    model = DEFAULT_MODEL,
    effort = DEFAULT_EFFORT,
    timeoutMs = 15 * 60_000,
    outputDir,
    pluginRoot,
    nodePath = process.execPath,
    runId = randomUUID(),
    claudePath = DEFAULT_CLAUDE,
    spawnFn = nodeSpawn,
    stagePluginFn = stagePlugin,
    graceMs = 2_000,
    signal,
  } = options ?? {};

  if (!workspace || !outputDir || !prompt || !['off', 'on'].includes(arm)) {
    throw new TypeError('workspace, prompt, arm, and outputDir are required');
  }
  if (arm === 'on' && !pluginRoot) throw new TypeError('pluginRoot is required for the on arm');
  if (followups.length > 0) throw new TypeError('followups require native continuation support and are not silently concatenated');
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError('timeoutMs must be positive');

  const runRoot = resolve(outputDir, safeName(runId));
  const stateDir = resolve(runRoot, 'jev-state');
  const stagedPluginRoot = arm === 'on' ? resolve(runRoot, 'jev-plugin') : null;
  const settingsPath = join(runRoot, 'settings.json');
  const mcpPath = join(runRoot, 'mcp.json');
  const stdoutPath = join(runRoot, 'stdout.ndjson');
  const stderrPath = join(runRoot, 'stderr.log');
  const eventsPath = join(runRoot, 'events.json');
  await mkdir(runRoot, { recursive: true, mode: 0o700 });

  const ambientIds = await ambientPluginIds();
  const enabledPlugins = Object.fromEntries(ambientIds.map((id) => [id, false]));
  if (arm === 'on') enabledPlugins['jev-workflows@jev-workflows'] = true;
  if (arm === 'on') await stagePluginFn(pluginRoot, stagedPluginRoot, stateDir);
  const args = [
    '--print', '--output-format', 'stream-json', '--verbose', '--include-hook-events',
    '--json-schema', STRUCTURED_SCHEMA,
    '--model', model, '--effort', effort, '--no-session-persistence',
    '--permission-mode', 'dontAsk', '--permission-prompts', 'none',
    '--allowed-tools', ...TASK_TOOLS,
    '--settings', settingsPath, '--setting-sources', '', '--strict-mcp-config', '--mcp-config', mcpPath,
    '--add-dir', resolve(workspace),
  ];
  if (arm === 'on') args.push('--plugin-dir', stagedPluginRoot);

  const settings = {
    permissions: {
      defaultMode: 'dontAsk', allow: TASK_TOOLS,
      deny: ['Task', 'Agent', 'Skill', 'WebFetch', 'WebSearch', 'NotebookEdit'],
    },
    enabledPlugins,
  };
  const policy = {
    enabled: true, scope: 'workspaces', workspaces: [resolve(workspace)],
    maxHookCallsPerSession: null, maxCallsPerDay: null, maxBytesPerDay: null,
  };
  await writeJson(join(stateDir, 'policy.json'), policy);
  const mcp = arm === 'on' ? {
    mcpServers: { 'jev-workflows': {
      type: 'stdio', command: nodePath,
      args: [join(stagedPluginRoot ?? runRoot, 'dist', 'server.mjs')],
      env: { JEV_STATE_DIRECTORY: stateDir, ...(process.env.JEV_API_KEY_FILE ? { JEV_API_KEY_FILE: process.env.JEV_API_KEY_FILE } : {}) },
    } },
  } : { mcpServers: {} };
  await writeJson(settingsPath, settings);
  await writeJson(mcpPath, mcp);

  const input = [prompt, ...followups].join('\n\n');
  const childEnv = { ...process.env };
  delete childEnv.CLAUDE_CONFIG_DIR;
  for (const key of SECRET_ENV_KEYS) delete childEnv[key];
  delete childEnv.JEV_API_KEY_FILE;
  for (const key of Object.keys(childEnv)) if (key.startsWith('JEV_')) delete childEnv[key];
  if (arm === 'on') {
    childEnv.JEV_STATE_DIRECTORY = stateDir;
    childEnv.JEV_ENABLED = '1';
    if (process.env.JEV_API_KEY_FILE) childEnv.JEV_API_KEY_FILE = process.env.JEV_API_KEY_FILE;
  }
  const started = performance.now();
  let stdout = '';
  let stderr = '';
  let timedOut = false;
  let interrupted = false;
  let spawnError = null;
  let closeResult;
  let child;
  try {
    child = spawnFn(claudePath, args, {
      cwd: resolve(workspace), env: childEnv, detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stdout?.setEncoding?.('utf8');
    child.stderr?.setEncoding?.('utf8');
    child.stdout?.on('data', (chunk) => { stdout += chunk; });
    child.stderr?.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => { spawnError = error; });
    child.stdin?.on('error', () => {});
    child.stdin?.end(input);
    closeResult = await new Promise((resolveClose, rejectClose) => {
      const timer = setTimeout(() => {
        timedOut = true;
        killGroup(child, 'SIGTERM');
        setTimeout(() => killGroup(child, 'SIGKILL'), graceMs).unref?.();
      }, timeoutMs);
      const onAbort = () => {
        interrupted = true;
        killGroup(child, 'SIGTERM');
        setTimeout(() => killGroup(child, 'SIGKILL'), graceMs).unref?.();
      };
      if (signal?.aborted) onAbort();
      else signal?.addEventListener('abort', onAbort, { once: true });
      child.once('close', (code, signal) => { clearTimeout(timer); resolveClose({ code, signal }); });
      child.once('error', (error) => { spawnError = error; rejectClose(error); });
    });
  } catch (error) {
    spawnError ??= error;
  }
  const wallMs = Math.round(performance.now() - started);
  await writeFile(stdoutPath, stdout, { mode: 0o600 });
  await writeFile(stderrPath, stderr, { mode: 0o600 });
  const events = parseEvents(stdout);
  await writeJson(eventsPath, events);
  const resolvedModel = events.map(eventModel).find(Boolean) ?? null;
  const resolvedEffort = events.map((event) => event.effort ?? event?.message?.effort ?? null).find(Boolean) ?? null;
  const pluginEvidence = pluginIsolation(events, arm);
  const { usage, cost } = collectUsage(events);
  const resultEvent = [...events].reverse().find((event) => event.type === 'result' || event.result !== undefined);
  const exitCode = closeResult?.code ?? (spawnError ? null : 1);
  const resultIsError = resultEvent?.is_error === true || resultEvent?.result?.is_error === true ||
    (typeof resultEvent?.subtype === 'string' && resultEvent.subtype.startsWith('error'));
  const completion = !timedOut && !interrupted && !spawnError && exitCode === 0 && Boolean(resultEvent) && !resultIsError;
  const requestedFamily = model.match(/(?:^|-)\b(opus|sonnet|haiku)\b/i)?.[1]?.toLowerCase() ?? null;
  const noDowngrade = !resolvedModel || resolvedModel === model ||
    (requestedFamily ? resolvedModel.toLowerCase().includes(requestedFamily) : model.includes(resolvedModel) || resolvedModel.includes(model));
  const jev = arm === 'on' ? await readJevAccounting(stateDir, events) : { attempts: 0, responses: 0, validatedResponses: 0, abstentions: 0, requestIds: [], receipts: 0, fetchInvoked: 0, deliveryReceipts: 0, adviceDeliveries: 0, usage: { inputTokens: null, cachedInputTokens: null, cacheCreationTokens: null, outputTokens: null }, latenciesMs: [] };
  const modelResolution = !resolvedModel ? 'unknown' : noDowngrade ? (resolvedModel === model ? 'exact' : 'alias') : 'mismatch';
  const receipt = {
    runId, arm, requestedModel: model, resolvedModel, requestedEffort: effort, resolvedEffort,
    exitCode, signal: closeResult?.signal ?? null, completion: completion && noDowngrade && modelResolution !== 'unknown' && !pluginEvidence.contaminated,
    modelResolution,
    timeout: timedOut, interrupted, wallMs, sessionId: events.find((event) => event.session_id)?.session_id ?? null,
    usage, cost: { reportedUsd: cost, estimatedUsd: null, billedUsd: null, attribution: cost == null ? 'unavailable' : 'provider_reported' },
    jev: { enabled: arm === 'on', ...jev },
    isolation: { safeMode: false, settingSources: '', pluginRoot: arm === 'on' ? stagedPluginRoot : null, strictMcpConfig: true, pluginEvidence, perRunState: arm === 'on' ? stateDir : null, cwd: resolve(workspace) },
    raw: { stdoutPath, stderrPath, eventsPath },
    error: spawnError?.message ?? (noDowngrade ? null : 'resolved model differs from requested model'),
  };
  await writeJson(join(runRoot, 'receipt.json'), receipt);
  return receipt;
}

export const defaults = { claudePath: DEFAULT_CLAUDE, model: DEFAULT_MODEL, effort: DEFAULT_EFFORT };
