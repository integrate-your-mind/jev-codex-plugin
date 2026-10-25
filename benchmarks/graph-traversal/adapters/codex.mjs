import { spawn as nodeSpawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, symlink, rm, writeFile, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';

const DEFAULT_CODEX = '/opt/homebrew/bin/codex';
const DEFAULT_MODEL = 'gpt-6-astra';
const DEFAULT_EFFORT = 'high';
const ARMS = new Set(['graph', 'cheap', 'jev']);
const safeName = value => String(value ?? 'trial').replace(/[^a-zA-Z0-9._-]/g, '_');
const toml = value => JSON.stringify(String(value));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const emptyUsage = () => ({ inputTokens: null, cachedInputTokens: null, outputTokens: null, reasoningTokens: null });

export function buildLaunch({ arm, model, effort, workspace, lastMessagePath, serverPath, graphRoot, graphState, jevState, objective, authorizeProvider = false, jevApiKeyFile = null }) {
  if (!ARMS.has(arm)) throw new TypeError('arm must be graph, cheap, or jev');
  const env = {
    PROJECT_GRAPH_ROOT: graphRoot,
    PROJECT_GRAPH_STATE: graphState,
    PROJECT_GRAPH_ARM: arm,
    PROJECT_GRAPH_OBJECTIVE: objective,
    JEV_STATE_DIRECTORY: jevState ?? graphState,
  };
  if (arm === 'jev' && authorizeProvider && jevApiKeyFile) env.JEV_API_KEY_FILE = resolve(jevApiKeyFile);
  const mcpEnv = `{${Object.entries(env).map(([key, value]) => `${JSON.stringify(key)} = ${toml(value)}`).join(', ')}}`;
  return [
    'exec', '--json', '--color', 'never', '--ignore-user-config', '--ignore-rules', '--strict-config',
    '--skip-git-repo-check', '--model', model, '--sandbox', 'workspace-write', '--cd', resolve(workspace),
    '-c', `model_reasoning_effort=${toml(effort)}`,
    '-c', 'approval_policy="never"',
    '-c', 'sandbox_workspace_write.network_access=false',
    '-c', 'shell_environment_policy.inherit="none"',
    '-c', 'shell_environment_policy.include_only=["PATH","USER","LOGNAME","SHELL","LANG","LC_ALL","TERM"]',
    '-c', 'features.hooks=false', '-c', 'features.plugin_hooks=false', '-c', 'features.plugins=false',
    '-c', `mcp_servers.project_graph.command=${toml(process.execPath)}`,
    '-c', `mcp_servers.project_graph.args=[${toml(serverPath)}]`,
    '-c', `mcp_servers.project_graph.env=${mcpEnv}`,
    '--output-last-message', lastMessagePath, '-',
  ];
}

function groupAlive(child) {
  if (!child?.pid) return false;
  if (process.platform === 'win32') return null;
  try { process.kill(-child.pid, 0); return true; }
  catch (error) { return error?.code === 'ESRCH' ? false : null; }
}

function killGroup(child, signal) {
  if (!child?.pid) return;
  try {
    if (process.platform === 'win32') child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error;
  }
}

async function settleGroup(child, graceMs) {
  let alive = groupAlive(child);
  if (alive === false) return false;
  try {
    killGroup(child, 'SIGTERM');
    await sleep(graceMs);
    alive = groupAlive(child);
    if (alive === false) return false;
    killGroup(child, 'SIGKILL');
    await sleep(graceMs);
    return groupAlive(child) !== false;
  } catch { return true; }
}

export async function runChild({ spawnFn = nodeSpawn, codexPath, args, env, cwd, input, timeoutMs, graceMs, signal }) {
  let child;
  try { child = spawnFn(codexPath, args, { cwd, env, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] }); }
  catch (spawnError) { return { stdout: '', stderr: '', timedOut: false, aborted: false, spawnError, closeResult: null, cleanupRequired: false }; }
  let stdout = '', stderr = '', timedOut = false, aborted = false, spawnError = null, closeResult = null;
  let timer, escalation, watchdog, stop;
  child.stdout?.setEncoding?.('utf8');
  child.stderr?.setEncoding?.('utf8');
  child.stdout?.on('data', chunk => { stdout += chunk; });
  child.stderr?.on('data', chunk => { stderr += chunk; });
  child.stdin?.on('error', () => {});
  try {
    await new Promise(resolveExit => {
      let settled = false;
      const finish = (code, exitSignal) => {
        if (settled) return;
        settled = true;
        closeResult = { code, signal: exitSignal };
        resolveExit();
      };
      stop = reason => {
        if (reason === 'timeout') timedOut = true;
        else aborted = true;
        if (escalation || watchdog) return;
        try { killGroup(child, 'SIGTERM'); } catch (error) { spawnError ??= error; }
        escalation = setTimeout(() => { try { killGroup(child, 'SIGKILL'); } catch (error) { spawnError ??= error; } }, graceMs);
        watchdog = setTimeout(() => finish(null, null), graceMs * 2 + 250);
      };
      child.once('error', error => { spawnError = error; finish(null, null); });
      child.once('exit', finish);
      child.once('close', finish);
      timer = setTimeout(() => stop('timeout'), timeoutMs);
      if (signal?.aborted) stop('abort');
      else signal?.addEventListener('abort', onAbort, { once: true });
      child.stdin?.end(input);
    });
  } finally {
    clearTimeout(timer);
    clearTimeout(escalation);
    clearTimeout(watchdog);
    signal?.removeEventListener('abort', onAbort);
  }
  const cleanupRequired = await settleGroup(child, graceMs);
  await new Promise(resolve => setImmediate(resolve));
  return { stdout, stderr, timedOut, aborted, spawnError, closeResult, cleanupRequired };
  function onAbort() { stop('abort'); }
}

