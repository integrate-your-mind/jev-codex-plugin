#!/usr/bin/env node

import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFile, execFileSync, spawn} from 'node:child_process';
import {constants as fsConstants} from 'node:fs';
import {chmod, mkdir, mkdtemp, open, readFile, readdir, realpath, rm, symlink, writeFile} from 'node:fs/promises';
import {homedir, tmpdir} from 'node:os';
import {dirname, isAbsolute, join, normalize, relative, resolve, sep} from 'node:path';
import {createInterface} from 'node:readline';
import {fileURLToPath, pathToFileURL} from 'node:url';

const SCHEMA_VERSION = 'paired-codex-v1';
const RUNNER_VERSION = 'paired-codex-benchmark-v1';
const RPC_TIMEOUT_MS = 30_000;
const INITIALIZE_TIMEOUT_MS = 90_000;
const DEFAULT_TURN_TIMEOUT_MS = 180_000;
const ORACLE_TIMEOUT_MS = 60_000;
const MAX_TASKS = 100;
const MAX_FILES_PER_TASK = 100;
const MAX_FILE_BYTES = 2_000_000;
const MAX_PROMPT_BYTES = 100_000;
const JEV_ENV_KEYS = ['TYPESAFE_API_KEY', 'JEV_API_KEY', 'JEV_API_KEY_FILE'];
const TOKEN_USAGE_KEYS = new Set([
  'inputTokens', 'cachedInputTokens', 'outputTokens', 'reasoningOutputTokens', 'totalTokens', 'modelContextWindow',
  'input_tokens', 'cached_input_tokens', 'output_tokens', 'reasoning_output_tokens', 'total_tokens', 'model_context_window',
]);

function hash(value) {
  return createHash('sha256').update(Buffer.isBuffer(value) ? value : String(value)).digest('hex');
}

function byteLength(value) {
  return Buffer.byteLength(value, 'utf8');
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function safeId(value, label) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(value)) {
    throw new Error(`${label} must match [A-Za-z0-9][A-Za-z0-9._-]{0,79}`);
  }
  return value;
}

function safeRelativePath(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 240 || value.includes('\0') || value.includes('\\')) {
    throw new Error('Fixture paths must be non-empty bounded POSIX relative paths');
  }
  const normalized = normalize(value);
  if (isAbsolute(value) || normalized === '..' || normalized.startsWith(`..${sep}`) || normalized !== value || value.endsWith('/')) {
    throw new Error(`Unsafe fixture path: ${value}`);
  }
  return value;
}

export function parseArgs(argv) {
  const result = {live: false, preflightOnly: false, repeats: 1, seed: 'paired-codex-v1', timeoutMs: DEFAULT_TURN_TIMEOUT_MS};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--live') result.live = true;
    else if (token === '--preflight-only') result.preflightOnly = true;
    else if (['--tasks', '--output', '--repeats', '--seed', '--timeout-ms'].includes(token)) {
      if (index + 1 >= argv.length) throw new Error(`Missing value for ${token}`);
      const value = argv[++index];
      if (token === '--tasks') result.tasksPath = value;
      else if (token === '--output') result.outputPath = value;
      else if (token === '--seed') result.seed = value;
      else if (token === '--repeats') result.repeats = Number(value);
      else result.timeoutMs = Number(value);
    } else throw new Error(`Unknown option: ${token}`);
  }
  if (!result.live) throw new Error('Refusing to run without the explicit --live gate');
  if (!result.tasksPath || !isAbsolute(result.tasksPath)) throw new Error('--tasks must be an absolute path');
  if (!result.outputPath || !isAbsolute(result.outputPath)) throw new Error('--output must be an absolute path');
  if (!Number.isSafeInteger(result.repeats) || result.repeats < 1 || result.repeats > 20) throw new Error('--repeats must be an integer from 1 through 20');
  if (!Number.isSafeInteger(result.timeoutMs) || result.timeoutMs < 1_000 || result.timeoutMs > 900_000) throw new Error('--timeout-ms must be an integer from 1000 through 900000');
  safeId(result.seed, '--seed');
  return result;
}

export function validateTaskDocument(value) {
  if (!isPlainObject(value) || value.schemaVersion !== SCHEMA_VERSION || !Array.isArray(value.tasks)) {
    throw new Error(`Task file must use schemaVersion ${SCHEMA_VERSION} and a tasks array`);
  }
  if (value.tasks.length < 1 || value.tasks.length > MAX_TASKS) throw new Error(`Task count must be 1 through ${MAX_TASKS}`);
  const ids = new Set();
  const tasks = value.tasks.map((task, taskIndex) => {
    if (!isPlainObject(task)) throw new Error(`tasks[${taskIndex}] must be an object`);
    const allowed = new Set(['id', 'prompt', 'files', 'verification', 'followupPrompt']);
    for (const key of Object.keys(task)) if (!allowed.has(key)) throw new Error(`Unknown task key: ${key}`);
    const id = safeId(task.id, `tasks[${taskIndex}].id`);
    if (ids.has(id)) throw new Error(`Duplicate task id: ${id}`);
    ids.add(id);
    if (typeof task.prompt !== 'string' || task.prompt.trim().length === 0 || byteLength(task.prompt) > MAX_PROMPT_BYTES) {
      throw new Error(`Task ${id} prompt must be non-empty and at most ${MAX_PROMPT_BYTES} bytes`);
    }
    if (task.followupPrompt !== undefined && (typeof task.followupPrompt !== 'string' || task.followupPrompt.trim().length === 0 || byteLength(task.followupPrompt) > MAX_PROMPT_BYTES)) {
      throw new Error(`Task ${id} followupPrompt must be non-empty and bounded when provided`);
    }
    if (!isPlainObject(task.files)) throw new Error(`Task ${id} files must be an object`);
    const fileEntries = Object.entries(task.files);
    if (fileEntries.length < 1 || fileEntries.length > MAX_FILES_PER_TASK) throw new Error(`Task ${id} must have 1 through ${MAX_FILES_PER_TASK} files`);
    const files = {};
    for (const [path, contents] of fileEntries) {
      safeRelativePath(path);
      if (typeof contents !== 'string' || byteLength(contents) > MAX_FILE_BYTES) throw new Error(`Fixture file ${path} must be a string no larger than ${MAX_FILE_BYTES} bytes`);
      files[path] = contents;
    }
    const verification = task.verification;
    if (!isPlainObject(verification)) throw new Error(`Task ${id} verification must be an object`);
    if (Object.keys(verification).some(key => !['command', 'args', 'expectedExitCode'].includes(key))) throw new Error(`Task ${id} verification has an unknown key`);
    if (typeof verification.command !== 'string' || (verification.command !== '$NODE' && !isAbsolute(verification.command))) throw new Error(`Task ${id} verification.command must be absolute or $NODE`);
    if (!Array.isArray(verification.args) || verification.args.some(arg => typeof arg !== 'string' || arg.includes('\0') || byteLength(arg) > 10_000)) {
      throw new Error(`Task ${id} verification.args must be bounded strings`);
    }
    if (!Number.isSafeInteger(verification.expectedExitCode) || verification.expectedExitCode < 0 || verification.expectedExitCode > 255) {
      throw new Error(`Task ${id} verification.expectedExitCode must be an integer from 0 through 255`);
    }
    return {id, prompt: task.prompt, files, verification: {...verification, args: [...verification.args]}, followupPrompt: task.followupPrompt};
  });
  return {schemaVersion: SCHEMA_VERSION, tasks};
}

