#!/usr/bin/env node

import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFile, spawn} from 'node:child_process';
import {
  chmod,
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import {homedir} from 'node:os';
import {basename, dirname, isAbsolute, join, relative, resolve, sep} from 'node:path';
import {createInterface} from 'node:readline';
import {pathToFileURL} from 'node:url';

const RUNTIME_SCHEMA = 'plugin-value-runtime-v1';
const PLUGIN_ID = 'jev-workflows@personal';
const PLUGIN_DIRECTORY = '0.4.0+codex.20260926072321';
const RPC_TIMEOUT_MS = 30_000;
const INITIALIZE_TIMEOUT_MS = 90_000;
const JEV_FORWARD_ENV_KEYS = ['TYPESAFE_API_KEY', 'JEV_API_KEY_FILE'];
const FORBIDDEN_CREDENTIAL_ENV_KEYS = [
  ...JEV_FORWARD_ENV_KEYS,
  'JEV_API_KEY',
  'OPENAI_API_KEY',
  'CODEX_ACCESS_TOKEN',
];
const JEV_TOOL_NAMES = Object.freeze([
  'check_completion',
  'classify_decision',
  'classify_failure',
  'configure_automation',
  'evaluate_decisions',
  'jev_status',
  'record_decision_outcome',
  'update_task_context',
]);
const ALLOWED_RPC_METHODS = new Set([
  'initialize',
  'environment/status',
  'environment/info',
  'hooks/list',
  'thread/start',
  'mcpServerStatus/list',
  'mcpServer/tool/call',
  'turn/start',
]);
const PINNED_SOURCE_HASHES = Object.freeze({
  '.codex-plugin/plugin.json': '0c09fb93dd0115a6fbb4aa14c80daabf5671033a2aac31619a9769dd90b37263',
  '.gitignore': '14a52462f9c1e71e25845771a0782a0de2a72b7d3798a5d60c865eeb9893679b',
  '.mcp.json': '4aa483173c3f385e529d3d3592f4ec37c29d54049401fa58bb9184753282f108',
  'HOST-COMPATIBILITY.json': '9fa57855d3420a9b2be3bb704949924252477c2065f89a22086fa0df599bc8a2',
  'LICENSE': '90f9b49ccfa673a6952b0b9cfb6a88a0131c2b93d0c4cbfa03f7d5ba35873b26',
  'README.md': '8290228fd74ae48fef4f35619457cfca8362c8c738753d5ba586b2a3eeaa02b4',
  'assets/jev-workflows-mark.png': '639eae33a18a096aa844eea13c038eae05b1a324c151632c9ca9e2050ff74087',
  'assets/jev-workflows-mark.svg': 'e0d12092e7456b037793b2f8de8d5a5248ce7825ffd290eee5e527d816096e71',
  'dist/cli.mjs': '9f4b7a3f639ff1726e04647ebc6f9a97aa475a2a61b660d2095635d5b40e25db',
  'hooks/hooks.json': 'ae764c24df9f35917f5a8b0728f66d19e333399963e66faf738733167e2b8592',
  'dist/decision-hook.mjs': 'cbbe3150a0996b18737526a284c3d979430315ce4e459e89edcc17618439c10f',
  'dist/hook.mjs': '205d545ff8437d6d4595e787e04c24d5136db2626e7ad0d3a0b6cbea2720d6bd',
  'dist/server.mjs': '88913f614e6bbf0da4637877fb1aef6f5d6cb9bbbbdecaed1f3566a280438064',
  'docs/accounting.md': '7e8abc9e25d5b5842581ca873b4d85e9b50cf222679bf54502a566f5365da35e',
  'docs/compatibility.md': '51ee43f12595180cd0cc7b9fbb5484e14414e28352d8877f24b5ef207638fd06',
  'docs/distribution.md': 'ad5154e7343a334ac25dfdc73406368b7494ab08cc0792f9d5ffd8f3a769b8c2',
  'docs/fixture-rationale.md': '5992a01f2a5f67ed198e01bc682fa43c5960fd05cf642994d1a3ced5836b6acf',
  'docs/privacy.md': 'a0a97d77f733997435517be59cf751a8c7d936555836e05e7616388558938887',
  'docs/publication.md': 'b08012ebd39d164ce141836759eb121afa002da6d5a97f99c63c341ff02c096a',
  'docs/reviewer-cases.md': '03a302151dec2d5aed75fc839bcbcd2fff50452eddbe79227d19dd4cd7489154',
  'docs/terms.md': '7c4bc559d94a81b69eb6c6e4b7706398b5300a227c98a59948aba27287fbb4ff',
  'skills/check-completion/SKILL.md': '7a9bc3ac4ed186857a5a5b704398e53a775a37c6b715c8e4856e6af1d9d4caa3',
  'skills/check-completion/references/standalone.md': '046a2dca022b61d2ad8c17b5d803c018fcfeeb19d9d2d33d9b968606446501f8',
  'skills/check-completion/scripts/jev.mjs': '9f4b7a3f639ff1726e04647ebc6f9a97aa475a2a61b660d2095635d5b40e25db',
  'skills/classify-decision/SKILL.md': 'eefa7df798b393173b961e1abc3ff81db85fa5a58d3161d9029620177d86ddd1',
  'skills/classify-decision/references/standalone.md': 'ade260df533c67bfdf8632d338b3805de438433d5fe57c708a034596f761f119',
  'skills/classify-decision/scripts/jev.mjs': '9f4b7a3f639ff1726e04647ebc6f9a97aa475a2a61b660d2095635d5b40e25db',
  'skills/diagnose-failure/SKILL.md': '14b0670514691b6c6922cfdfeadb2eefe8817f6d8cb7b12d9da0fb7de637211e',
  'skills/diagnose-failure/references/standalone.md': '72c597efa3b0b2ee68e4de4832e09af4510cc2dfc845952f949b4559ef1af099',
  'skills/diagnose-failure/scripts/jev.mjs': '9f4b7a3f639ff1726e04647ebc6f9a97aa475a2a61b660d2095635d5b40e25db',
});

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function tomlString(value) {
  return JSON.stringify(value);
}

function tomlStringArray(values) {
  return `[${values.map(tomlString).join(', ')}]`;
}

export function validateRequest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('request must be an object');
  if (value.schemaVersion !== RUNTIME_SCHEMA) throw new Error(`schemaVersion must be ${RUNTIME_SCHEMA}`);
  if (!['baseline', 'treatment'].includes(value.arm)) throw new Error('arm must be baseline or treatment');
  if (!/^[0-9a-f]{12,64}$/.test(value.containerId ?? '')) throw new Error('invalid container id');
  if (value.containerUser !== null && value.containerUser !== undefined && !/^[A-Za-z0-9_.:-]{1,128}$/.test(value.containerUser)) throw new Error('invalid container user');
  for (const key of ['dockerPath', 'nodePath', 'codexPath', 'logsDir', 'runtimeHome']) {
    if (typeof value[key] !== 'string' || !value[key].startsWith('/')) throw new Error(`${key} must be absolute`);
  }
  for (const key of ['dockerSha256', 'nodeSha256', 'codexSha256']) {
    if (!/^[0-9a-f]{64}$/.test(value[key] ?? '')) throw new Error(`${key} must be a SHA-256 digest`);
  }
  if (typeof value.instruction !== 'string' || value.instruction.length === 0 || Buffer.byteLength(value.instruction) > 2_000_000) throw new Error('instruction must be a bounded non-empty string');
  if (value.model !== 'gpt-6-astra') throw new Error('model must be gpt-6-astra');
  if (value.effort !== 'medium') throw new Error('effort must be medium');
  if (value.remoteCwd !== '/app') throw new Error('remoteCwd must be /app');
  if (value.hostCwd !== join(resolve(value.logsDir), 'workspace')) throw new Error('hostCwd must be the host-control workspace path');
  if (value.runtimeHome !== join(resolve(value.logsDir), 'runtime-home')) throw new Error('runtimeHome must be the host-control runtime path');
  if (!Number.isSafeInteger(value.turnTimeoutMs) || value.turnTimeoutMs < 1_000 || value.turnTimeoutMs > 10_790_000) throw new Error('invalid turn timeout');
  if (typeof value.preflightOnly !== 'boolean') throw new Error('preflightOnly must be boolean');
  return {...value};
}