function parseEvents(stdout) {
  const events = [];
  let malformed = 0;
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      if (!event || typeof event !== 'object' || Array.isArray(event)) malformed++;
      else events.push(event);
    } catch { malformed++; }
  }
  return { events, malformed };
}

const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;

export function extractNativeEvents(events) {
  const items = new Map();
  const usage = emptyUsage();
  for (const event of events) {
    if (/^item\.(started|updated|completed)$/.test(event.type) && typeof event.item?.id === 'string') items.set(event.item.id, { ...items.get(event.item.id), ...event.item });
    if (event.type === 'turn.completed') {
      for (const [key, nativeKey] of Object.entries({ inputTokens: 'input_tokens', cachedInputTokens: 'cached_input_tokens', outputTokens: 'output_tokens', reasoningTokens: 'reasoning_output_tokens' })) {
        const value = event.usage?.[nativeKey];
        if (Number.isSafeInteger(value) && value >= 0) usage[key] = value;
      }
    }
  }
  const actions = [...items.values()].filter(item => item.type === 'mcp_tool_call' || item.type === 'command_execution');
  const seen = new Set();
  let repeatedActions = 0;
  for (const action of actions) {
    const signature = JSON.stringify(canonical(action.type === 'mcp_tool_call' ? [action.server, action.tool, action.arguments] : [action.command]));
    if (seen.has(signature)) repeatedActions++;
    seen.add(signature);
  }
  const graphCalls = actions.filter(item => item.type === 'mcp_tool_call' && item.server === 'project_graph' && item.tool === 'project_graph').map(item => ({
    id: item.id, server: item.server, tool: item.tool, operation: item.arguments?.operation ?? null,
    arguments: item.arguments ?? null, result: item.result ?? null, error: item.error ?? null, status: item.status ?? null,
  }));
  return {
    threadId: events.find(event => event.type === 'thread.started')?.thread_id ?? null,
    usage, graphCalls, actions, repeatedActions,
    terminal: [...events].reverse().find(event => event.type === 'turn.completed' || event.type === 'turn.failed') ?? null,
  };
}

