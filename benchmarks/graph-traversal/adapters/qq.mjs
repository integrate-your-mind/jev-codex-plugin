import { mkdir, writeFile, readFile, rename } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn as nodeSpawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';

const DEFAULT_MODEL = 'openai-codex/gpt-6-astra';
const DEFAULT_EFFORT = 'high';
const DEFAULT_TIMEOUT = 480_000;

function safeName(value) { return String(value ?? 'trial').replace(/[^a-zA-Z0-9._-]/g, '_'); }
function finite(value) { return Number.isFinite(value) ? value : null; }
function atomicJson(path, value) {
  return (async () => {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await rename(temp, path);
  })();
}

function configFor({ model, effort, serverPath, pin = null }) {
  // Only variable names are passed to the MCP child. Secret values stay in the
  // parent environment and are never interpolated into this document.
  const quoted = JSON.stringify(resolve(serverPath));
  const pinField = pin ? `, pin: "${pin}"` : '';
  return `(version: 1, model: ${JSON.stringify(model)}, reasoning_effort: ${effort}, jev_review: off, jev_routing: false, jev_approval: false, profiles: {"graph": Profile(model: ${JSON.stringify(model)}, reasoning_effort: ${effort}, approval_mode: auto, jev_review: off, jev_routing: false, jev_approval: false)}, mcp: {"project_graph": Stdio(command: "node", args: [${quoted}], env: [], eager: true, allow: ["project_graph"]${pinField})})`;
}

function parseJsonl(text) {
  return String(text).split(/\r?\n/).filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
}

function eventBody(record) { return record?.envelope?.event ?? record?.event ?? record; }
function graphEvidence(records) {
  const calls = [];
  for (const record of records) {
    const event = eventBody(record);
    const tool = event?.tool_call ?? event?.toolCall ?? event?.call;
    const name = tool?.name ?? event?.tool_name ?? event?.toolName;
    if (typeof name === 'string' && name === 'mcp__project_graph__project_graph') {
      let argumentsValue = tool?.arguments;
      if (typeof argumentsValue === 'string') {
        try { argumentsValue = JSON.parse(argumentsValue); } catch { argumentsValue = null; }
      }
      calls.push({ type: event.type ?? null, name, operation: argumentsValue?.operation ?? null });
    }
  }
  return calls;
}

function usageFrom(value) {
  if (!value || typeof value !== 'object') return { inputTokens: null, cachedInputTokens: null, outputTokens: null, reasoningTokens: null };
  return { inputTokens: finite(value.input_tokens), cachedInputTokens: finite(value.cache_read_input_tokens), outputTokens: finite(value.output_tokens), reasoningTokens: finite(value.reasoning_tokens) };
}

function spawnCapture(spawnImpl, command, args, options) {
  const child = spawnImpl(command, args, options);
  let stdout = ''; let stderr = '';
  child.stdout?.on('data', (chunk) => { stdout += chunk; });
  child.stderr?.on('data', (chunk) => { stderr += chunk; });
  const done = new Promise((resolveDone, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolveDone({ code, signal, stdout, stderr }));
  });
  return { child, done, output: () => ({ stdout, stderr }) };
}