function seededShuffle(values, seed) {
  const result = [...values];
  let state = Number.parseInt(hash(seed).slice(0, 8), 16) || 1;
  const random = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
  for (let index = result.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1));
    [result[index], result[other]] = [result[other], result[index]];
  }
  return result;
}

export function buildPlan(tasks, repeats, seed) {
  const pairs = [];
  for (const task of tasks) for (let repeat = 1; repeat <= repeats; repeat += 1) pairs.push({taskId: task.id, repeat});
  const shuffled = seededShuffle(pairs, seed);
  const offset = Number.parseInt(hash(`${seed}:arm-offset`).slice(0, 2), 16) % 2;
  return shuffled.flatMap((pair, pairIndex) => {
    const first = (pairIndex + offset) % 2 === 0 ? 'baseline' : 'treatment';
    const arms = first === 'baseline' ? ['baseline', 'treatment'] : ['treatment', 'baseline'];
    return arms.map((arm, armPosition) => ({
      trialId: `${pair.taskId}.r${pair.repeat}.${arm}`,
      taskId: pair.taskId,
      repeat: pair.repeat,
      arm,
      pairIndex,
      armPosition,
    }));
  });
}

async function createIsolatedCodexHome() {
  const sourceHome = resolve(process.env.CODEX_HOME ?? join(homedir(), '.codex'));
  const python = String.raw`import json, os, pathlib, tomllib
p = pathlib.Path(os.environ.get("CODEX_HOME", str(pathlib.Path.home()/".codex"))) / "config.toml"
c = tomllib.loads(p.read_text()) if p.exists() else {}
state = c.get("hooks", {}).get("state", {})
print(json.dumps({"model": c.get("model"), "hooks": {k:v for k,v in state.items() if k.startswith("jev-workflows@personal:")}}))`;
  const source = JSON.parse(execFileSync('python3', ['-c', python], {encoding: 'utf8'}));
  if (typeof source.model !== 'string' || !isPlainObject(source.hooks) || Object.keys(source.hooks).length === 0) throw new Error('Unable to read the existing model and trusted Jev hook hashes');
  for (const [key, value] of Object.entries(source.hooks)) {
    if (!isPlainObject(value) || typeof value.trusted_hash !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(value.trusted_hash)) throw new Error(`Invalid trusted Jev hook state: ${key}`);
  }
  const cacheRoot = join(sourceHome, 'plugins', 'cache', 'personal', 'jev-workflows');
  const versions = (await readdir(cacheRoot, {withFileTypes: true})).filter(entry => entry.isDirectory()).map(entry => entry.name);
  if (versions.length !== 1) throw new Error(`Expected exactly one installed Jev version; found ${versions.length}`);
  const installedSource = await realpath(join(cacheRoot, versions[0]));
  const authSource = await realpath(join(sourceHome, 'auth.json'));
  const isolatedHome = await mkdtemp(join(tmpdir(), 'paired-codex-home-'));
  await chmod(isolatedHome, 0o700);
  await symlink(authSource, join(isolatedHome, 'auth.json'));
  const isolatedCache = join(isolatedHome, 'plugins', 'cache', 'personal', 'jev-workflows');
  await mkdir(isolatedCache, {recursive: true, mode: 0o700});
  await symlink(installedSource, join(isolatedCache, versions[0]));
  const config = [
    `model = ${JSON.stringify(source.model)}`,
    'project_doc_max_bytes = 0',
    '',
    '[features]',
    'apps = false',
    'remote_plugin = false',
    'plugins = true',
    '',
    '[plugins."jev-workflows@personal"]',
    'enabled = true',
    '',
    ...Object.entries(source.hooks).flatMap(([key, value]) => [
      `[hooks.state.${JSON.stringify(key)}]`,
      `trusted_hash = ${JSON.stringify(value.trusted_hash)}`,
      '',
    ]),
  ].join('\n');
  await writeFile(join(isolatedHome, 'config.toml'), config, {mode: 0o600, flag: 'wx'});
  return {path: isolatedHome, pluginVersion: versions[0], trustedHookCount: Object.keys(source.hooks).length, model: source.model};
}

function childEnvironment(arm, codexHome) {
  const env = {...process.env, CODEX_HOME: codexHome, JEV_HOOKS_ENABLED: arm === 'treatment' ? '1' : '0', JEV_ENABLED: arm === 'treatment' ? '1' : '0'};
  if (arm === 'baseline') for (const key of [...JEV_ENV_KEYS, 'JEV_STATE_DIRECTORY', 'JEV_STATE_MODE', 'PLUGIN_DATA']) delete env[key];
  return env;
}