function execFilePromise(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    execFile(command, args, {encoding: 'utf8', maxBuffer: 4_000_000, ...options}, (error, stdout, stderr) => {
      if (error) reject(Object.assign(error, {stdout, stderr}));
      else resolvePromise({stdout, stderr});
    });
  });
}

async function fileSha256(path) {
  return sha256(await readFile(path));
}

export async function verifyHostRuntimeIdentity(request, environment = process.env) {
  assert.equal(process.version, 'v22.23.2', 'host Node version drifted');
  assert.equal(await realpath(process.execPath), await realpath(request.nodePath), 'host Node executable path drifted');
  const nodeSha256 = await fileSha256(request.nodePath);
  assert.equal(nodeSha256, request.nodeSha256, 'host Node executable hash drifted');
  const codexSha256 = await fileSha256(request.codexPath);
  assert.equal(codexSha256, request.codexSha256, 'host Codex executable hash drifted');
  const codexVersion = (await execFilePromise(request.codexPath, ['--version'])).stdout.trim();
  assert.equal(codexVersion, 'codex-cli 0.155.0', 'host Codex version drifted');
  const dockerSha256 = await fileSha256(request.dockerPath);
  assert.equal(dockerSha256, request.dockerSha256, 'host Docker executable hash drifted');
  const dockerVersion = (await execFilePromise(request.dockerPath, ['--version'])).stdout.trim();
  assert.match(dockerVersion, /^Docker version 29\.7\.1,/, 'host Docker version drifted');
  const [controlledBin] = String(environment.PATH ?? '').split(':');
  assert.equal(await realpath(join(controlledBin, 'node')), await realpath(request.nodePath), 'plugin PATH does not resolve node to the pinned executable');
  const pluginNodeVersion = (await execFilePromise('/usr/bin/env', ['node', '--version'], {
    env: {PATH: environment.PATH},
  })).stdout.trim();
  assert.equal(pluginNodeVersion, 'v22.23.2', 'plugin PATH Node version drifted');
  return {
    nodeVersion: process.version,
    nodeSha256,
    codexVersion,
    codexSha256,
    dockerVersion,
    dockerSha256,
    pluginNodeVersion,
  };
}

