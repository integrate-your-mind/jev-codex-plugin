import { spawn as nodeSpawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, symlink, rm, writeFile, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';

const DEFAULT_CODEX = '/opt/homebrew/bin/codex';
const DEFAULT_MODEL = 'gpt-6-astra';
const DEFAULT_EFFORT = 'high';
const ARMS = new Set(['graph', 'cheap', 'jev']);
const SECRET_KEYS = ['TYPESAFE_API_KEY', 'JEV_API_KEY_FILE', 'OPENAI_API_KEY', 'CODEX_API_KEY', 'ANTHROPIC_API_KEY'];

const hash = value => createHash('sha256').update(value).digest('hex');
const safeName = value => String(value ?? 'trial').replace(/[^a-zA-Z0-9._-]/g, '_');

function toml(value) {
  return JSON.stringify(String(value));
}

function tomlTable(value) {
  return `{${Object.entries(value).map(([key, item]) => `${JSON.stringify(key)} = ${toml(item)}`).join(', ')}}`;
}

export function buildLaunch({ arm, model, effort, workspace, lastMessagePath, serverPath, graphRoot, graphState, jevState, objective, authorizeProvider = false }) {
  if (!ARMS.has(arm)) throw new TypeError('arm must be graph, cheap, or jev');
  const env = {
    PROJECT_GRAPH_ROOT: graphRoot,
    PROJECT_GRAPH_STATE: graphState,
    PROJECT_GRAPH_ARM: arm,
    PROJECT_GRAPH_OBJECTIVE: objective,
    JEV_STATE_DIRECTORY: jevState ?? graphState,
  };
  if (authorizeProvider && process.env.JEV_API_KEY_FILE) env.JEV_API_KEY_FILE = process.env.JEV_API_KEY_FILE;
  const args = [
    'exec', '--json', '--color', 'never', '--ignore-user-config', '--ignore-rules', '--strict-config',
    '--skip-git-repo-check', '--model', model, '--sandbox', 'workspace-write', '--cd', resolve(workspace),
    '-c', `model_reasoning_effort=${toml(effort)}`,
    '-c', 'approval_policy="never"',
    '-c', 'sandbox_workspace_write.network_access=false',
    '-c', 'shell_environment_policy.inherit="none"',
    '-c', 'shell_environment_policy.include_only=["PATH","USER","LOGNAME","SHELL","LANG","LC_ALL","TERM","TMPDIR","TEMP","TMP"]',
    '-c', 'features.plugins=false',
    '-c', `mcp_servers.project_graph.command=${toml(process.execPath)}`,
    '-c', `mcp_servers.project_graph.args=[${toml(serverPath)}]`,
    '-c', `mcp_servers.project_graph.env=${tomlTable(env)}`,
    '--output-last-message', lastMessagePath, '-',
  ];
  return args;
}

function killGroup(child, signal) {
  if (!child?.pid) return;
  try { process.platform === 'win32' ? child.kill(signal) : process.kill(-child.pid, signal); }
  catch (error) { if (error?.code !== 'ESRCH') child.kill(signal); }
}

function groupAlive(child) {
  if (!child?.pid || process.platform === 'win32') return false;
  try { process.kill(-child.pid, 0); return true; } catch (error) { return error?.code !== 'ESRCH'; }
}

async function settleGroup(child, graceMs) {
  if (!groupAlive(child)) return false;
  killGroup(child, 'SIGTERM');
  await new Promise(resolve => setTimeout(resolve, graceMs));
  if (!groupAlive(child)) return false;
  killGroup(child, 'SIGKILL');
  await new Promise(resolve => setTimeout(resolve, Math.min(250, graceMs)));
  return groupAlive(child);
}

async function runChild({ spawnFn, codexPath, args, env, cwd, input, timeoutMs, graceMs, signal }) {
  const child = spawnFn(codexPath, args, { cwd, env, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '', timedOut = false, aborted = false, spawnError = null, closeResult;
  child.stdout?.setEncoding?.('utf8'); child.stderr?.setEncoding?.('utf8');
  child.stdout?.on('data', chunk => { stdout += chunk; }); child.stderr?.on('data', chunk => { stderr += chunk; });
  child.stdin?.on('error', () => {}); let resolveCloseFn;
  child.on('error', error => { spawnError = error; if (!closeResult) { closeResult = { code: null, signal: null }; resolveCloseFn?.(); } });
  child.stdin?.end(input);
  await new Promise(resolveClose => {
    resolveCloseFn = resolveClose;
    const stop = () => { aborted = true; killGroup(child, 'SIGTERM'); setTimeout(() => killGroup(child, 'SIGKILL'), graceMs).unref?.(); };
    const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
    const watchdog = setTimeout(() => { closeResult ??= { code: null, signal: 'SIGKILL' }; resolveClose(); }, timeoutMs + graceMs + 1_000);
    if (signal?.aborted) stop(); else signal?.addEventListener('abort', stop, { once: true });
    child.once('close', (code, closeSignal) => { clearTimeout(timer); clearTimeout(watchdog); signal?.removeEventListener('abort', stop); closeResult = { code, signal: closeSignal }; resolveClose(); });
  });
  const cleanupRequired = await settleGroup(child, graceMs);
  return { stdout, stderr, timedOut, aborted, spawnError, closeResult, cleanupRequired };
}

function parseEvents(stdout) {
  const events = []; let malformed = 0;
  for (const line of stdout.split(/\r?\n/)) { if (!line.trim()) continue; try { events.push(JSON.parse(line)); } catch { malformed++; } }
  return { events, malformed };
}

function extract(events) {
  const model = events.map(e => e.model ?? e.turn?.model ?? e.payload?.model).find(v => typeof v === 'string') ?? null;
  const effort = events.map(e => e.effort ?? e.turn?.effort ?? e.payload?.effort).find(v => typeof v === 'string') ?? null;
  const usage = { inputTokens: null, cachedInputTokens: null, outputTokens: null, reasoningTokens: null };
  for (const e of events) for (const u of [e.usage, e.response?.usage, e.turn?.usage]) if (u) {
    for (const [key, names] of Object.entries({ inputTokens: ['input_tokens', 'inputTokens'], cachedInputTokens: ['cache_read_input_tokens', 'cachedInputTokens'], outputTokens: ['output_tokens', 'outputTokens'], reasoningTokens: ['reasoning_tokens', 'reasoningTokens'] })) for (const name of names) if (Number.isFinite(u[name])) usage[key] = u[name];
  }
  const candidates = events.flatMap(event => event?.type === 'item.completed' && event.item ? [event.item] : [event]);
  const graphCalls = candidates.filter(e => e?.type === 'mcp_tool_call' && (e.server === 'project_graph' || e.server === 'project-graph' || String(e.tool ?? '').includes('project_graph')))
    .map(e => ({ operation: e.arguments?.operation ?? null, arguments: e.arguments ?? null, tool: e.tool ?? null, server: e.server ?? null, id: e.id ?? null }));
  const terminal = [...events].reverse().find(e => /turn\.(?:completed|failed)$/i.test(String(e.type ?? e.event ?? e.name)));
  return { model, effort, usage, graphCalls, terminal };
}

async function inspectSession(codexHome) {
  let files = [];
  async function visit(dir, depth) {
    if (depth > 6 || files.length >= 40) return;
    let entries; try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) { const path = join(dir, entry.name); if (entry.isDirectory()) await visit(path, depth + 1); else if (entry.isFile() && path.endsWith('.jsonl')) files.push(path); }
  }
  await visit(join(codexHome, 'sessions'), 0);
  let sessionId = null; let turn = null;
  for (const path of files) {
    let text; try { text = await readFile(path, 'utf8'); } catch { continue; }
    for (const line of text.split(/\r?\n/)) { try {
      const record = JSON.parse(line);
      if (record?.type === 'session_meta' && typeof record.payload?.id === 'string') sessionId = record.payload.id;
      if (record?.type === 'turn_context' && record.payload && typeof record.payload === 'object') turn = { model: record.payload.model ?? null, effort: record.payload.effort ?? null, cwd: record.payload.cwd ?? null };
    } catch { /* malformed session lines are not native evidence */ } }
  }
  return { sessionId, turn, filesRead: files.length, inventoryTruncated: files.length >= 40 };
}

export async function runTrial(options) {
  const { workspace, prompt, followups = [], arm, model = DEFAULT_MODEL, effort = DEFAULT_EFFORT, timeoutMs = 480_000, outputDir, serverPath, signal, authorizeProvider = false, runId = randomUUID(), codexPath = DEFAULT_CODEX, sourceCodexHome = process.env.CODEX_HOME ?? join(homedir(), '.codex'), spawnFn = nodeSpawn, graceMs = 2_000 } = options ?? {};
  if (!workspace || !prompt || !outputDir || !serverPath || !ARMS.has(arm)) throw new TypeError('workspace, prompt, outputDir, serverPath, and valid arm are required');
  if (followups.length) throw new TypeError('followups require native continuation support');
  const root = resolve(outputDir, safeName(runId)); const codexHome = join(root, 'codex-home'); const graphState = join(root, 'graph'); const jevState = join(root, 'jev');
  const stdoutPath = join(root, 'stdout.ndjson'), stderrPath = join(root, 'stderr.log'), eventsPath = join(root, 'events.json'), lastMessagePath = join(root, 'last-message.txt');
  await mkdir(codexHome, { recursive: true, mode: 0o700 }); await mkdir(graphState, { recursive: true, mode: 0o700 }); await mkdir(jevState, { recursive: true, mode: 0o700 });
  const authPath = resolve(sourceCodexHome, 'auth.json'); const authInfo = await lstat(authPath); if (!authInfo.isFile()) throw new Error('Codex auth source must be a regular file');
  await symlink(authPath, join(codexHome, 'auth.json'));
  const env = { PATH: process.env.PATH ?? '/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin', HOME: process.env.HOME ?? homedir(), USER: process.env.USER ?? '', LANG: process.env.LANG ?? 'C.UTF-8', CODEX_HOME: codexHome };
  const objective = String(prompt); const args = buildLaunch({ arm, model, effort, workspace, lastMessagePath, serverPath: resolve(serverPath), graphRoot: resolve(workspace), graphState, jevState, objective, authorizeProvider });
  const started = performance.now(); let result; let receipt;
  let session = { sessionId: null, turn: null, filesRead: 0, inventoryTruncated: false }; let cleanupError = null;
  try {
    result = await runChild({ spawnFn, codexPath, args, env, cwd: resolve(workspace), input: objective, timeoutMs, graceMs, signal });
    await writeFile(stdoutPath, result.stdout, { mode: 0o600 }); await writeFile(stderrPath, result.stderr, { mode: 0o600 });
    const parsed = parseEvents(result.stdout); await writeFile(eventsPath, `${JSON.stringify(parsed.events, null, 2)}\n`, { mode: 0o600 }); session = await inspectSession(codexHome); const info = extract(parsed.events);
    const terminalOk = info.terminal && /turn\.completed$/i.test(String(info.terminal.type ?? info.terminal.event ?? info.terminal.name)) && !info.terminal.is_error && result.closeResult?.code === 0 && !result.timedOut && !result.aborted && !result.cleanupRequired;
    const resolvedModel = session.turn?.model ?? info.model; const resolvedEffort = session.turn?.effort ?? info.effort;
    const modelMatches = resolvedModel === model; const effortMatches = resolvedEffort === effort;
    receipt = { runId, arm, requestedModel: model, resolvedModel, requestedEffort: effort, resolvedEffort, completion: Boolean(terminalOk && modelMatches && effortMatches), comparisonEligible: Boolean(terminalOk && modelMatches && effortMatches && parsed.malformed === 0), exitCode: result.closeResult?.code ?? null, signal: result.closeResult?.signal ?? null, timeout: result.timedOut, aborted: result.aborted, cleanupRequired: result.cleanupRequired, wallMs: Math.round(performance.now() - started), usage: info.usage, cost: { reportedUsd: null, estimatedUsd: null, billedUsd: null, attribution: 'unavailable' }, graph: { calls: info.graphCalls, serverPath: resolve(serverPath), arm }, graphStateDir: graphState, jevStateDir: jevState, raw: { stdoutPath, stderrPath, eventsPath, lastMessagePath }, isolation: { privateCodexHome: codexHome, authMode: 'symlink_to_existing_codex_auth', graphStateDir: graphState, jevStateDir: jevState, jevCalls: 0, authAuthorizedForGraph: authorizeProvider, modelEvidence: session, raw: { stdoutPath, stderrPath, eventsPath, lastMessagePath } }, error: result.spawnError?.message ?? (parsed.malformed ? 'malformed Codex JSON events' : null) };
  } catch (error) { receipt = { runId, arm, requestedModel: model, resolvedModel: session.turn?.model ?? null, requestedEffort: effort, resolvedEffort: session.turn?.effort ?? null, completion: false, comparisonEligible: false, exitCode: null, signal: null, timeout: false, aborted: Boolean(signal?.aborted), wallMs: Math.round(performance.now() - started), usage: { inputTokens: null, cachedInputTokens: null, outputTokens: null, reasoningTokens: null }, cost: { reportedUsd: null, estimatedUsd: null, billedUsd: null, attribution: 'unavailable' }, graph: { calls: [], serverPath: resolve(serverPath), arm }, graphStateDir: graphState, jevStateDir: jevState, raw: { stdoutPath, stderrPath, eventsPath, lastMessagePath }, isolation: { privateCodexHome: codexHome, graphStateDir: graphState, jevStateDir: jevState, jevCalls: 0, modelEvidence: session, raw: { stdoutPath, stderrPath, eventsPath, lastMessagePath } }, error: String(error?.message ?? error).slice(0, 2000) }; }
  finally { try { await rm(codexHome, { recursive: true, force: true }); } catch (error) { cleanupError = String(error?.message ?? error); } }
  if (cleanupError) { receipt.cleanupError = cleanupError; receipt.comparisonEligible = false; }
  await writeFile(join(root, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 }); return receipt;
}

export const defaults = { codexPath: DEFAULT_CODEX, model: DEFAULT_MODEL, effort: DEFAULT_EFFORT };