function terminate(child, signal = 'SIGTERM') {
  if (!child) return;
  try {
    if (Number.isInteger(child.pid) && child.pid > 0) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch { /* an already-exited child is harmless */ }
}

async function boundedDone(handle, timeoutMs) {
  let timer;
  const timeout = new Promise((resolveTimeout) => {
    timer = setTimeout(async () => {
      terminate(handle.child);
      const afterTerm = await Promise.race([handle.done, new Promise((resolveDelay) => setTimeout(resolveDelay, 1_500))]);
      if (afterTerm?.code !== undefined) return resolveTimeout({ ...afterTerm, timedOut: true });
      terminate(handle.child, 'SIGKILL');
      const afterKill = await Promise.race([handle.done, new Promise((resolveDelay) => setTimeout(resolveDelay, 1_000))]);
      resolveTimeout(afterKill?.code !== undefined ? { ...afterKill, timedOut: true } : { ...handle.output(), code: null, signal: 'SIGKILL', timedOut: true, unresolved: true });
    }, timeoutMs);
  });
  const result = await Promise.race([handle.done, timeout]);
  clearTimeout(timer);
  if (!result.timedOut) {
    // The main process may close before a stdio MCP descendant does. The
    // detached process group is ours, so close it on the normal path too.
    terminate(handle.child);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
    terminate(handle.child, 'SIGKILL');
  }
  return result;
}

async function writeGraphLauncher(path, { serverPath, workspace, graphStateDir, arm, objective, jevStateDir, jevApiKeyFile }) {
  const values = { serverPath: resolve(serverPath), workspace: resolve(workspace), graphStateDir: resolve(graphStateDir), arm, objective, jevStateDir: resolve(jevStateDir), jevApiKeyFile: jevApiKeyFile ? resolve(jevApiKeyFile) : null };
  const source = `const c = ${JSON.stringify(values)};\nprocess.env.PROJECT_GRAPH_ROOT = c.workspace;\nprocess.env.PROJECT_GRAPH_STATE = c.graphStateDir;\nprocess.env.PROJECT_GRAPH_ARM = c.arm;\nprocess.env.PROJECT_GRAPH_OBJECTIVE = c.objective;\nprocess.env.JEV_STATE_DIRECTORY = c.jevStateDir;\nif (c.jevApiKeyFile) process.env.JEV_API_KEY_FILE = c.jevApiKeyFile;\nawait import(c.serverPath);\n`;
  await writeFile(path, source, { mode: 0o700 });
}

/** Run one isolated QQ headless trial. Provider execution requires explicit authorization. */
export async function runTrial(options = {}) {
  const { workspace, prompt, arm, outputDir, serverPath, model = DEFAULT_MODEL, effort = DEFAULT_EFFORT, timeoutMs = DEFAULT_TIMEOUT, signal, qqBinary = '/Users/romanmondello/.local/bin/qq', authorizeProvider = false, spawnImpl = nodeSpawn, jevApiKeyFile = null } = options;
  if (!workspace || !prompt || !outputDir || !serverPath || !['graph', 'cheap', 'jev'].includes(arm)) throw new TypeError('workspace, prompt, outputDir, serverPath, and arm are required');
  if (model !== DEFAULT_MODEL || effort !== DEFAULT_EFFORT) throw new TypeError('graph study requires openai-codex/gpt-6-astra/high');
  if (signal?.aborted) throw new Error('QQ trial aborted before start');
  const runId = options.runId ?? randomUUID();
  const runRoot = resolve(outputDir, safeName(runId));
  const storePath = join(runRoot, 'qq-data');
  const graphStateDir = join(outputDir, 'graph');
  const jevStateDir = join(outputDir, 'jev');
  const stdoutPath = join(runRoot, 'stdout.jsonl');
  const stderrPath = join(runRoot, 'stderr.log');
  const inspectPath = join(runRoot, 'mcp-inspect.json');
  const launcherPath = join(runRoot, 'project-graph-launcher.mjs');
  await mkdir(runRoot, { recursive: true, mode: 0o700 });
  await writeGraphLauncher(launcherPath, { serverPath, workspace, graphStateDir, arm, objective: prompt, jevStateDir, jevApiKeyFile: arm === 'jev' && authorizeProvider ? jevApiKeyFile : null });
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, LANG: process.env.LANG, USER: process.env.USER, XDG_DATA_HOME: storePath, QQ_CONFIG_CONTENT: configFor({ model, effort, serverPath: launcherPath }) };
  await mkdir(graphStateDir, { recursive: true, mode: 0o700 });
  await mkdir(jevStateDir, { recursive: true, mode: 0o700 });
  delete env.TYPESAFE_API_KEY;
  const started = performance.now();
    const common = { cwd: resolve(workspace), env, stdio: ['ignore', 'pipe', 'pipe'], detached: true };
  let inspect = null;
  let run = null;
  let cleanupRequired = false;
  try {
    const preflight = spawnCapture(spawnImpl, qqBinary, ['mcp', 'inspect', 'project_graph'], common);
    const inspectResult = await boundedDone(preflight, Math.min(timeoutMs, 30_000));
    if (inspectResult.timedOut) throw new Error('QQ MCP inspect timed out');
    await writeFile(inspectPath, inspectResult.stdout, { mode: 0o600 });
    try { inspect = JSON.parse(inspectResult.stdout); } catch { inspect = { parseError: true }; }
    if (inspectResult.code !== 0) throw new Error(`QQ MCP inspect failed (${inspectResult.code ?? inspectResult.signal})`);
    const digest = typeof inspect?.digest === 'string' && /^[0-9a-f]{64}$/.test(inspect.digest) ? inspect.digest : null;
    if (!digest) throw new Error('QQ MCP inspect did not return a valid project_graph digest');
    env.QQ_CONFIG_CONTENT = configFor({ model, effort, serverPath: launcherPath, pin: digest });
    if (!authorizeProvider) {
      const receipt = { runId, arm, completion: 'not_started', requestedModel: model, resolvedModel: null, requestedEffort: effort, resolvedEffort: null, usage: usageFrom(null), cost: { reportedUsd: null, estimatedUsd: null, billedUsd: null, attribution: 'unknown' }, graphNativeCalls: [], graphDelivery: null, graphStateDir, jevStateDir, rawPaths: { inspect: inspectPath }, privateQQStorePath: storePath, cleanupRequired: false, error: 'provider execution requires explicit authorizeProvider:true', configEvidence: { jevReview: 'off', jevRouting: false, jevApproval: false, mcpServer: 'project_graph' } };
      await atomicJson(join(runRoot, 'receipt.json'), receipt);
      return receipt;
    }
    const args = ['run', '--workspace', resolve(workspace), '--approval', 'auto', '--profile', 'graph', '--model', model, '--format', 'jsonl', '--trace', stdoutPath, '--allow-tool', 'mcp__project_graph__project_graph', '--allow-shell', 'node', '--allow-shell', 'npm test', '--allow-tool', 'write_file', '--allow-tool', 'edit_file', '--timeout-seconds', String(Math.ceil(timeoutMs / 1000)), '--', prompt];
    run = spawnCapture(spawnImpl, qqBinary, args, common);
    const abort = () => { cleanupRequired = true; terminate(run.child); };
    signal?.addEventListener('abort', abort, { once: true });
    const result = await boundedDone(run, timeoutMs);
    signal?.removeEventListener('abort', abort);
    if (result.timedOut) cleanupRequired = true;
    await writeFile(stdoutPath, result.stdout, { mode: 0o600 });
    await writeFile(stderrPath, result.stderr, { mode: 0o600 });
    const records = parseJsonl(result.stdout);
    const trial = records.find((item) => item.type === 'trial');
    const outcome = records.find((item) => item.type === 'outcome');
    const events = records.filter((item) => item.type === 'event');
    const finished = events.map(eventBody).findLast((event) => event?.type === 'run_finished');
    const modelTurn = events.map(eventBody).findLast((event) => event?.type === 'model_turn_completed');
    const resolvedModel = modelTurn?.model?.model ?? finished?.session?.model ?? null;
    const resolvedEffort = modelTurn?.reasoning_effort ?? trial?.reasoning_effort ?? finished?.session?.reasoning_effort ?? null;
    const estimatedUsd = finite(outcome?.estimated_cost_usd_nanos) == null ? null : Number(outcome.estimated_cost_usd_nanos) / 1e9;
    const completion = outcome?.status === 'completed' && result.code === 0 && !cleanupRequired && !result.unresolved && !result.timedOut;
    const receipt = { runId, arm, completion, exitCode: result.code, requestedModel: model, resolvedModel, requestedEffort: effort, resolvedEffort, usage: usageFrom(outcome?.usage ?? finished?.usage), cost: { reportedUsd: estimatedUsd, estimatedUsd, billedUsd: null, attribution: estimatedUsd == null ? 'unknown' : 'qq-reported-estimate' }, graphNativeCalls: graphEvidence(records), graphDelivery: graphEvidence(records).length ? 'event-bound' : 'no-project-graph-call-observed', graphStateDir, jevStateDir, rawPaths: { inspect: inspectPath, stdout: stdoutPath, stderr: stderrPath }, privateQQStorePath: storePath, cleanupRequired, configEvidence: { jevReview: 'off', jevRouting: false, jevApproval: false, mcpServer: 'project_graph' }, error: completion ? null : (outcome?.message ?? `qq exited ${result.code ?? result.signal}`) };
    await atomicJson(join(runRoot, 'receipt.json'), receipt);
    return receipt;
  } catch (error) {
    if (run && !run.child.killed) { cleanupRequired = true; terminate(run.child); }
    const receipt = { runId, arm, completion: false, requestedModel: model, resolvedModel: null, requestedEffort: effort, resolvedEffort: null, usage: usageFrom(null), cost: { reportedUsd: null, estimatedUsd: null, billedUsd: null, attribution: 'unknown' }, graphNativeCalls: [], graphDelivery: null, graphStateDir, jevStateDir, rawPaths: { inspect: inspectPath, stdout: stdoutPath, stderr: stderrPath }, privateQQStorePath: storePath, cleanupRequired, configEvidence: { jevReview: 'off', jevRouting: false, jevApproval: false, mcpServer: 'project_graph' }, error: error.message };
    await atomicJson(join(runRoot, 'receipt.json'), receipt);
    return receipt;
  }
}

export const defaults = { model: DEFAULT_MODEL, effort: DEFAULT_EFFORT, timeoutMs: DEFAULT_TIMEOUT };