async function pluginFileInventory(source, relativeDirectory = '') {
  const directory = join(source, relativeDirectory);
  const entries = await readdir(directory, {withFileTypes: true});
  const files = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
    const metadata = await lstat(join(source, relativePath));
    if (metadata.isSymbolicLink()) throw new Error(`installed Jev 0.4.0 contains a symlink: ${relativePath}`);
    if (metadata.isDirectory()) files.push(...await pluginFileInventory(source, relativePath));
    else if (metadata.isFile()) files.push(relativePath);
    else throw new Error(`installed Jev 0.4.0 contains an unsupported entry: ${relativePath}`);
  }
  return files;
}

export async function verifyPinnedPlugin(source, expectedHashes = PINNED_SOURCE_HASHES) {
  const actualFiles = (await pluginFileInventory(source))
    .filter(path => path !== '.DS_Store')
    .sort();
  assert.deepEqual(actualFiles, Object.keys(expectedHashes).sort(), 'installed Jev 0.4.0 file inventory drifted');
  const observed = {};
  for (const [path, expected] of Object.entries(expectedHashes)) {
    const digest = await fileSha256(join(source, path));
    if (digest !== expected) throw new Error(`installed Jev 0.4.0 hash mismatch: ${path}`);
    observed[path] = digest;
  }
  return observed;
}

export async function replaceStateDirectory(pluginRoot, stateDirectory) {
  const mcpPath = join(pluginRoot, '.mcp.json');
  const hooksPath = join(pluginRoot, 'hooks', 'hooks.json');
  const mcp = JSON.parse(await readFile(mcpPath, 'utf8'));
  const oldState = mcp?.mcpServers?.['jev-workflows']?.env?.JEV_STATE_DIRECTORY;
  if (typeof oldState !== 'string' || !oldState.startsWith('/')) throw new Error('plugin MCP state directory is invalid');
  for (const path of [mcpPath, hooksPath]) {
    const before = await readFile(path, 'utf8');
    const occurrences = before.split(oldState).length - 1;
    if (occurrences < 1) throw new Error(`plugin state path missing from ${basename(path)}`);
    const after = before.split(oldState).join(stateDirectory);
    await writeFile(path, after, {encoding: 'utf8', mode: 0o600});
  }
  return oldState;
}

export function buildEnvironmentsToml(request) {
  const dockerArgs = [
    '-i',
    'PATH=/usr/local/bin:/usr/bin:/bin',
    'HOME=/tmp/codex-exec-launcher',
    request.dockerPath,
    'exec',
    '-i',
    ...(request.containerUser ? ['-u', request.containerUser] : []),
    request.containerId,
    '/usr/bin/env',
    '-i',
    'PATH=/usr/local/bin:/usr/bin:/bin',
    'HOME=/installed-agent/codex-exec-launcher',
    'CODEX_HOME=/installed-agent/codex-exec-home',
    '/usr/local/bin/codex',
    'exec-server',
    '--listen',
    'stdio',
  ];
  return [
    'default = "deep-swe"',
    'include_local = true',
    '',
    '[[environments]]',
    'id = "deep-swe"',
    'program = "/usr/bin/env"',
    `args = ${tomlStringArray(dockerArgs)}`,
    'initialize_timeout_sec = 30',
    '',
  ].join('\n');
}

export function buildConfigToml(request, trustedHooks = []) {
  const lines = [
    `model = ${tomlString(request.model)}`,
    `model_reasoning_effort = ${tomlString(request.effort)}`,
    'project_doc_max_bytes = 0',
    '',
    '[features]',
    'apps = false',
    'remote_plugin = false',
    `plugins = ${request.arm === 'treatment' ? 'true' : 'false'}`,
    '',
    '[shell_environment_policy]',
    'inherit = "none"',
    'ignore_default_excludes = false',
    'include_only = ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_*", "TERM", "TMPDIR", "TEMP", "TMP"]',
    '',
    '[shell_environment_policy.set]',
    'PATH = "/usr/local/bin:/usr/bin:/bin"',
    'HOME = "/tmp/codex-task-home"',
    'LANG = "C.UTF-8"',
    '',
  ];
  if (request.arm === 'treatment') {
    lines.push(`[plugins.${tomlString(PLUGIN_ID)}]`, 'enabled = true', '');
    for (const hook of trustedHooks) {
      lines.push(`[hooks.state.${tomlString(hook.key)}]`, `trusted_hash = ${tomlString(hook.currentHash)}`, '');
    }
  }
  return lines.join('\n');
}