export function compactUsage(value, depth = 0) {
  if (!isPlainObject(value) || depth > 3) return undefined;
  const result = {};
  for (const [key, child] of Object.entries(value)) {
    if (typeof child === 'number' && Number.isFinite(child) && TOKEN_USAGE_KEYS.has(key)) result[key] = child;
    else if (isPlainObject(child)) {
      const nested = compactUsage(child, depth + 1);
      if (nested && Object.keys(nested).length > 0) result[key] = nested;
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function compactAccounting(value) {
  if (!isPlainObject(value)) return undefined;
  const result = {};
  if (isPlainObject(value.budget)) {
    result.budget = {};
    for (const key of ['date', 'countingBasis', 'reservedAttempts', 'reservedPayloadBytes', 'status']) {
      if (['string', 'number', 'boolean'].includes(typeof value.budget[key]) || value.budget[key] === null) result.budget[key] = value.budget[key];
    }
  }
  if (isPlainObject(value.evaluations)) {
    result.evaluations = {};
    for (const key of ['date', 'timeZone', 'inventoryFiles', 'totals', 'currentCredential', 'otherCredential', 'unknownCredential', 'uniqueProviderRequestIds', 'malformedOrUnreadable', 'inventoryReadable', 'providerBilledRequests', 'providerBilledTokens', 'billingReconciled']) {
      const child = value.evaluations[key];
      if (['string', 'number', 'boolean'].includes(typeof child) || child === null) result.evaluations[key] = child;
      else if (isPlainObject(child)) result.evaluations[key] = compactUsage(child) ?? {};
    }
  }
  for (const key of ['status', 'version', 'model', 'credentialConfigured']) {
    if (['string', 'number', 'boolean'].includes(typeof value[key]) || value[key] === null) result[key] = value[key];
  }
  if (isPlainObject(value.automation)) {
    result.automation = {};
    for (const key of ['enabled', 'scope', 'maxHookCallsPerSession', 'maxCallsPerDay', 'maxBytesPerDay']) {
      if (['string', 'number', 'boolean'].includes(typeof value.automation[key]) || value.automation[key] === null) result.automation[key] = value.automation[key];
    }
  }
  return result;
}

function compactHook(run) {
  if (!isPlainObject(run)) return undefined;
  const feedback = [];
  if (Array.isArray(run.entries)) for (const entry of run.entries) {
    if (typeof entry?.text !== 'string') continue;
    const status = entry.text.match(/JEV advisory: status=(assessed|abstained|unavailable|skipped|preview)\b/)?.[1];
    if (!status) continue;
    feedback.push({
      status,
      decision: entry.text.match(/\bdecision=(proceed|reconsider|gather_evidence|insufficient_evidence)\b/)?.[1],
      reason: entry.text.match(/\breason=([a-z_]{1,80})\b/)?.[1],
      receiptId: entry.text.match(/\breceipt=([a-f0-9-]{36})\b/)?.[1],
    });
  }
  return {
    idSha256: typeof run.id === 'string' ? hash(run.id) : undefined,
    eventName: typeof run.eventName === 'string' ? run.eventName : undefined,
    status: typeof run.status === 'string' ? run.status : undefined,
    durationMs: Number.isFinite(run.durationMs) ? run.durationMs : undefined,
    source: typeof run.source === 'string' ? run.source : undefined,
    feedback,
  };
}

function compactHookInventory(entries) {
  return entries.flatMap(entry => Array.isArray(entry?.hooks) ? entry.hooks : []).filter(hook => {
    return String(hook?.pluginId ?? '').includes('jev-workflows') || String(hook?.sourcePath ?? '').includes('/jev-workflows/');
  }).map(hook => ({
    key: typeof hook.key === 'string' ? hook.key : undefined,
    eventName: typeof hook.eventName === 'string' ? hook.eventName : undefined,
    pluginId: typeof hook.pluginId === 'string' ? hook.pluginId : undefined,
    enabled: hook.enabled === true,
    trustStatus: typeof hook.trustStatus === 'string' ? hook.trustStatus : undefined,
    handlerType: typeof hook.handlerType === 'string' ? hook.handlerType : undefined,
    currentHash: typeof hook.currentHash === 'string' ? hook.currentHash : undefined,
  }));
}

function compactMcpInventory(data) {
  return (Array.isArray(data) ? data : []).map(server => ({
    name: typeof server?.name === 'string' ? server.name : undefined,
    pluginId: typeof server?.pluginId === 'string' ? server.pluginId : undefined,
    runtimeStatus: typeof server?.runtimeStatus === 'string' ? server.runtimeStatus : undefined,
    toolNames: isPlainObject(server?.tools) ? Object.keys(server.tools).sort() : [],
  }));
}

export function collectPluginIds(configuredIds, pluginListResponse, mcpInventory) {
  const summaries = (pluginListResponse?.marketplaces ?? []).flatMap(marketplace => Array.isArray(marketplace?.plugins) ? marketplace.plugins : []);
  const listedIds = summaries.filter(plugin => plugin?.installed === true || plugin?.enabled === true).map(plugin => plugin?.id).filter(id => typeof id === 'string');
  const runtimeIds = mcpInventory.map(item => item?.pluginId).filter(id => typeof id === 'string');
  return [...new Set([...configuredIds, ...listedIds, ...runtimeIds])].sort();
}

export function collectRuntimeMcpServerNames(mcpInventory) {
  return [...new Set(mcpInventory.filter(item => typeof item?.pluginId === 'string').map(item => item?.name).filter(name => typeof name === 'string'))].sort();
}

export function isInfrastructureFailure(trial) {
  return Boolean(trial?.failure && trial.failure.stage !== 'turn_or_postflight');
}

function chooseHostDefault(models) {
  const model = models.find(item => item?.isDefault === true && item.hidden !== true)
    ?? models.find(item => item?.isDefault === true)
    ?? models.find(item => item?.hidden !== true)
    ?? models[0];
  if (typeof model?.model !== 'string') throw new Error('model/list returned no usable host default');
  return {model: model.model, effort: typeof model.defaultReasoningEffort === 'string' ? model.defaultReasoningEffort : undefined};
}

class AppServer {
  constructor({arm, cwd, configNames, turnTimeoutMs}) {
    this.arm = arm;
    this.cwd = cwd;
    this.turnTimeoutMs = turnTimeoutMs;
    this.pending = new Map();
    this.turnCompletions = new Map();
    this.turnWaiters = new Map();
    this.events = [];
    this.nextId = 0;
    this.stderrBytes = 0;
    this.stderrHash = createHash('sha256');
    const jevPlugins = configNames.plugins.filter(name => String(name).startsWith('jev-workflows@') || name === 'jev-workflows');
    if (arm === 'treatment' && jevPlugins.length !== 1) throw new Error(`Treatment requires exactly one configured Jev plugin; found ${jevPlugins.length}`);
    this.jevPlugins = jevPlugins;
    const args = ['app-server', '--stdio', '--disable', 'apps', '--disable', 'remote_plugin', '-c', 'project_doc_max_bytes=0'];
    for (const name of configNames.servers) args.push('-c', `mcp_servers.${name}.enabled=false`);
    for (const name of configNames.plugins) args.push('-c', `plugins.${name}.enabled=${arm === 'treatment' && jevPlugins.includes(name) ? 'true' : 'false'}`);
    this.spawnedAt = performance.now();
    this.child = spawn('codex', args, {cwd, stdio: ['pipe', 'pipe', 'pipe'], env: childEnvironment(arm, configNames.codexHome)});
    this.child.stderr.on('data', chunk => { this.stderrBytes += chunk.length; this.stderrHash.update(chunk); });
    this.child.on('error', error => this.fail(error));
    this.child.on('exit', (code, signal) => {
      if (!this.closing) this.fail(new Error(`Codex app-server exited: ${code ?? signal}`));
    });
    this.lines = createInterface({input: this.child.stdout});
    this.lines.on('line', line => this.handleLine(line));
  }

  send(message) {
    if (!this.child.stdin.destroyed) this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  fail(error) {
    this.failure = error;
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(error); }
    this.pending.clear();
    for (const waiter of this.turnWaiters.values()) { clearTimeout(waiter.timer); waiter.reject(error); }
    this.turnWaiters.clear();
  }

  handleLine(line) {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message.id !== undefined && this.pending.has(message.id)) {
      const request = this.pending.get(message.id);
      this.pending.delete(message.id);
      clearTimeout(request.timer);
      if (message.error) request.reject(new Error(`RPC ${request.method} failed with code ${message.error.code ?? 'unknown'}`));
      else request.resolve(message.result);
      return;
    }
    if (message.id !== undefined && message.method) {
      if (message.method === 'item/commandExecution/requestApproval') this.send({id: message.id, result: {decision: 'decline'}});
      else this.send({id: message.id, error: {code: -32601, message: 'Benchmark harness does not grant server requests'}});
      return;
    }
    this.capture(message);
  }

  capture(message) {
    if (typeof message?.method !== 'string') return;
    const threadId = message.params?.threadId;
    const turnId = message.params?.turnId ?? message.params?.turn?.id;
    if (message.method === 'hook/completed') {
      const hook = compactHook(message.params?.run);
      if (hook) this.events.push({method: message.method, threadId, turnId, hook});
      return;
    }
    if (message.method === 'item/completed') {
      const item = message.params?.item;
      if (isPlainObject(item) && typeof item.type === 'string') {
        this.events.push({method: message.method, threadId, turnId, item: {
          type: item.type,
          status: typeof item.status === 'string' ? item.status : undefined,
          exitCode: Number.isInteger(item.exitCode) ? item.exitCode : undefined,
          server: typeof item.server === 'string' ? item.server : undefined,
          tool: typeof item.tool === 'string' ? item.tool : undefined,
          pluginId: typeof item.pluginId === 'string' ? item.pluginId : undefined,
          namespace: typeof item.namespace === 'string' ? item.namespace : undefined,
        }});
      }
      return;
    }
    if (/tokenUsage/i.test(message.method)) {
      const usage = compactUsage(message.params);
      if (usage) this.events.push({method: message.method, threadId, turnId, usage});
      return;
    }
    if (message.method === 'turn/completed') {
      const completion = {id: message.params?.turn?.id, status: message.params?.turn?.status, usage: compactUsage(message.params?.turn?.usage)};
      const key = `${threadId}:${completion.id}`;
      this.turnCompletions.set(key, completion);
      const waiter = this.turnWaiters.get(key);
      if (waiter) {
        this.turnWaiters.delete(key);
        clearTimeout(waiter.timer);
        waiter.resolve(completion);
      }
    }
  }

  rpc(method, params, timeoutMs = RPC_TIMEOUT_MS) {
    return new Promise((resolvePromise, reject) => {
      if (this.failure) return reject(this.failure);
      const id = ++this.nextId;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out: ${method}`));
      }, method === 'initialize' ? INITIALIZE_TIMEOUT_MS : timeoutMs);
      this.pending.set(id, {resolve: resolvePromise, reject, timer, method});
      this.send({id, method, params});
    });
  }

  async initialize() {
    await this.rpc('initialize', {
      clientInfo: {name: 'paired_codex_benchmark', title: 'Paired Codex benchmark', version: '1.0.0'},
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
        optOutNotificationMethods: [
          'item/agentMessage/delta', 'item/plan/delta', 'item/reasoning/textDelta',
          'item/reasoning/summaryTextDelta', 'item/reasoning/summaryPartAdded',
          'rawResponseItem/completed', 'rawResponse/completed', 'command/exec/outputDelta',
          'process/outputDelta', 'item/commandExecution/outputDelta', 'item/fileChange/outputDelta',
        ],
      },
    });
    this.initializedMs = performance.now() - this.spawnedAt;
    this.send({method: 'initialized', params: {}});
  }

  waitForTurn(threadId, turnId) {
    const key = `${threadId}:${turnId}`;
    if (this.turnCompletions.has(key)) return Promise.resolve(this.turnCompletions.get(key));
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        this.turnWaiters.delete(key);
        const error = new Error(`Turn timed out after ${this.turnTimeoutMs}ms`);
        error.code = 'TURN_TIMEOUT';
        reject(error);
      }, this.turnTimeoutMs);
      this.turnWaiters.set(key, {resolve: resolvePromise, reject, timer});
    });
  }

  async close() {
    this.closing = true;
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(new Error('App-server closed')); }
    this.pending.clear();
    for (const waiter of this.turnWaiters.values()) { clearTimeout(waiter.timer); waiter.reject(new Error('App-server closed')); }
    this.turnWaiters.clear();
    this.lines.close();
    if (!this.child.stdin.destroyed) this.child.stdin.end();
    if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill('SIGTERM');
    await new Promise(resolvePromise => {
      if (this.child.exitCode !== null || this.child.signalCode !== null) return resolvePromise();
      const timer = setTimeout(() => { if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill('SIGKILL'); resolvePromise(); }, 2_000);
      this.child.once('exit', () => { clearTimeout(timer); resolvePromise(); });
    });
  }

  stderrEvidence() {
    return {bytes: this.stderrBytes, sha256: this.stderrHash.digest('hex')};
  }
}

async function writeFixture(workspace, files) {
  await mkdir(workspace, {recursive: false, mode: 0o700});
  for (const [path, contents] of Object.entries(files)) {
    const destination = resolve(workspace, path);
    if (relative(workspace, destination).startsWith('..')) throw new Error(`Fixture path escaped workspace: ${path}`);
    await mkdir(dirname(destination), {recursive: true, mode: 0o700});
    await writeFile(destination, contents, {encoding: 'utf8', mode: 0o600, flag: 'wx'});
  }
}

async function runOracle(verification, workspace) {
  const started = performance.now();
  let stdout = Buffer.alloc(0);
  let stderr = Buffer.alloc(0);
  let exitCode = 0;
  let signal = null;
  let timedOut = false;
  try {
    const result = await new Promise((resolvePromise, reject) => {
      execFile(verification.command, verification.args, {
        cwd: workspace,
        timeout: ORACLE_TIMEOUT_MS,
        maxBuffer: 1_000_000,
        encoding: 'buffer',
        env: Object.fromEntries(['PATH', 'LANG', 'LC_ALL', 'TMPDIR'].flatMap(key => process.env[key] === undefined ? [] : [[key, process.env[key]]])),
      }, (error, out, err) => error ? reject(Object.assign(error, {capturedStdout: out, capturedStderr: err})) : resolvePromise({stdout: out, stderr: err}));
    });
    stdout = result.stdout ?? stdout;
    stderr = result.stderr ?? stderr;
  } catch (error) {
    stdout = error.capturedStdout ?? error.stdout ?? stdout;
    stderr = error.capturedStderr ?? error.stderr ?? stderr;
    exitCode = Number.isInteger(error.code) ? error.code : null;
    signal = typeof error.signal === 'string' ? error.signal : null;
    timedOut = error.killed === true && signal !== null;
  }
  const outBuffer = Buffer.isBuffer(stdout) ? stdout : Buffer.from(String(stdout));
  const errBuffer = Buffer.isBuffer(stderr) ? stderr : Buffer.from(String(stderr));
  return {
    passed: exitCode === verification.expectedExitCode,
    exitCode,
    expectedExitCode: verification.expectedExitCode,
    signal,
    timedOut,
    elapsedMs: performance.now() - started,
    stdout: {bytes: outBuffer.length, sha256: hash(outBuffer)},
    stderr: {bytes: errBuffer.length, sha256: hash(errBuffer)},
    commandSha256: hash(verification.command),
    argsSha256: hash(JSON.stringify(verification.args)),
  };
}

async function readReceipts(workspace, sessionId, stateDirectory) {
  const result = {stateDirectoryAvailable: typeof stateDirectory === 'string', correlatedInvocationCount: 0, receipts: []};
  if (typeof stateDirectory !== 'string' || typeof sessionId !== 'string') return result;
  try {
    const workspacePath = await realpath(workspace);
    const receiptDir = join(resolve(stateDirectory), 'decision-hook-v1', hash(workspacePath), hash(sessionId), 'invocations');
    const entries = await readdir(receiptDir, {withFileTypes: true});
    for (const entry of entries.filter(item => item.isFile() && /^[a-f0-9]{64}\.json$/.test(item.name)).slice(0, 200)) {
      try {
        const invocation = JSON.parse(await readFile(join(receiptDir, entry.name), 'utf8'));
        if (invocation?.sessionHash !== hash(sessionId)) continue;
        result.correlatedInvocationCount += 1;
        let provider;
        if (/^[a-f0-9-]{36}$/.test(invocation.referenceReceiptId ?? '')) {
          provider = JSON.parse(await readFile(join(resolve(stateDirectory), 'receipts', `${invocation.referenceReceiptId}.json`), 'utf8'));
        }
        result.receipts.push({
          event: typeof invocation.event === 'string' ? invocation.event : undefined,
          referenceReceiptId: /^[a-f0-9-]{36}$/.test(invocation.referenceReceiptId ?? '') ? invocation.referenceReceiptId : undefined,
          assessmentStatus: typeof invocation.assessmentStatus === 'string' ? invocation.assessmentStatus : undefined,
          reasonCode: typeof invocation.reasonCode === 'string' ? invocation.reasonCode : undefined,
          providerStatus: typeof provider?.status === 'string' ? provider.status : undefined,
          providerReasonCode: typeof provider?.reasonCode === 'string' ? provider.reasonCode : undefined,
          responseStatus: Number.isInteger(provider?.transport?.responseStatus) ? provider.transport.responseStatus : undefined,
          validatedResponse: provider?.transport?.validatedResponse === true,
          providerRequestIdPresent: typeof provider?.transport?.providerRequestId === 'string' && provider.transport.providerRequestId.length > 0,
        });
      } catch {
        // A malformed receipt cannot become positive benchmark evidence.
      }
    }
  } catch {
    // Missing local receipt storage is recorded as zero correlated receipts.
  }
  return result;
}

export function summarizeEvents(events, threadId) {
  const relevant = events.filter(event => event.threadId === threadId);
  const toolCounts = {};
  const hooks = [];
  const tokenUsage = [];
  for (const event of relevant) {
    if (event.item) {
      const key = [event.item.type, event.item.server, event.item.tool, event.item.namespace].filter(Boolean).join(':');
      toolCounts[key] = (toolCounts[key] ?? 0) + 1;
    }
    if (event.hook) hooks.push(event.hook);
    if (event.usage) tokenUsage.push({method: event.method, turnId: event.turnId, usage: event.usage});
  }
  const receiptIds = [...new Set(hooks.flatMap(hook => hook.feedback.map(item => item.receiptId).filter(Boolean)))];
  const hookStatusCounts = {};
  for (const hook of hooks) hookStatusCounts[hook.status ?? 'unknown'] = (hookStatusCounts[hook.status ?? 'unknown'] ?? 0) + 1;
  const failedCommandCount = relevant.filter(event => event.item?.type === 'commandExecution' && event.item?.status === 'failed').length;
  return {
    toolCounts,
    failedCommandCount,
    tokenUsage,
    hooks,
    hookSummary: {
      count: hooks.length,
      durationMs: hooks.reduce((sum, hook) => sum + (hook.durationMs ?? 0), 0),
      statusCounts: hookStatusCounts,
      receiptIds,
    },
  };
}

async function listModels(server) {
  const models = [];
  let cursor = null;
  for (let page = 0; page < 5; page += 1) {
    const response = await server.rpc('model/list', {limit: 100, includeHidden: false, cursor});
    models.push(...(response?.data ?? []));
    cursor = response?.nextCursor ?? null;
    if (!cursor) break;
  }
  return models;
}

function validateRuntimeIsolation(arm, hooks, mcp, configNames) {
  if (arm === 'baseline') assert.equal(hooks.some(hook => hook.enabled), false, 'Baseline exposed an enabled Jev hook');
  else {
    assert.ok(hooks.length > 0, 'Treatment loaded no Jev hooks');
    assert.equal(hooks.every(hook => hook.enabled && hook.trustStatus === 'trusted'), true, 'Treatment requires every loaded Jev hook to be enabled and trusted');
  }
  const jevServers = mcp.filter(item => String(item.pluginId ?? '').includes('jev-workflows') || String(item.name ?? '').includes('jev-workflows'));
  const unexpectedPluginServers = mcp.filter(item => item.pluginId && !String(item.pluginId).includes('jev-workflows'));
  assert.deepEqual(unexpectedPluginServers, [], 'A non-Jev plugin MCP server was present in the isolated runtime inventory');
  const configuredMcpActive = mcp.filter(item => configNames.servers.includes(item.name) && /connected|ready|running|started/i.test(item.runtimeStatus ?? ''));
  assert.deepEqual(configuredMcpActive, [], 'A configured non-plugin MCP server remained active in the isolated runtime inventory');
  if (arm === 'baseline') assert.equal(jevServers.length, 0, 'Baseline runtime inventory exposed Jev MCP');
  else assert.equal(jevServers.length, 1, 'Treatment requires exactly one Jev MCP runtime');
  return jevServers;
}

function assertTreatmentPolicy(status) {
  assert.equal(status?.automation?.enabled, true, 'Treatment requires existing Jev automation to be enabled');
  assert.equal(status?.automation?.scope, 'all-workspaces', 'Treatment requires the existing all-workspaces automation scope');
  for (const key of ['maxHookCallsPerSession', 'maxCallsPerDay', 'maxBytesPerDay']) assert.equal(status?.automation?.[key], null, `Treatment requires unlimited ${key}`);
}

async function preflightArm({arm, workspace, configNames, settings}) {
  const record = {arm, startedAt: new Date().toISOString(), passed: false, scored: false};
  let server;
  try {
    await mkdir(workspace, {recursive: false, mode: 0o700});
    server = new AppServer({arm, cwd: workspace, configNames, turnTimeoutMs: settings.timeoutMs});
    await server.initialize();
    record.startup = {processToInitializedMs: server.initializedMs};
    const hooks = compactHookInventory((await server.rpc('hooks/list', {cwds: [workspace]}))?.data ?? []);
    record.hookInventory = hooks;
    const selected = chooseHostDefault(await listModels(server));
    if (settings.pinnedModel === undefined) {
      settings.pinnedModel = selected.model;
      settings.pinnedEffort = selected.effort;
    }
    assert.deepEqual(selected, {model: settings.pinnedModel, effort: settings.pinnedEffort}, 'Host-default model or effort differed between preflight arms');
    record.model = selected.model;
    record.effort = selected.effort ?? null;
    const started = await server.rpc('thread/start', {cwd: workspace, ephemeral: true, approvalPolicy: 'never', sandbox: 'workspace-write', model: selected.model});
    const threadId = started?.thread?.id;
    assert.equal(typeof threadId, 'string', 'Preflight thread/start returned no thread id');
    assert.equal(started?.thread?.ephemeral, true, 'Preflight thread was not ephemeral');
    const mcp = compactMcpInventory((await server.rpc('mcpServerStatus/list', {threadId, detail: 'full', limit: 200}))?.data ?? []);
    record.mcpInventory = mcp;
    const jevServers = validateRuntimeIsolation(arm, hooks, mcp, configNames);
    if (arm === 'treatment') {
      const marketplacePath = resolve(process.env.JEV_MARKETPLACE_PATH ?? join(homedir(), '.agents/plugins/marketplace.json'));
      const pluginRead = await server.rpc('plugin/read', {marketplacePath, pluginName: 'jev-workflows'});
      const summary = pluginRead?.plugin?.summary;
      assert.equal(summary?.installed, true, 'Treatment Jev plugin is not installed');
      record.installedJev = {
        id: typeof summary?.id === 'string' ? summary.id : undefined,
        localVersion: typeof summary?.localVersion === 'string' ? summary.localVersion : undefined,
        source: typeof summary?.source === 'string' ? summary.source : undefined,
        trustedHookHashes: hooks.map(hook => hook.currentHash).filter(Boolean).sort(),
      };
      const statusResult = await server.rpc('mcpServer/tool/call', {threadId, server: jevServers[0].name, tool: 'jev_status', arguments: {}});
      assertTreatmentPolicy(statusResult?.structuredContent);
      record.sharedAccountingSnapshot = {at: 'preflight', attributableToTrial: false, actualStateIsShared: true, value: compactAccounting(statusResult?.structuredContent)};
    }
    record.startup.readinessMs = performance.now() - server.spawnedAt;
    record.passed = true;
  } catch (error) {
    record.failure = {name: error?.name ?? 'Error', message: String(error?.message ?? error).slice(0, 500)};
  } finally {
    if (server) {
      await server.close();
      record.appServerStderr = server.stderrEvidence();
    }
    record.completedAt = new Date().toISOString();
  }
  return record;
}

async function discoverPluginIds({workspace, configNames, turnTimeoutMs}) {
  const record = {startedAt: new Date().toISOString(), passed: false, scored: false};
  let server;
  try {
    await mkdir(workspace, {recursive: false, mode: 0o700});
    server = new AppServer({arm: 'baseline', cwd: workspace, configNames, turnTimeoutMs});
    await server.initialize();
    const listed = await server.rpc('plugin/list', {cwds: [workspace], forceRefetch: false});
    const selected = chooseHostDefault(await listModels(server));
    const started = await server.rpc('thread/start', {cwd: workspace, ephemeral: true, approvalPolicy: 'never', sandbox: 'workspace-write', model: selected.model});
    const threadId = started?.thread?.id;
    assert.equal(typeof threadId, 'string', 'Plugin discovery thread/start returned no thread id');
    const mcp = compactMcpInventory((await server.rpc('mcpServerStatus/list', {threadId, detail: 'full', limit: 200}))?.data ?? []);
    const runtimePluginIds = mcp.map(item => item.pluginId).filter(id => typeof id === 'string');
    record.pluginIds = collectPluginIds(configNames.plugins, listed, mcp);
    record.runtimeMcpServerNames = collectRuntimeMcpServerNames(mcp);
    record.marketplaceCount = Array.isArray(listed?.marketplaces) ? listed.marketplaces.length : 0;
    record.marketplaceLoadErrorCount = Array.isArray(listed?.marketplaceLoadErrors) ? listed.marketplaceLoadErrors.length : 0;
    record.runtimePluginIds = [...new Set(runtimePluginIds)].sort();
    assert.deepEqual(record.runtimePluginIds, [], 'Private CODEX_HOME discovery exposed a plugin runtime before arm preflight');
    record.passed = true;
  } catch (error) {
    record.failure = {name: error?.name ?? 'Error', message: String(error?.message ?? error).slice(0, 500)};
  } finally {
    if (server) {
      await server.close();
      record.appServerStderr = server.stderrEvidence();
    }
    record.completedAt = new Date().toISOString();
  }
  return record;
}

async function buildArtifactManifest(tasks, tasksPath) {
  const artifacts = new Map();
  for (const task of tasks) for (const arg of task.verification.args) {
    if (!isAbsolute(arg) || artifacts.has(arg)) continue;
    try {
      const contents = await readFile(arg);
      artifacts.set(arg, {pathSha256: hash(arg), sha256: hash(contents), bytes: contents.length});
    } catch {
      // Runtime verification will record a missing oracle artifact as failure.
    }
  }
  const runnerContents = await readFile(fileURLToPath(import.meta.url));
  return {
    runner: {sha256: hash(runnerContents), bytes: runnerContents.length},
    tasks: {sha256: hash(await readFile(tasksPath))},
    oracleArtifacts: [...artifacts.values()].sort((a, b) => a.pathSha256.localeCompare(b.pathSha256)),
  };
}

async function runTrial({entry, task, workspace, configNames, settings, appendTrial}) {
  const trial = {
    schemaVersion: SCHEMA_VERSION,
    runnerVersion: RUNNER_VERSION,
    trialId: entry.trialId,
    taskId: entry.taskId,
    repeat: entry.repeat,
    arm: entry.arm,
    pairIndex: entry.pairIndex,
    armPosition: entry.armPosition,
    workspace: relative(settings.outputPath, workspace),
    scratchOwner: RUNNER_VERSION,
    cleanup: 'retained as private benchmark evidence',
    startedAt: new Date().toISOString(),
    agentTurnSuccess: false,
  };
  const overallStarted = performance.now();
  let server;
  let stateDirectory;
  let sessionId;
  let threadId;
  try {
    await writeFixture(workspace, task.files);
    server = new AppServer({arm: entry.arm, cwd: workspace, configNames, turnTimeoutMs: settings.timeoutMs});
    await server.initialize();
    trial.startup = {processToInitializedMs: server.initializedMs};

    const hooks = compactHookInventory((await server.rpc('hooks/list', {cwds: [workspace]}))?.data ?? []);
    trial.hookInventory = hooks;
    if (entry.arm === 'treatment') {
      assert.deepEqual(hooks.map(hook => hook.currentHash).filter(Boolean).sort(), settings.expectedTreatmentHookHashes, 'Treatment hook hashes drifted after preflight');
    }

    const selected = chooseHostDefault(await listModels(server));
    if (settings.pinnedModel === undefined) {
      settings.pinnedModel = selected.model;
      settings.pinnedEffort = selected.effort;
    }
    assert.deepEqual(selected, {model: settings.pinnedModel, effort: settings.pinnedEffort}, 'Host-default model or effort changed during the paired run');
    trial.model = settings.pinnedModel;
    trial.effort = settings.pinnedEffort ?? null;

    const started = await server.rpc('thread/start', {
      cwd: workspace,
      ephemeral: true,
      approvalPolicy: 'never',
      sandbox: 'workspace-write',
      model: settings.pinnedModel,
    });
    threadId = started?.thread?.id;
    sessionId = started?.thread?.sessionId;
    assert.equal(typeof threadId, 'string', 'thread/start returned no thread id');
    assert.equal(started?.thread?.ephemeral, true, 'Benchmark thread was not ephemeral');

    const mcp = compactMcpInventory((await server.rpc('mcpServerStatus/list', {threadId, detail: 'full', limit: 200}))?.data ?? []);
    trial.mcpInventory = mcp;
    const jevServers = validateRuntimeIsolation(entry.arm, hooks, mcp, configNames);

    if (entry.arm === 'treatment') {
      const statusResult = await server.rpc('mcpServer/tool/call', {threadId, server: jevServers[0].name, tool: 'jev_status', arguments: {}});
      const status = statusResult?.structuredContent;
      stateDirectory = status?.stateDirectory;
      assertTreatmentPolicy(status);
      trial.sharedAccountingSnapshot = {at: 'pre-turn', attributableToTrial: false, actualStateIsShared: true, value: compactAccounting(status)};
    }
    trial.startup.readinessMs = performance.now() - server.spawnedAt;

    const prompts = [task.prompt, ...(task.followupPrompt === undefined ? [] : [task.followupPrompt])];
    trial.turns = [];
    for (let index = 0; index < prompts.length; index += 1) {
      const turnStartedAt = performance.now();
      let turnId;
      try {
        const response = await server.rpc('turn/start', {
          threadId,
          cwd: workspace,
          input: [{type: 'text', text: prompts[index], text_elements: []}],
          model: settings.pinnedModel,
          ...(settings.pinnedEffort ? {effort: settings.pinnedEffort} : {}),
          approvalPolicy: 'never',
          sandboxPolicy: {type: 'workspaceWrite', writableRoots: [workspace], networkAccess: true, excludeTmpdirEnvVar: false, excludeSlashTmp: false},
        });
        turnId = response?.turn?.id;
        assert.equal(typeof turnId, 'string', 'turn/start returned no turn id');
        const completion = await server.waitForTurn(threadId, turnId);
        trial.turns.push({index: index + 1, id: turnId, status: completion.status, elapsedMs: performance.now() - turnStartedAt, usage: completion.usage});
        if (completion.status !== 'completed') break;
      } catch (error) {
        trial.turns.push({index: index + 1, id: turnId, status: error?.code === 'TURN_TIMEOUT' ? 'timeout' : 'error', elapsedMs: performance.now() - turnStartedAt});
        throw error;
      }
    }
    trial.agentTurnSuccess = trial.turns.length === prompts.length && trial.turns.every(turn => turn.status === 'completed');

    Object.assign(trial, summarizeEvents(server.events, threadId));
    if (entry.arm === 'treatment') trial.localReceipts = await readReceipts(workspace, sessionId, stateDirectory);
  } catch (error) {
    trial.failure = {
      stage: trial.turns ? 'turn_or_postflight' : server ? 'startup_or_preflight' : 'fixture_or_spawn',
      code: typeof error?.code === 'string' ? error.code : undefined,
      name: error?.name ?? 'Error',
      message: String(error?.message ?? error).slice(0, 500),
    };
    if (server && threadId) Object.assign(trial, summarizeEvents(server.events, threadId));
  } finally {
    if (server) {
      await server.close();
      trial.appServerStderr = server.stderrEvidence();
    }
    trial.oracle = trial.turns === undefined
      ? {notRun: true, reason: 'infrastructure_failure_before_turn'}
      : await runOracle(task.verification, workspace);
    trial.overallElapsedMs = performance.now() - overallStarted;
    trial.completedAt = new Date().toISOString();
    await appendTrial(trial);
  }
  return trial;
}

async function appendJsonLine(path, value) {
  const handle = await open(path, fsConstants.O_APPEND | fsConstants.O_CREAT | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW, 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function executeBenchmark(options, isolation) {
  const tasksPath = await realpath(options.tasksPath);
  const document = validateTaskDocument(JSON.parse(await readFile(tasksPath, 'utf8')));
  const outputPath = resolve(options.outputPath);
  await mkdir(outputPath, {recursive: false, mode: 0o700});
  await chmod(outputPath, 0o700);
  const scratchPath = join(outputPath, 'scratch');
  await mkdir(scratchPath, {recursive: false, mode: 0o700});
  const plan = buildPlan(document.tasks, options.repeats, options.seed);
  const tasksDirectory = dirname(tasksPath);
  const resolvedTasks = document.tasks.map(task => ({...task, verification: {
    ...task.verification,
    command: task.verification.command === '$NODE' ? process.execPath : task.verification.command,
    args: task.verification.args.map(arg => arg.replaceAll('$TASKS_DIR', tasksDirectory)),
  }}));
  for (const task of resolvedTasks) {
    assert.equal(isAbsolute(task.verification.command), true, `Resolved oracle command is not absolute for ${task.id}`);
    assert.equal(task.verification.args.some(arg => arg.includes('$TASKS_DIR')), false, `Unresolved $TASKS_DIR macro for ${task.id}`);
  }
  const taskById = new Map(resolvedTasks.map(task => [task.id, task]));
  const configNames = {servers: [], plugins: ['jev-workflows@personal'], codexHome: isolation.path};
  const artifactManifest = await buildArtifactManifest(resolvedTasks, tasksPath);
  const planEvidence = {
    schemaVersion: SCHEMA_VERSION,
    runnerVersion: RUNNER_VERSION,
    createdAt: new Date().toISOString(),
    artifacts: artifactManifest,
    taskCount: document.tasks.length,
    repeats: options.repeats,
    seed: options.seed,
    trialCount: plan.length,
    timeoutMs: options.timeoutMs,
    oracleTimeoutMs: ORACLE_TIMEOUT_MS,
    configuredMcpServerCount: configNames.servers.length,
    configuredPluginCount: configNames.plugins.length,
    isolation: {
      appsDisabled: true,
      remotePluginsDisabled: true,
      configuredMcpServersDisabled: true,
      baselineAllPluginsDisabled: true,
      baselineJevCredentialsRemoved: [...JEV_ENV_KEYS],
      treatmentOnlyJevPluginEnabled: true,
      installedAndRuntimePluginDiscoveryBeforePreflight: true,
      projectInstructionsDisabled: true,
      treatmentUsesInstalledSharedJevState: true,
      privateCodexHome: true,
      authSymlinkOnly: true,
      isolatedInstalledJevVersion: isolation.pluginVersion,
      isolatedTrustedHookCount: isolation.trustedHookCount,
      approvalPolicy: 'never',
      sandbox: 'workspace-write',
      networkAccess: true,
    },
    plan,
  };
  await writeFile(join(outputPath, 'plan.json'), `${JSON.stringify(planEvidence, null, 2)}\n`, {mode: 0o600, flag: 'wx'});
  const settings = {outputPath, timeoutMs: options.timeoutMs, pinnedModel: undefined, pinnedEffort: undefined};
  const discovery = await discoverPluginIds({workspace: join(outputPath, 'plugin-discovery'), configNames, turnTimeoutMs: options.timeoutMs});
  await writeFile(join(outputPath, 'plugin-discovery.json'), `${JSON.stringify({schemaVersion: SCHEMA_VERSION, runnerVersion: RUNNER_VERSION, ...discovery}, null, 2)}\n`, {mode: 0o600, flag: 'wx'});
  if (!discovery.passed) {
    await writeFile(join(outputPath, 'report.json'), `${JSON.stringify({
      schemaVersion: SCHEMA_VERSION,
      runnerVersion: RUNNER_VERSION,
      status: 'plugin_discovery_failed',
      completedAt: new Date().toISOString(),
      counts: {plannedTrials: plan.length, scoredTrials: 0, notRunInfrastructure: plan.length},
      discovery,
      failuresIncludedInQualityDenominator: false,
    }, null, 2)}\n`, {mode: 0o600, flag: 'wx'});
    throw new Error('Non-scored plugin discovery failed; no benchmark trials were started');
  }
  configNames.plugins = [...new Set(discovery.pluginIds)];
  const preflightPath = join(outputPath, 'preflight');
  await mkdir(preflightPath, {recursive: false, mode: 0o700});
  const preflight = [];
  for (const arm of ['baseline', 'treatment']) {
    const record = await preflightArm({arm, workspace: join(preflightPath, arm), configNames, settings});
    preflight.push(record);
    if (!record.passed) break;
  }
  await writeFile(join(outputPath, 'preflight.json'), `${JSON.stringify({schemaVersion: SCHEMA_VERSION, runnerVersion: RUNNER_VERSION, records: preflight}, null, 2)}\n`, {mode: 0o600, flag: 'wx'});
  if (preflight.length !== 2 || preflight.some(record => !record.passed)) {
    const report = {
      schemaVersion: SCHEMA_VERSION,
      runnerVersion: RUNNER_VERSION,
      status: 'preflight_failed',
      completedAt: new Date().toISOString(),
      counts: {plannedTrials: plan.length, scoredTrials: 0, notRunInfrastructure: plan.length},
      preflight,
      failuresIncludedInQualityDenominator: false,
    };
    await writeFile(join(outputPath, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, {mode: 0o600, flag: 'wx'});
    throw new Error('Non-scored arm preflight failed; no benchmark trials were started');
  }
  settings.expectedTreatmentHookHashes = preflight.find(record => record.arm === 'treatment').hookInventory.map(hook => hook.currentHash).filter(Boolean).sort();
  if (options.preflightOnly) {
    const report = {
      schemaVersion: SCHEMA_VERSION,
      runnerVersion: RUNNER_VERSION,
      status: 'preflight_completed',
      completedAt: new Date().toISOString(),
      model: settings.pinnedModel ?? null,
      effort: settings.pinnedEffort ?? null,
      counts: {plannedTrials: plan.length, scoredTrials: 0, notRunByRequest: plan.length},
      discovery,
      preflight,
    };
    await writeFile(join(outputPath, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, {mode: 0o600, flag: 'wx'});
    process.stdout.write(`${JSON.stringify({status: report.status, outputDirectory: outputPath, counts: report.counts})}\n`);
    return;
  }
  const trials = [];
  let infrastructureAbort = null;
  for (const entry of plan) {
    const workspace = join(scratchPath, entry.trialId);
    const trial = await runTrial({
      entry,
      task: taskById.get(entry.taskId),
      workspace,
      configNames,
      settings,
      appendTrial: value => appendJsonLine(join(outputPath, 'trials.jsonl'), value),
    });
    trials.push(trial);
    if (isInfrastructureFailure(trial)) {
      infrastructureAbort = {trialId: trial.trialId, failure: trial.failure};
      break;
    }
  }
  const qualityTrials = trials.filter(trial => !isInfrastructureFailure(trial));
  const report = {
    schemaVersion: SCHEMA_VERSION,
    runnerVersion: RUNNER_VERSION,
    completedAt: new Date().toISOString(),
    outputDirectory: outputPath,
    model: settings.pinnedModel ?? null,
    effort: settings.pinnedEffort ?? null,
    preflight,
    status: infrastructureAbort ? 'infrastructure_aborted' : 'completed',
    counts: {
      plannedTrials: plan.length,
      startedTrials: trials.length,
      qualityTrials: qualityTrials.length,
      notRunInfrastructure: plan.length - trials.length,
      infrastructureFailures: trials.length - qualityTrials.length,
      agentTurnSuccess: qualityTrials.filter(trial => trial.agentTurnSuccess).length,
      oraclePassed: qualityTrials.filter(trial => trial.oracle?.passed).length,
      pairedTaskRepeats: plan.length / 2,
    },
    byArm: Object.fromEntries(['baseline', 'treatment'].map(arm => {
      const armTrials = trials.filter(trial => trial.arm === arm);
      const qualityArmTrials = armTrials.filter(trial => !isInfrastructureFailure(trial));
      return [arm, {startedTrials: armTrials.length, qualityTrials: qualityArmTrials.length, agentTurnSuccess: qualityArmTrials.filter(trial => trial.agentTurnSuccess).length, oraclePassed: qualityArmTrials.filter(trial => trial.oracle?.passed).length}];
    })),
    infrastructureAbort,
    taskLevelFailuresIncludedInQualityDenominator: true,
    infrastructureFailuresExcludedFromQualityDenominator: true,
    adaptiveRetries: 0,
    scratch: {owner: RUNNER_VERSION, path: 'scratch', disposition: 'retained as private evidence'},
    limitations: [
      'This paired run estimates behavior only for the preregistered tasks, host-default model and effort, and local Codex/plugin versions recorded by the run.',
      'Network access is identical in both workspace-write arms because the Jev treatment needs provider access; approval policy remains never and no sandbox escalation is accepted.',
      'Local Jev accounting is a best-effort snapshot of retained local receipts and reservations, not provider billing reconciliation.',
      'The installed host package pins a shared Jev state directory. Global accounting snapshots are explicitly non-attributable; only unique thread/session and workspace-correlated receipt IDs are treated as trial-local evidence.',
      'Hook time can overlap model or tool activity; summed hook duration is descriptive and must not be subtracted from turn wall time.',
      'Oracle stdout and stderr are represented by byte counts and SHA-256 digests; private oracle text is not copied into the report.',
      'A completed agent turn and an oracle pass are separate outcomes; every started trial remains in the denominator.',
      'The run disables project instruction discovery, apps, remote plugins, configured MCP servers, and configured plugins except Jev in treatment; user-owned base instructions outside project discovery may still be shared by both arms.',
    ],
  };
  await writeFile(join(outputPath, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, {mode: 0o600, flag: 'wx'});
  process.stdout.write(`${JSON.stringify({status: report.status, outputDirectory: outputPath, counts: report.counts, byArm: report.byArm})}\n`);
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const isolation = await createIsolatedCodexHome();
  try {
    return await executeBenchmark(options, isolation);
  } finally {
    await rm(isolation.path, {recursive: true, force: true});
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  main().catch(error => {
    process.stderr.write(`paired-codex-benchmark failed: ${String(error?.message ?? error).slice(0, 500)}\n`);
    process.exitCode = 1;
  });
}