async function inspectSession(codexHome, threadId, workspace) {
  const paths = [];
  let truncated = false;
  async function visit(dir, depth) {
    if (depth > 6) { truncated = true; return; }
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (paths.length >= 40) { truncated = true; return; }
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await visit(path, depth + 1);
      else if (entry.isFile() && path.endsWith('.jsonl')) paths.push(path);
    }
  }
  await visit(join(codexHome, 'sessions'), 0);
  const matches = [];
  for (const path of paths) {
    const parsed = parseEvents(await readFile(path, 'utf8'));
    if (threadId && parsed.events.some(record => record.type === 'session_meta' && record.payload?.id === threadId)) matches.push({ path, ...parsed });
  }
  const selected = matches.length === 1 ? matches[0] : null;
  const contexts = selected?.events.filter(record => record.type === 'turn_context').map(record => record.payload) ?? [];
  const turns = contexts.filter(turn => turn?.cwd === workspace && typeof turn.model === 'string' && typeof turn.effort === 'string');
  const nativeEvents = selected?.events.filter(record => record.type === 'event_msg').map(record => record.payload) ?? [];
  const modelReroutes = nativeEvents.filter(event => event?.type === 'model_reroute');
  const approvalTypes = new Set(['exec_approval_request', 'apply_patch_approval_request', 'request_permissions', 'elicitation_request']);
  return {
    sessionId: selected ? threadId : null,
    turn: turns.length === 1 && contexts.length === 1 && !modelReroutes.length ? { model: turns[0].model, effort: turns[0].effort, cwd: turns[0].cwd } : null,
    path: selected?.path ?? null, filesRead: paths.length, inventoryTruncated: truncated,
    malformed: selected?.malformed ?? null, matchingSessions: matches.length, modelReroutes,
    observedApprovalRequests: nativeEvents.filter(event => approvalTypes.has(event?.type)).length,
    observedInterruptions: nativeEvents.filter(event => event?.type === 'turn_aborted').length,
  };
}