function appServerEnvironment(arm, codexHome) {
  const safe = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'TMPDIR'];
  const env = Object.fromEntries(safe.flatMap(key => process.env[key] === undefined ? [] : [[key, process.env[key]]]));
  env.CODEX_HOME = codexHome;
  if (arm === 'treatment') {
    for (const key of JEV_FORWARD_ENV_KEYS) if (process.env[key] !== undefined) env[key] = process.env[key];
    env.JEV_ENABLED = '1';
    env.JEV_HOOKS_ENABLED = '1';
  }
  return env;
}

class AppServer {
  constructor({request, codexHome, hostShadow}) {
    this.request = request;
    this.pending = new Map();
    this.turnWaiters = new Map();
    this.turnCompletions = new Map();
    this.events = [];
    this.nextId = 0;
    this.failure = null;
    this.closing = false;
    this.stderrBytes = 0;
    this.stderrHash = createHash('sha256');
    this.spawnedAt = performance.now();
    const args = ['app-server', '--stdio', '--strict-config', '--disable', 'apps', '--disable', 'remote_plugin', '-c', 'project_doc_max_bytes=0'];
    this.child = spawn(request.codexPath, args, {
      cwd: hostShadow,
      env: appServerEnvironment(request.arm, codexHome),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
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
    for (const value of this.pending.values()) { clearTimeout(value.timer); value.reject(error); }
    this.pending.clear();
    for (const value of this.turnWaiters.values()) { clearTimeout(value.timer); value.reject(error); }
    this.turnWaiters.clear();
  }

  handleLine(line) {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message.id !== undefined && message.method) {
      if (/requestApproval$/.test(message.method)) {
        this.send({id: message.id, result: {decision: 'decline'}});
        this.fail(new Error(`Unexpected approval request under approvalPolicy=never: ${String(message.method).slice(0, 200)}`));
      } else {
        this.send({id: message.id, error: {code: -32601, message: 'Benchmark harness does not grant server requests'}});
        this.fail(new Error(`Unexpected app-server request: ${String(message.method).slice(0, 200)}`));
      }
      return;
    }
    if (message.id !== undefined && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        const detail = typeof message.error.message === 'string' ? `: ${message.error.message.slice(0, 500)}` : '';
        pending.reject(new Error(`RPC ${pending.method} failed with code ${message.error.code ?? 'unknown'}${detail}`));
      }
      else pending.resolve(message.result);
      return;
    }
    this.capture(message);
  }

  capture(message) {
    if (typeof message?.method !== 'string') return;
    const threadId = message.params?.threadId;
    const turnId = message.params?.turnId ?? message.params?.turn?.id;
    if (message.method === 'hook/completed') {
      const run = message.params?.run ?? {};
      this.events.push({method: message.method, threadId, turnId, hook: {
        eventName: run.eventName,
        pluginId: run.pluginId,
        status: run.status,
        durationMs: run.durationMs,
      }});
    } else if (message.method === 'item/completed') {
      const item = message.params?.item ?? {};
      this.events.push({method: message.method, threadId, turnId, item: {
        type: item.type,
        status: item.status,
        exitCode: item.exitCode,
        server: item.server,
        tool: item.tool,
        pluginId: item.pluginId,
      }});
    } else if (/tokenUsage/i.test(message.method)) {
      this.events.push({method: message.method, threadId, turnId, usage: message.params});
    }
    if (message.method === 'turn/completed') {
      const completion = {
        id: message.params?.turn?.id,
        status: message.params?.turn?.status,
        usage: message.params?.turn?.usage,
      };
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
      if (!ALLOWED_RPC_METHODS.has(method)) return reject(new Error(`RPC method is outside the benchmark allowlist: ${method}`));
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
      clientInfo: {name: 'plugin_value_deepswe', title: 'Plugin value DeepSWE benchmark', version: '1.0.0'},
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
        reject(new Error(`Turn timed out after ${this.request.turnTimeoutMs}ms`));
      }, this.request.turnTimeoutMs);
      this.turnWaiters.set(key, {resolve: resolvePromise, reject, timer});
    });
  }

  async close() {
    this.closing = true;
    this.lines.close();
    if (!this.child.stdin.destroyed) this.child.stdin.end();
    if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill('SIGTERM');
    await new Promise(resolvePromise => {
      if (this.child.exitCode !== null || this.child.signalCode !== null) return resolvePromise();
      const timer = setTimeout(() => {
        if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill('SIGKILL');
        resolvePromise();
      }, 2_000);
      this.child.once('exit', () => { clearTimeout(timer); resolvePromise(); });
    });
  }

  stderrEvidence() {
    return {bytes: this.stderrBytes, sha256: this.stderrHash.digest('hex')};
  }
}

function flattenHooks(response) {
  const groups = Array.isArray(response?.data) ? response.data : [];
  return groups.flatMap(group => Array.isArray(group?.hooks) ? group.hooks : []);
}

function compactHooks(hooks) {
  return hooks.filter(hook => hook?.pluginId === PLUGIN_ID).map(hook => ({
    key: hook.key,
    eventName: hook.eventName,
    currentHash: hook.currentHash,
    enabled: hook.enabled,
    trustStatus: hook.trustStatus,
    pluginId: hook.pluginId,
  }));
}

function compactMcp(response) {
  const data = Array.isArray(response?.data) ? response.data : [];
  return data.map(item => {
    const tools = item?.tools && typeof item.tools === 'object' && !Array.isArray(item.tools) ? item.tools : {};
    for (const [name, tool] of Object.entries(tools)) assert.equal(tool?.name, name, `MCP tool identity mismatch for ${name}`);
    return {
      name: item?.name,
      pluginId: item?.pluginId,
      runtimeStatus: item?.runtimeStatus,
      authStatus: item?.authStatus,
      tools: Object.keys(tools).sort(),
    };
  });
}

function pathContains(ancestor, candidate) {
  const value = relative(resolve(ancestor), resolve(candidate));
  return value === '' || (!value.startsWith(`..${sep}`) && value !== '..' && !isAbsolute(value));
}

async function runtimeProtectedPaths() {
  const sourceHome = resolve(process.env.PLUGIN_VALUE_SOURCE_CODEX_HOME ?? process.env.CODEX_HOME ?? join(homedir(), '.codex'));
  const paths = [await realpath(sourceHome), await realpath(join(sourceHome, 'auth.json'))];
  const keyFile = process.env.JEV_API_KEY_FILE;
  if (typeof keyFile === 'string' && keyFile.startsWith('/')) {
    try {
      paths.push(await realpath(keyFile));
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      paths.push(resolve(keyFile));
    }
  }
  return paths;
}

async function createRuntimeHome(request) {
  const sourceHome = resolve(process.env.PLUGIN_VALUE_SOURCE_CODEX_HOME ?? process.env.CODEX_HOME ?? join(homedir(), '.codex'));
  const authSource = await realpath(join(sourceHome, 'auth.json'));
  const home = request.runtimeHome;
  await mkdir(home, {recursive: false, mode: 0o700});
  await chmod(home, 0o700);
  await symlink(authSource, join(home, 'auth.json'));
  const stateDirectory = join(home, 'jev-state');
  await mkdir(stateDirectory, {recursive: true, mode: 0o700});
  let sourceHashes = null;
  if (request.arm === 'treatment') {
    const sourcePlugin = resolve(process.env.PLUGIN_VALUE_PLUGIN_DIR ?? join(sourceHome, 'plugins', 'cache', 'personal', 'jev-workflows', PLUGIN_DIRECTORY));
    if (basename(sourcePlugin) !== PLUGIN_DIRECTORY) throw new Error(`Jev plugin directory must be ${PLUGIN_DIRECTORY}`);
    sourceHashes = await verifyPinnedPlugin(sourcePlugin);
    const target = join(home, 'plugins', 'cache', 'personal', 'jev-workflows', PLUGIN_DIRECTORY);
    await mkdir(dirname(target), {recursive: true, mode: 0o700});
    await cp(sourcePlugin, target, {recursive: true, dereference: true, preserveTimestamps: true});
    await rm(join(target, '.DS_Store'), {force: true});
    assert.deepEqual(await verifyPinnedPlugin(target), sourceHashes, 'copied Jev plugin tree drifted');
    await replaceStateDirectory(target, stateDirectory);
    await writeFile(join(stateDirectory, 'policy.json'), `${JSON.stringify({
      enabled: true,
      maxBytesPerDay: null,
      maxCallsPerDay: null,
      maxHookCallsPerSession: null,
      scope: 'all-workspaces',
      workspaces: [],
    }, null, 2)}\n`, {encoding: 'utf8', mode: 0o600});
  }
  await writeFile(join(home, 'environments.toml'), buildEnvironmentsToml(request), {encoding: 'utf8', mode: 0o600});
  await writeFile(join(home, 'config.toml'), buildConfigToml(request), {encoding: 'utf8', mode: 0o600});
  return {home, stateDirectory, sourceHashes};
}

async function trustTreatmentHooks(request, runtime, hostShadow) {
  if (request.arm !== 'treatment') return [];
  const server = new AppServer({request, codexHome: runtime.home, hostShadow});
  try {
    await server.initialize();
    const hooks = compactHooks(flattenHooks(await server.rpc('hooks/list', {cwds: [hostShadow]})));
    assert.equal(hooks.length, 12, 'treatment must expose exactly 12 Jev hooks');
    for (const hook of hooks) {
      assert.match(hook.key ?? '', /^jev-workflows@personal:/);
      assert.match(hook.currentHash ?? '', /^sha256:[a-f0-9]{64}$/);
    }
    await writeFile(join(runtime.home, 'config.toml'), buildConfigToml(request, hooks), {encoding: 'utf8', mode: 0o600});
    return hooks.map(({key, currentHash}) => ({key, currentHash}));
  } finally {
    await server.close();
  }
}