export async function runTrial(options = {}) {
  const { workspace, prompt, followups = [], arm, model = DEFAULT_MODEL, effort = DEFAULT_EFFORT, timeoutMs = 480_000, outputDir, serverPath, signal, authorizeProvider = false, jevApiKeyFile = null, runId = randomUUID(), codexPath = DEFAULT_CODEX, sourceCodexHome = process.env.CODEX_HOME ?? join(homedir(), '.codex'), spawnFn = nodeSpawn, graceMs = 2_000 } = options;
  if (!workspace || !prompt || !outputDir || !serverPath || !ARMS.has(arm)) throw new TypeError('workspace, prompt, outputDir, serverPath, and valid arm are required');
  if (followups.length) throw new TypeError('followups require native continuation support');
  if (![timeoutMs, graceMs].every(value => Number.isSafeInteger(value) && value > 0)) throw new TypeError('timeoutMs and graceMs must be positive integers');
  const root = resolve(outputDir, safeName(runId));
  await mkdir(root, { recursive: true, mode: 0o700 });
  const codexHome = join(root, 'codex-home'), graphState = join(root, 'graph'), jevState = join(root, 'jev');
  const raw = { stdoutPath: join(root, 'stdout.ndjson'), stderrPath: join(root, 'stderr.log'), eventsPath: join(root, 'events.json'), lastMessagePath: join(root, 'last-message.txt') };
  const receipt = {
    runId, arm, requestedModel: model, resolvedModel: null, requestedEffort: effort, resolvedEffort: null,
    completion: authorizeProvider ? false : 'not_started', comparisonEligible: false, exitCode: null, signal: null,
    timeout: false, aborted: false, cleanupRequired: false, wallMs: 0, usage: emptyUsage(),
    humanApprovalRequests: null, humanInterruptions: null, repeatedActions: null,
    cost: { reportedUsd: null, estimatedUsd: null, billedUsd: null, attribution: 'unavailable' },
    graph: { calls: [], serverPath: resolve(serverPath), arm }, graphStateDir: graphState, jevStateDir: jevState, raw,
    isolation: { privateCodexHome: codexHome, authMode: 'symlink_to_existing_codex_auth', hooksDisabled: true, modelEvidence: null },
    error: authorizeProvider ? null : 'provider execution requires explicit authorizeProvider:true',
  };
  const started = performance.now();
  let authLink = false;
  try {
    if (authorizeProvider) {
      await mkdir(codexHome, { mode: 0o700 });
      await mkdir(graphState, { mode: 0o700 });
      await mkdir(jevState, { mode: 0o700 });
      const authPath = resolve(sourceCodexHome, 'auth.json');
      if (!(await lstat(authPath)).isFile()) throw new Error('Codex auth source must be a regular file');
      await symlink(authPath, join(codexHome, 'auth.json'));
      authLink = true;
      const env = { PATH: process.env.PATH ?? '/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin', HOME: process.env.HOME ?? homedir(), USER: process.env.USER ?? '', LANG: process.env.LANG ?? 'C.UTF-8', CODEX_HOME: codexHome };
      const args = buildLaunch({ arm, model, effort, workspace, lastMessagePath: raw.lastMessagePath, serverPath: resolve(serverPath), graphRoot: resolve(workspace), graphState, jevState, objective: String(prompt), authorizeProvider, jevApiKeyFile });
      const result = await runChild({ spawnFn, codexPath, args, env, cwd: resolve(workspace), input: String(prompt), timeoutMs, graceMs, signal });
      await writeFile(raw.stdoutPath, result.stdout, { mode: 0o600 });
      await writeFile(raw.stderrPath, result.stderr, { mode: 0o600 });
      const parsed = parseEvents(result.stdout);
      await writeFile(raw.eventsPath, `${JSON.stringify(parsed.events, null, 2)}\n`, { mode: 0o600 });
      const info = extractNativeEvents(parsed.events);
      const session = await inspectSession(codexHome, info.threadId, resolve(workspace));
      const nativeOk = info.terminal?.type === 'turn.completed' && result.closeResult?.code === 0 && !result.timedOut && !result.aborted && !result.cleanupRequired && !result.spawnError;
      Object.assign(receipt, {
        resolvedModel: session.turn?.model ?? null, resolvedEffort: session.turn?.effort ?? null,
        completion: Boolean(nativeOk && session.turn?.model === model && session.turn?.effort === effort),
        exitCode: result.closeResult?.code ?? null, signal: result.closeResult?.signal ?? null,
        timeout: result.timedOut, aborted: result.aborted, cleanupRequired: result.cleanupRequired, usage: info.usage,
        repeatedActions: parsed.malformed === 0 && info.terminal ? info.repeatedActions : null,
        error: result.spawnError?.message ?? (parsed.malformed ? 'malformed Codex JSON events' : null),
      });
      receipt.comparisonEligible = receipt.completion && parsed.malformed === 0 && session.malformed === 0 && !session.inventoryTruncated;
      receipt.graph.calls = info.graphCalls;
      receipt.isolation.modelEvidence = session;
      receipt.observedApprovalRequests = session.observedApprovalRequests;
      receipt.observedInterruptions = session.observedInterruptions;
    }
  } catch (error) {
    receipt.error = String(error?.message ?? error).slice(0, 2000);
    receipt.completion = false;
  } finally {
    if (authLink) {
      try { await rm(join(codexHome, 'auth.json')); }
      catch (error) { receipt.cleanupError = String(error?.message ?? error); receipt.completion = false; receipt.comparisonEligible = false; }
    }
  }
  receipt.wallMs = Math.round(performance.now() - started);
  await writeFile(join(root, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  return receipt;
}

export const defaults = { codexPath: DEFAULT_CODEX, model: DEFAULT_MODEL, effort: DEFAULT_EFFORT };