async function inspectContainer(request, protectedPaths) {
  const {stdout: versionOutput} = await execFilePromise(request.dockerPath, [
    'exec', ...(request.containerUser ? ['-u', request.containerUser] : []),
    request.containerId, '/usr/local/bin/codex', '--version',
  ]);
  assert.equal(versionOutput.trim(), 'codex-cli 0.155.0', 'task exec-server Codex version drifted');
  const {stdout} = await execFilePromise(request.dockerPath, ['inspect', request.containerId]);
  const [inspection] = JSON.parse(stdout);
  assert.equal(inspection?.HostConfig?.NetworkMode, 'none', 'task container must use network_mode none');
  assert.equal(Boolean(inspection?.HostConfig?.Privileged), false, 'task container must not be privileged');
  assert.notEqual(inspection?.HostConfig?.PidMode, 'host', 'task container must not share the host PID namespace');
  assert.notEqual(inspection?.HostConfig?.IpcMode, 'host', 'task container must not share the host IPC namespace');
  assert.equal((inspection?.HostConfig?.CapAdd ?? []).length, 0, 'task container must not add Linux capabilities');
  assert.equal((inspection?.HostConfig?.Devices ?? []).length, 0, 'task container must not expose host devices');
  assert.equal((inspection?.HostConfig?.DeviceRequests ?? []).length, 0, 'task container must not request host devices');
  const envNames = (inspection?.Config?.Env ?? []).map(item => String(item).split('=', 1)[0]);
  for (const key of FORBIDDEN_CREDENTIAL_ENV_KEYS) {
    assert.equal(envNames.includes(key), false, `task container exposes ${key}`);
  }
  for (const mount of inspection?.Mounts ?? []) {
    const source = String(mount?.Source ?? '');
    const destination = String(mount?.Destination ?? '');
    let resolvedSource = source;
    if (source.startsWith('/')) {
      try { resolvedSource = await realpath(source); } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
    }
    assert.equal(source === '/var/run/docker.sock' || destination === '/var/run/docker.sock' || source.endsWith('/docker.sock') || destination.endsWith('/docker.sock'), false, 'task container exposes Docker socket');
    assert.equal(protectedPaths.some(path => resolvedSource.startsWith('/') && (pathContains(resolvedSource, path) || pathContains(path, resolvedSource))), false, 'task container mount overlaps a protected host path');
    assert.equal(/(?:^|\/)(?:\.codex|codex-home|jev-state)(?:\/|$)/.test(destination), false, 'task container has a protected credential destination');
  }
  assert.equal(inspection?.Config?.WorkingDir, '/app', 'task container workdir must be /app');
  return {
    containerId: request.containerId.slice(0, 12),
    image: inspection?.Config?.Image,
    networkMode: inspection?.HostConfig?.NetworkMode,
    architecture: inspection?.Architecture ?? null,
    credentialEnvPresent: false,
    dockerSocketMounted: false,
    codexVersion: versionOutput.trim(),
    workingDirectory: inspection?.Config?.WorkingDir,
  };
}

function compactJevProbe(result) {
  const transport = result?.transport;
  return {
    status: result?.status,
    reasonCode: result?.reasonCode ?? null,
    receiptId: result?.receiptId,
    receiptPersisted: result?.receiptPersisted,
    model: result?.model,
    choice: result?.choice ?? null,
    recommendation: result?.recommendation ?? null,
    confidence: result?.confidence ?? null,
    latencyMs: result?.latencyMs ?? null,
    transport: transport && typeof transport === 'object' ? {
      fetchInvoked: transport.fetchInvoked,
      responseStatus: transport.responseStatus,
      validatedResponse: transport.validatedResponse,
      providerRequestIdPresent: typeof transport.providerRequestId === 'string' && transport.providerRequestId.length > 0,
    } : null,
  };
}

async function verifyTreatmentProviderCall(server, threadId, serverName) {
  const response = await server.rpc('mcpServer/tool/call', {
    threadId,
    server: serverName,
    tool: 'classify_decision',
    arguments: {
      domain: 'strategy',
      question: 'Which execution boundary is supported by the preflight evidence for this benchmark?',
      context: 'This is a setup-only transport check, not a repository task. The benchmark must keep reusable account and Jev credentials on the host while repository tools execute in an offline task container.',
      candidates: [
        {id: 'protected_host_control_plane', description: 'Keep authenticated Codex and Jev processes on the host and route repository tools through the secretless offline task container.'},
        {id: 'credentials_in_task_container', description: 'Place reusable Codex and Jev credentials inside the repository task container.'},
      ],
      evidence: [
        {id: 'container_network', text: 'Docker inspection reports network_mode none for the task container.', source: 'docker inspect'},
        {id: 'container_credentials', text: 'Docker inspection finds no Codex or Jev credential environment variables or credential mounts.', source: 'docker inspect'},
        {id: 'remote_executor', text: 'The configured Codex environment launches exec-server through env -i and docker exec -i.', source: 'environments.toml'},
      ],
      origin: {source: 'service', agentId: 'plugin_value_preflight'},
      mode: 'evaluate',
    },
  }, INITIALIZE_TIMEOUT_MS);
  const result = response?.structuredContent;
  assert.equal(['assessed', 'abstained'].includes(result?.status), true, `Jev provider probe ended as ${result?.status ?? 'missing'}`);
  assert.match(result?.receiptId ?? '', /^[a-f0-9-]{36}$/i, 'Jev provider probe returned no receipt id');
  assert.equal(result?.receiptPersisted, true, 'Jev provider probe receipt was not persisted');
  assert.equal(result?.transport?.fetchInvoked, true, 'Jev provider probe did not invoke fetch');
  assert.equal(result?.transport?.responseStatus, 200, 'Jev provider probe did not receive HTTP 200');
  assert.equal(result?.transport?.validatedResponse, true, 'Jev provider response was not validated');
  return compactJevProbe(result);
}

async function copyEvidence(runtime, logsDir) {
  const copied = {sessions: false, jevState: false};
  const sessions = join(runtime.home, 'sessions');
  try {
    if ((await lstat(sessions)).isDirectory()) {
      await cp(sessions, join(logsDir, 'sessions'), {recursive: true, dereference: true});
      copied.sessions = true;
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  if (runtime.stateDirectory) {
    try {
      if ((await lstat(runtime.stateDirectory)).isDirectory()) {
        await cp(runtime.stateDirectory, join(logsDir, 'jev-state'), {recursive: true, dereference: true});
        copied.jevState = true;
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  return copied;
}

async function run(request) {
  const logsDir = resolve(request.logsDir);
  await mkdir(logsDir, {recursive: true, mode: 0o700});
  const hostShadow = request.hostCwd;
  const logsMetadata = await lstat(logsDir);
  assert.equal(logsMetadata.isDirectory(), true, 'host-control logs path must be a directory');
  assert.equal(logsMetadata.uid, process.getuid(), 'host-control logs path must be owned by the benchmark user');
  assert.equal(logsMetadata.mode & 0o077, 0, 'host-control logs path must be owner-only');
  assert.equal(await realpath(dirname(hostShadow)), await realpath(logsDir), 'host workspace parent must be host-control logs');
  await mkdir(hostShadow, {recursive: false, mode: 0o700});
  assert.equal((await lstat(hostShadow)).isDirectory(), true, 'host workspace shadow must be a directory');
  const receipt = {
    schemaVersion: RUNTIME_SCHEMA,
    arm: request.arm,
    status: 'failed',
    preflightOnly: request.preflightOnly,
    startedAt: new Date().toISOString(),
    model: request.model,
    effort: request.effort,
  };
  let runtime;
  let server;
  let threadId;
  try {
    receipt.hostRuntime = await verifyHostRuntimeIdentity(request);
    receipt.container = await inspectContainer(request, await runtimeProtectedPaths());
    runtime = await createRuntimeHome(request);
    receipt.pluginSourceHashes = runtime.sourceHashes;
    receipt.bootstrapTrustedHooks = await trustTreatmentHooks(request, runtime, hostShadow);
    server = new AppServer({request, codexHome: runtime.home, hostShadow});
    await server.initialize();
    receipt.startup = {processToInitializedMs: server.initializedMs};
    receipt.environmentStatus = await server.rpc('environment/status', {environmentId: 'deep-swe'});
    receipt.environmentInfo = await server.rpc('environment/info', {environmentId: 'deep-swe'});

    const hooks = compactHooks(flattenHooks(await server.rpc('hooks/list', {cwds: [hostShadow]})));
    receipt.hooks = hooks;
    if (request.arm === 'baseline') assert.equal(hooks.length, 0, 'baseline exposed Jev hooks');
    else {
      assert.equal(hooks.length, 12, 'treatment must expose 12 Jev hooks');
      assert.equal(hooks.every(hook => hook.enabled && hook.trustStatus === 'trusted'), true, 'treatment hooks must be enabled and trusted');
    }

    const selectedEnvironment = [{environmentId: 'deep-swe', cwd: request.remoteCwd, runtimeWorkspaceRoots: [request.remoteCwd]}];
    const started = await server.rpc('thread/start', {
      cwd: hostShadow,
      environments: selectedEnvironment,
      ephemeral: false,
      approvalPolicy: 'never',
      sandbox: 'workspace-write',
      model: request.model,
    }, INITIALIZE_TIMEOUT_MS);
    threadId = started?.thread?.id;
    assert.equal(typeof threadId, 'string', 'thread/start returned no thread id');
    assert.deepEqual(started?.thread?.environments, selectedEnvironment, 'thread did not retain exactly one remote environment');

    const mcp = compactMcp(await server.rpc('mcpServerStatus/list', {threadId, detail: 'full', limit: 200}));
    receipt.mcp = mcp;
    const jevServers = mcp.filter(item => item.pluginId === PLUGIN_ID || item.name === 'jev-workflows');
    if (request.arm === 'baseline') {
      assert.equal(mcp.length, 0, 'baseline exposed an unexpected MCP server');
      assert.equal(jevServers.length, 0, 'baseline exposed Jev MCP');
    }
    else {
      assert.equal(mcp.length, 1, 'treatment exposed an unexpected MCP server');
      assert.equal(jevServers.length, 1, 'treatment requires exactly one Jev MCP');
      assert.deepEqual(jevServers[0].tools, JEV_TOOL_NAMES, 'treatment Jev MCP tool inventory drifted');
      const status = await server.rpc('mcpServer/tool/call', {threadId, server: jevServers[0].name, tool: 'jev_status', arguments: {}});
      const automation = status?.structuredContent?.automation;
      assert.equal(automation?.enabled, true, 'Jev automation must be enabled');
      assert.equal(automation?.scope, 'all-workspaces', 'Jev automation must cover all workspaces');
      for (const key of ['maxHookCallsPerSession', 'maxCallsPerDay', 'maxBytesPerDay']) assert.equal(automation?.[key], null, `${key} must be unlimited`);
      receipt.automation = {
        enabled: automation.enabled,
        scope: automation.scope,
        maxHookCallsPerSession: automation.maxHookCallsPerSession,
        maxCallsPerDay: automation.maxCallsPerDay,
        maxBytesPerDay: automation.maxBytesPerDay,
      };
      if (request.preflightOnly) receipt.jevProviderProbe = await verifyTreatmentProviderCall(server, threadId, jevServers[0].name);
    }

    if (!request.preflightOnly) {
      const turn = await server.rpc('turn/start', {
        threadId,
        input: [{type: 'text', text: request.instruction, text_elements: []}],
        model: request.model,
        effort: request.effort,
        approvalPolicy: 'never',
        sandboxPolicy: {
          type: 'workspaceWrite',
          writableRoots: [request.remoteCwd],
          networkAccess: false,
          excludeTmpdirEnvVar: false,
          excludeSlashTmp: false,
        },
      });
      const turnId = turn?.turn?.id;
      assert.equal(typeof turnId, 'string', 'turn/start returned no turn id');
      const completion = await server.waitForTurn(threadId, turnId);
      receipt.turn = {id: turnId, status: completion.status, usage: completion.usage};
      assert.equal(completion.status, 'completed', `Codex turn ended as ${completion.status}`);
    }
    receipt.events = server.events.filter(event => !threadId || event.threadId === threadId);
    receipt.status = 'passed';
  } catch (error) {
    receipt.failure = {name: error?.name ?? 'Error', message: String(error?.message ?? error).slice(0, 2_000)};
    throw error;
  } finally {
    const cleanupErrors = [];
    if (server) {
      try {
        await server.close();
        receipt.appServerStderr = server.stderrEvidence();
      } catch (error) {
        cleanupErrors.push(`app-server close: ${String(error?.message ?? error).slice(0, 500)}`);
      }
    }
    if (runtime) {
      try {
        const evidence = await copyEvidence(runtime, logsDir);
        receipt.evidence = evidence;
        if (!request.preflightOnly && !evidence.sessions) cleanupErrors.push('evidence copy: scored run produced no Codex session evidence');
        if (request.arm === 'treatment' && !evidence.jevState) cleanupErrors.push('evidence copy: treatment produced no Jev state evidence');
      } catch (error) {
        cleanupErrors.push(`evidence copy: ${String(error?.message ?? error).slice(0, 500)}`);
      } finally {
        try {
          await rm(runtime.home, {recursive: true, force: true});
        } catch (error) {
          cleanupErrors.push(`runtime home removal: ${String(error?.message ?? error).slice(0, 500)}`);
        }
      }
    }
    try {
      await rm(hostShadow, {recursive: true, force: true});
    } catch (error) {
      cleanupErrors.push(`host shadow removal: ${String(error?.message ?? error).slice(0, 500)}`);
    }
    if (cleanupErrors.length) {
      receipt.cleanupErrors = cleanupErrors;
      receipt.status = 'failed';
      receipt.failure ??= {name: 'CleanupError', message: cleanupErrors.join('; ').slice(0, 2_000)};
    }
    receipt.completedAt = new Date().toISOString();
    await writeFile(join(logsDir, 'runtime-evidence.json'), `${JSON.stringify(receipt, null, 2)}\n`, {encoding: 'utf8', mode: 0o600});
  }
  return receipt;
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!['--request', '--result'].includes(token) || index + 1 >= argv.length) throw new Error(`invalid option: ${token}`);
    result[token.slice(2)] = argv[++index];
  }
  if (!result.request || !result.result) throw new Error('--request and --result are required');
  return result;
}

async function main(argv) {
  const args = parseArgs(argv);
  const request = validateRequest(JSON.parse(await readFile(resolve(args.request), 'utf8')));
  const receipt = await run(request);
  await writeFile(resolve(args.result), `${JSON.stringify({status: receipt.status, schemaVersion: receipt.schemaVersion})}\n`, {encoding: 'utf8', mode: 0o600});
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch(error => {
    process.stderr.write(`${error?.stack ?? error}\n`);
    process.exitCode = 1;
  });
}
