import { execFile as nodeExecFile, spawn as nodeSpawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline';

const DEFAULT_CODEX = '/opt/homebrew/bin/codex';
const DEFAULT_MODEL = 'gpt-6-astra';
const DEFAULT_EFFORT = 'ultra';
const PLUGIN_ID = 'jev-workflows@personal';
const PLUGIN_VERSION = '0.5.1';
const JEV_ENV_KEYS = [
  'TYPESAFE_API_KEY',
  'JEV_API_KEY_FILE',
  'JEV_MODEL',
  'JEV_LONG_CONTEXT',
];
const SAFE_ENV_KEYS = [
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'LC_CTYPE',
  'TERM', 'TMPDIR', 'TEMP', 'TMP', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY',
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS',
];
const HASHED_PLUGIN_FILES = [
  'plugin.json',
  '.codex-plugin/plugin.json',
  '.mcp.json',
  'hooks/hooks.json',
  'dist/server.mjs',
  'dist/decision-hook.mjs',
  'scripts/package-host.mjs',
];

function safeName(value) {
  return String(value ?? 'trial').replace(/[^a-zA-Z0-9._-]/g, '_');
}

function containsPath(ancestor, candidate) {
  const value = relative(resolve(ancestor), resolve(candidate));
  return value === '' || (value !== '..' && !value.startsWith(`..${sep}`) && !isAbsolute(value));
}

function hash(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function fileHash(path) {
  return hash(await readFile(path));
}

async function canonicalProspective(path) {
  let current = resolve(path);
  const suffix = [];
  for (;;) {
    try { return resolve(await realpath(current), ...suffix); }
    catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      const parent = dirname(current);
      if (parent === current) throw error;
      suffix.unshift(basename(current));
      current = parent;
    }
  }
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  await rename(temporary, path);
}

function execFilePromise(execFileFn, command, args, options) {
  return new Promise((resolvePromise, reject) => {
    execFileFn(command, args, options, (error, stdout, stderr) => {
      if (error) reject(Object.assign(error, { stdout, stderr }));
      else resolvePromise({ stdout, stderr });
    });
  });
}

async function defaultStagePlugin({ pluginRoot, target, stateDir, nodePath, execFileFn }) {
  const source = resolve(pluginRoot);
  const manifest = JSON.parse(await readFile(join(source, 'plugin.json'), 'utf8'));
  if (manifest?.name !== 'jev-workflows' || manifest?.version !== PLUGIN_VERSION) {
    throw new Error(`Codex treatment requires jev-workflows ${PLUGIN_VERSION}`);
  }
  const sourceHashes = {};
  for (const name of HASHED_PLUGIN_FILES) sourceHashes[name] = await fileHash(join(source, name));
  const stagingParent = join(dirname(target), `.codex-adapter-stage-${randomUUID()}`);
  const stagingTarget = join(stagingParent, 'jev-workflows');
  await mkdir(stagingParent, { mode: 0o700 });
  try {
    await execFilePromise(execFileFn, nodePath, [
      join(source, 'scripts', 'package-host.mjs'),
      '--state-directory', stateDir,
      stagingTarget,
    ], { encoding: 'utf8', timeout: 30_000, maxBuffer: 1_000_000 });
    await rename(stagingTarget, target);
  } finally {
    await rm(stagingParent, { recursive: true, force: true });
  }
  const marker = JSON.parse(await readFile(join(target, 'HOST-COMPATIBILITY.json'), 'utf8'));
  const installed = JSON.parse(await readFile(join(target, '.codex-plugin', 'plugin.json'), 'utf8'));
  if (marker?.packageKind !== 'codex-legacy-host-compatibility' || marker?.stateDirectory?.path !== stateDir) {
    throw new Error('staged Codex package did not retain the per-run Jev state directory');
  }
  if (installed?.name !== 'jev-workflows' || installed?.version !== PLUGIN_VERSION) {
    throw new Error('staged Codex package identity differs from the reviewed source');
  }
  return { sourceHashes, version: installed.version, packageKind: marker.packageKind };
}

function configArgs(arm) {
  const args = [
    '-c', 'approval_policy="never"',
    '-c', 'project_doc_max_bytes=0',
    '-c', 'sandbox_workspace_write.network_access=false',
    '-c', 'shell_environment_policy.inherit="none"',
    '-c', 'shell_environment_policy.ignore_default_excludes=false',
    '-c', 'shell_environment_policy.include_only=["PATH","USER","LOGNAME","SHELL","LANG","LC_*","TERM","TMPDIR","TEMP","TMP"]',
    '-c', 'shell_environment_policy.set.PATH="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin"',
    '-c', 'shell_environment_policy.set.LANG="C.UTF-8"',
    '--disable', 'apps',
    '--disable', 'remote_plugin',
    '-c', `features.plugins=${arm === 'on'}`,
  ];
  if (arm === 'on') {
    args.push('-c', `plugins.${JSON.stringify(PLUGIN_ID)}.enabled=true`);
  }
  return args;
}

export function buildLaunch({ arm, model, effort, workspace, lastMessagePath }) {
  if (!['off', 'on'].includes(arm)) throw new TypeError('arm must be off or on');
  return [
    'exec', '--json', '--color', 'never',
    '--ignore-rules', '--strict-config', '--skip-git-repo-check', '--model', model,
    '--sandbox', 'workspace-write', '--cd', resolve(workspace),
    '-c', `model_reasoning_effort=${JSON.stringify(effort)}`,
    ...configArgs(arm),
    '--output-last-message', lastMessagePath,
    '-',
  ];
}

export async function writeHookTrusts(rpc, hooks) {
  const state = Object.fromEntries(hooks.map(hook => [hook.key, { trusted_hash: hook.currentHash }]));
  return rpc('config/batchWrite', {
    edits: [{ keyPath: 'hooks.state', value: state, mergeStrategy: 'upsert' }],
    filePath: null,
    expectedVersion: null,
    reloadUserConfig: true,
  });
}

function childEnvironment(arm, codexHome) {
  const env = {};
  for (const key of SAFE_ENV_KEYS) if (process.env[key] !== undefined) env[key] = process.env[key];
  env.CODEX_HOME = codexHome;
  if (arm === 'on') {
    for (const key of JEV_ENV_KEYS) if (process.env[key] !== undefined) env[key] = process.env[key];
    env.JEV_ENABLED = '1';
    env.JEV_HOOKS_ENABLED = '1';
  }
  return env;
}

async function defaultInspectControlPlane({ codexPath, codexHome, workspace, arm, marketplacePath, spawnFn, timeoutMs = 45_000 }) {
  const args = ['app-server', '--stdio', '--strict-config', '--disable', 'apps', '--disable', 'remote_plugin'];
  if (arm === 'off') args.push('--disable', 'plugins');
  else args.push('--enable', 'plugins', '-c', `plugins.${JSON.stringify(PLUGIN_ID)}.enabled=true`);
  const child = spawnFn(codexPath, args, {
    cwd: workspace,
    env: childEnvironment('off', codexHome),
    detached: process.platform !== 'win32',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const exited = new Promise(resolveExit => child.once('exit', (code, signal) => resolveExit({ code, signal })));
  const pending = new Map();
  let nextId = 0;
  let stderr = '';
  let failure = null;
  child.stderr?.setEncoding?.('utf8');
  child.stderr?.on('data', chunk => { stderr = (stderr + chunk).slice(-4_000); });
  const lines = createInterface({ input: child.stdout });
  const fail = error => {
    failure = error;
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    pending.clear();
  };
  lines.on('line', line => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message.id !== undefined && pending.has(message.id)) {
      const request = pending.get(message.id);
      pending.delete(message.id);
      clearTimeout(request.timer);
      if (message.error) request.reject(new Error(`RPC ${request.method} failed: ${message.error.message ?? message.error.code}`));
      else request.resolve(message.result);
      return;
    }
    if (message.id !== undefined && message.method) {
      child.stdin.write(`${JSON.stringify({ id: message.id, error: { code: -32601, message: 'benchmark control-plane inspection grants no requests' } })}\n`);
    }
  });
  child.once('error', fail);
  child.once('exit', (code, signal) => {
    if (!failure && pending.size) fail(new Error(`Codex control-plane exited: ${code ?? signal}`));
  });
  const rpc = (method, params) => new Promise((resolvePromise, reject) => {
    if (failure) return reject(failure);
    const id = ++nextId;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Codex control-plane timed out: ${method}`));
    }, timeoutMs);
    pending.set(id, { resolve: resolvePromise, reject, timer, method });
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
  });
  try {
    await rpc('initialize', {
      clientInfo: { name: 'jev_agent_quality', title: 'Jev agent quality benchmark', version: '1.0.0' },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    child.stdin.write(`${JSON.stringify({ method: 'initialized', params: {} })}\n`);
    if (arm === 'on') {
      await rpc('plugin/install', { marketplacePath, pluginName: 'jev-workflows' });
    }
    const models = [];
    let cursor = null;
    for (let page = 0; page < 5; page += 1) {
      const response = await rpc('model/list', { limit: 100, includeHidden: false, cursor });
      for (const item of response?.data ?? []) {
        models.push({
          id: item?.id ?? null,
          model: item?.model ?? null,
          displayName: item?.displayName ?? null,
          isDefault: item?.isDefault === true,
          defaultReasoningEffort: item?.defaultReasoningEffort ?? null,
          supportedReasoningEfforts: (item?.supportedReasoningEfforts ?? item?.reasoningEfforts ?? [])
            .map(value => typeof value === 'string' ? value : value?.reasoningEffort)
            .filter(value => typeof value === 'string'),
        });
      }
      cursor = response?.nextCursor ?? null;
      if (!cursor) break;
    }
    let trustedHooks = [];
    if (arm === 'on') {
      const response = await rpc('hooks/list', { cwds: [workspace] });
      trustedHooks = (Array.isArray(response?.data) ? response.data : [])
        .flatMap(group => Array.isArray(group?.hooks) ? group.hooks : [])
        .filter(hook => hook?.pluginId === PLUGIN_ID)
        .map(hook => ({ key: hook.key, currentHash: hook.currentHash, eventName: hook.eventName, trustStatus: hook.trustStatus }));
      if (trustedHooks.length !== 12 || trustedHooks.some(hook => typeof hook.key !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(hook.currentHash ?? ''))) {
        throw new Error('isolated Jev hook inventory or hashes differ from the reviewed package');
      }
      await writeHookTrusts(rpc, trustedHooks);
      const verified = await rpc('hooks/list', { cwds: [workspace] });
      const verifiedHooks = (Array.isArray(verified?.data) ? verified.data : [])
        .flatMap(group => Array.isArray(group?.hooks) ? group.hooks : [])
        .filter(hook => hook?.pluginId === PLUGIN_ID)
        .map(hook => ({ key: hook.key, currentHash: hook.currentHash, eventName: hook.eventName, trustStatus: hook.trustStatus }));
      const expected = trustedHooks.map(hook => `${hook.key}\0${hook.currentHash}`).sort();
      const actual = verifiedHooks.map(hook => `${hook.key}\0${hook.currentHash}`).sort();
      if (JSON.stringify(actual) !== JSON.stringify(expected) || verifiedHooks.some(hook => hook.trustStatus !== 'trusted')) {
        throw new Error('isolated Jev hook trust was not applied to the reviewed hook hashes');
      }
      trustedHooks = verifiedHooks;
    }
    return { models, trustedHooks, stderrBytes: Buffer.byteLength(stderr) };
  } finally {
    lines.close();
    if (!child.stdin.destroyed) child.stdin.end();
    if (child.exitCode === null && child.signalCode === null) killGroup(child, 'SIGTERM');
    const stopped = await Promise.race([
      exited.then(() => true),
      new Promise(resolveWait => setTimeout(() => resolveWait(false), 2_000)),
    ]);
    if (!stopped && child.exitCode === null && child.signalCode === null) {
      killGroup(child, 'SIGKILL');
      await Promise.race([exited, new Promise(resolveWait => setTimeout(resolveWait, 2_000))]);
    }
  }
}

function parseEvents(stdout) {
  const events = [];
  let malformedLines = 0;
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { events.push(JSON.parse(line)); }
    catch { malformedLines += 1; }
  }
  return { events, malformedLines };
}

function eventType(event) {
  return event?.type ?? event?.method ?? null;
}

function firstString(values) {
  return values.find(value => typeof value === 'string' && value.length > 0) ?? null;
}

function observedModel(event) {
  return firstString([
    event?.model, event?.resolved_model, event?.resolvedModel, event?.turn?.model,
    event?.message?.model, event?.response?.model,
  ]);
}

function observedEffort(event) {
  return firstString([
    event?.effort, event?.reasoning_effort, event?.resolvedEffort,
    event?.turn?.effort, event?.turn?.reasoning_effort,
  ]);
}

function usageFrom(value) {
  if (!value || typeof value !== 'object') return null;
  const get = (...keys) => {
    for (const key of keys) if (Number.isFinite(value[key])) return value[key];
    return null;
  };
  const usage = {
    inputTokens: get('input_tokens', 'inputTokens'),
    cachedInputTokens: get('cached_input_tokens', 'cache_read_input_tokens', 'cachedInputTokens'),
    outputTokens: get('output_tokens', 'outputTokens'),
    reasoningTokens: get('reasoning_tokens', 'reasoningTokens'),
  };
  return Object.values(usage).some(item => item !== null) ? usage : null;
}

function collectUsage(events) {
  let result = null;
  for (const event of events) {
    for (const candidate of [event?.usage, event?.turn?.usage, event?.response?.usage, event?.message?.usage]) {
      const observed = usageFrom(candidate);
      if (observed) result = observed;
    }
  }
  return result ?? { inputTokens: null, cachedInputTokens: null, outputTokens: null, reasoningTokens: null };
}

function adviceFromText(value) {
  if (typeof value !== 'string' || !value.includes('JEV advisory:')) return null;
  const status = value.match(/JEV advisory: status=(assessed|abstained|unavailable|skipped|preview)\b/)?.[1];
  if (!status) return null;
  return {
    status,
    decision: value.match(/\bdecision=([a-z0-9_.-]{1,100})\b/i)?.[1] ?? null,
    receiptId: value.match(/\breceipt=([a-f0-9-]{36})\b/i)?.[1] ?? null,
  };
}

function collectFixedAdvice(value, output = [], depth = 0) {
  if (depth > 6 || output.length >= 100) return output;
  const advice = adviceFromText(value);
  if (advice) output.push(advice);
  else if (Array.isArray(value)) for (const item of value) collectFixedAdvice(item, output, depth + 1);
  else if (value && typeof value === 'object') {
    for (const item of Object.values(value)) collectFixedAdvice(item, output, depth + 1);
  }
  return output;
}

function compactTrace(events) {
  return events.flatMap(event => {
    const type = eventType(event);
    const item = event?.item ?? event?.params?.item;
    const hook = event?.run ?? event?.hook ?? event?.params?.run;
    const advice = collectFixedAdvice(event);
    const relevant = advice.length > 0 || /(?:hook|tool|command|file|error|turn\.(?:started|completed|failed)|thread\.started)/i.test(String(type));
    if (!relevant) return [];
    return [{
      type,
      itemType: item?.type ?? null,
      status: event?.status ?? item?.status ?? hook?.status ?? event?.turn?.status ?? null,
      tool: item?.tool ?? event?.tool ?? null,
      server: item?.server ?? event?.server ?? null,
      pluginId: item?.pluginId ?? hook?.pluginId ?? null,
      hookEvent: hook?.eventName ?? null,
      advice,
    }];
  });
}

function compactHostFailure(events) {
  const event = [...events].reverse().find(item => /(?:^error$|turn\.failed$)/i.test(String(eventType(item))));
  if (!event) return null;
  const raw = event?.error?.message ?? event?.message ?? event?.error;
  let parsed = null;
  if (typeof raw === 'string') {
    try { parsed = JSON.parse(raw); } catch { /* retain the bounded message */ }
  }
  return {
    eventType: eventType(event),
    status: parsed?.status ?? parsed?.error?.status ?? null,
    errorType: parsed?.error?.type ?? parsed?.type ?? null,
    message: String(parsed?.error?.message ?? parsed?.message ?? raw ?? 'Codex turn failed').slice(0, 2_000),
  };
}

async function boundedJsonFiles(directory, matcher, limit = 500) {
  const paths = [];
  async function visit(current, depth) {
    if (depth > 6 || paths.length >= limit) return;
    let entries;
    try { entries = await readdir(current, { withFileTypes: true }); }
    catch (error) { if (error?.code === 'ENOENT') return; throw error; }
    for (const entry of entries) {
      if (paths.length >= limit) break;
      const path = join(current, entry.name);
      if (entry.isDirectory()) await visit(path, depth + 1);
      else if (entry.isFile() && matcher(path)) paths.push(path);
    }
  }
  await visit(directory, 0);
  const values = [];
  for (const path of paths) {
    const info = await lstat(path);
    if (info.size > 128 * 1024) continue;
    try { values.push({ path, value: JSON.parse(await readFile(path, 'utf8')) }); }
    catch { values.push({ path, value: null }); }
  }
  return { values, truncated: paths.length >= limit };
}

export async function readJevAccounting(stateDir, hostAdvice = []) {
  const provider = await boundedJsonFiles(join(stateDir, 'receipts'), path => /^[a-f0-9-]{36}\.json$/i.test(basename(path)));
  const invocations = await boundedJsonFiles(join(stateDir, 'decision-hook-v1'), path => path.includes(`${sep}invocations${sep}`) && path.endsWith('.json'));
  const uniqueReceipts = new Map();
  for (const item of provider.values) {
    const value = item.value;
    if (value && typeof value === 'object' && typeof value.receiptId === 'string' && !uniqueReceipts.has(value.receiptId)) {
      uniqueReceipts.set(value.receiptId, value);
    }
  }
  const receipts = [...uniqueReceipts.values()];
  const calls = receipts.filter(item => item?.transport?.fetchInvoked === true);
  const requestIds = [...new Set(calls.map(item => item?.transport?.providerRequestId).filter(value => typeof value === 'string' && value.length > 0))].sort();
  const invocationReceipts = invocations.values.filter(item => item.value && typeof item.value === 'object').map(item => item.value);
  const invocationByReceipt = new Map(invocationReceipts
    .filter(item => typeof item?.referenceReceiptId === 'string')
    .map(item => [item.referenceReceiptId, item]));
  const usage = { inputTokens: null, cachedInputTokens: null, cacheCreationTokens: null, outputTokens: null };
  const latenciesMs = [];
  for (const receipt of calls) {
    if (Number.isFinite(receipt.usage?.input_tokens)) usage.inputTokens = (usage.inputTokens ?? 0) + receipt.usage.input_tokens;
    if (Number.isFinite(receipt.usage?.output_tokens)) usage.outputTokens = (usage.outputTokens ?? 0) + receipt.usage.output_tokens;
    if (Number.isFinite(receipt.usage?.cache_read_input_tokens)) usage.cachedInputTokens = (usage.cachedInputTokens ?? 0) + receipt.usage.cache_read_input_tokens;
    if (Number.isFinite(receipt.usage?.cache_creation_input_tokens)) usage.cacheCreationTokens = (usage.cacheCreationTokens ?? 0) + receipt.usage.cache_creation_input_tokens;
    if (Number.isFinite(receipt.latencyMs)) latenciesMs.push(receipt.latencyMs);
  }
  latenciesMs.sort((left, right) => left - right);
  const deliveryReceipts = new Set();
  const deliveries = new Map();
  for (const advice of hostAdvice) {
    if (typeof advice?.receiptId !== 'string') continue;
    const receipt = uniqueReceipts.get(advice.receiptId);
    if (!receipt) continue;
    deliveryReceipts.add(advice.receiptId);
    const invocation = invocationByReceipt.get(advice.receiptId);
    const matched = advice.status === 'assessed'
      && typeof advice.decision === 'string'
      && receipt.status === advice.status
      && receipt.transport?.fetchInvoked === true
      && receipt.transport?.validatedResponse === true
      && invocation?.assessmentStatus === advice.status
      && invocation?.classification === advice.decision;
    if (matched && !deliveries.has(advice.receiptId)) {
      deliveries.set(advice.receiptId, {
        status: advice.status,
        decision: advice.decision,
        receiptId: advice.receiptId,
        evidenceSource: advice.evidenceSource ?? 'unknown',
      });
    }
  }
  return {
    attempts: calls.length,
    fetchInvoked: calls.length,
    responses: calls.filter(item => Number.isInteger(item?.transport?.responseStatus)).length,
    validatedResponses: calls.filter(item => item?.transport?.validatedResponse === true).length,
    abstentions: receipts.filter(item => item?.status === 'abstained').length,
    requestIds,
    receiptCount: receipts.length,
    receipts: receipts.length,
    invocationCount: invocationReceipts.length,
    assessedInvocations: invocationReceipts.filter(item => item?.assessmentStatus === 'assessed' && item?.classification !== 'unavailable').length,
    deliveryReceipts: deliveryReceipts.size,
    adviceDeliveries: deliveries.size,
    deliveries: [...deliveries.values()].sort((left, right) => left.receiptId.localeCompare(right.receiptId)),
    usage,
    latenciesMs,
    inventoryTruncated: provider.truncated || invocations.truncated,
  };
}

export async function inspectCodexSession(codexHome) {
  const paths = [];
  async function visit(current, depth) {
    if (depth > 6 || paths.length >= 20) return;
    let entries;
    try { entries = await readdir(current, { withFileTypes: true }); }
    catch (error) { if (error?.code === 'ENOENT') return; throw error; }
    for (const entry of entries) {
      if (paths.length >= 20) break;
      const path = join(current, entry.name);
      if (entry.isDirectory()) await visit(path, depth + 1);
      else if (entry.isFile() && path.endsWith('.jsonl')) paths.push(path);
    }
  }
  await visit(join(codexHome, 'sessions'), 0);
  let sessionId = null;
  let turn = null;
  let filesRead = 0;
  const advice = new Map();
  for (const path of paths) {
    const info = await lstat(path);
    if (info.size > 2 * 1024 * 1024) continue;
    filesRead += 1;
    for (const line of (await readFile(path, 'utf8')).split(/\r?\n/)) {
      if (!line.trim()) continue;
      let record;
      try { record = JSON.parse(line); } catch { continue; }
      if (record?.type === 'session_meta' && typeof record?.payload?.id === 'string') sessionId = record.payload.id;
      if (record?.type === 'response_item' && record?.payload?.type === 'message' && record?.payload?.role === 'developer') {
        for (const item of record.payload.content ?? []) {
          const observed = adviceFromText(item?.text);
          if (!observed) continue;
          const key = `${observed.status}\0${observed.decision ?? ''}\0${observed.receiptId ?? ''}`;
          if (!advice.has(key)) advice.set(key, { ...observed, evidenceSource: 'isolated_session_developer_message' });
        }
      }
      if (record?.type === 'turn_context' && record?.payload && typeof record.payload === 'object') {
        turn = {
          model: typeof record.payload.model === 'string' ? record.payload.model : null,
          effort: typeof record.payload.effort === 'string' ? record.payload.effort : null,
          cwd: typeof record.payload.cwd === 'string' ? record.payload.cwd : null,
          approvalPolicy: record.payload.approval_policy ?? null,
          sandboxPolicyType: record.payload.sandbox_policy?.type ?? record.payload.sandbox_policy ?? null,
        };
      }
    }
  }
  return { sessionId, turn, advice: [...advice.values()], filesRead, inventoryTruncated: paths.length >= 20 };
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

async function runChild({ spawnFn, codexPath, args, env, cwd, input, timeoutMs, graceMs, signal }) {
  let stdout = '';
  let stderr = '';
  let timedOut = false;
  let aborted = false;
  let spawnError = null;
  let closeResult = null;
  const child = spawnFn(codexPath, args, {
    cwd, env, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdout?.setEncoding?.('utf8');
  child.stderr?.setEncoding?.('utf8');
  child.stdout?.on('data', chunk => { stdout += chunk; });
  child.stderr?.on('data', chunk => { stderr += chunk; });
  child.stdin?.on('error', () => {});
  child.stdin?.end(input);
  try {
    closeResult = await new Promise((resolveClose, rejectClose) => {
      const stop = () => {
        aborted = true;
        killGroup(child, 'SIGTERM');
        setTimeout(() => killGroup(child, 'SIGKILL'), graceMs).unref?.();
      };
      const timer = setTimeout(() => {
        timedOut = true;
        stop();
      }, timeoutMs);
      if (signal?.aborted) stop();
      else signal?.addEventListener('abort', stop, { once: true });
      child.once('close', (code, closeSignal) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', stop);
        resolveClose({ code, signal: closeSignal });
      });
      child.once('error', error => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', stop);
        rejectClose(error);
      });
    });
  } catch (error) {
    spawnError = error;
  }
  return { stdout, stderr, timedOut, aborted, spawnError, closeResult };
}

/** Run one Codex trial. Injection points are for deterministic adapter tests only. */
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
    codexPath = DEFAULT_CODEX,
    sourceCodexHome = process.env.CODEX_HOME ?? join(homedir(), '.codex'),
    spawnFn = nodeSpawn,
    execFileFn = nodeExecFile,
    stagePluginFn = defaultStagePlugin,
    inspectControlPlaneFn = defaultInspectControlPlane,
    controlPlaneSpawnFn = nodeSpawn,
    graceMs = 2_000,
    signal,
  } = options ?? {};

  if (!workspace || !outputDir || !prompt || !['off', 'on'].includes(arm)) {
    throw new TypeError('workspace, prompt, arm, and outputDir are required');
  }
  if (arm === 'on' && !pluginRoot) throw new TypeError('pluginRoot is required for the on arm');
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError('timeoutMs must be positive');
  const resolvedWorkspace = await realpath(resolve(workspace));
  const runRoot = await canonicalProspective(resolve(outputDir, safeName(runId)));
  if (containsPath(resolvedWorkspace, runRoot)) throw new Error('private benchmark output must be outside the candidate workspace');
  await mkdir(resolve(outputDir), { recursive: true, mode: 0o700 });
  await mkdir(runRoot, { mode: 0o700 });

  const codexHome = join(runRoot, 'codex-home');
  const stateDir = join(runRoot, 'jev-state');
  const marketplacePath = join(runRoot, '.agents', 'plugins', 'marketplace.json');
  const stdoutPath = join(runRoot, 'stdout.ndjson');
  const stderrPath = join(runRoot, 'stderr.log');
  const eventsPath = join(runRoot, 'events.json');
  const lastMessagePath = join(runRoot, 'last-message.txt');
  const receiptPath = join(runRoot, 'receipt.json');
  const input = [prompt, ...followups].join('\n\n');
  const started = Date.now();
  let packageEvidence = null;
  let controlPlaneEvidence = null;
  let processResult = null;
  let receipt;
  try {
    await mkdir(codexHome, { mode: 0o700 });
    const authSource = await realpath(join(resolve(sourceCodexHome), 'auth.json'));
    const authInfo = await lstat(authSource);
    if (!authInfo.isFile()) throw new Error('Codex auth source must be a regular file');
    await symlink(authSource, join(codexHome, 'auth.json'));
    if (arm === 'on') {
      await mkdir(stateDir, { recursive: true, mode: 0o700 });
      await writeJson(join(stateDir, 'policy.json'), {
        enabled: true,
        maxBytesPerDay: null,
        maxCallsPerDay: null,
        maxHookCallsPerSession: null,
        scope: 'all-workspaces',
        workspaces: [],
      });
      const target = join(runRoot, 'plugins', 'jev-workflows');
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      packageEvidence = await stagePluginFn({
        pluginRoot: resolve(pluginRoot), target, stateDir, nodePath, execFileFn,
      });
      await writeJson(marketplacePath, {
        name: 'personal',
        interface: { displayName: 'Jev benchmark private runtime' },
        plugins: [{
          name: 'jev-workflows',
          source: { source: 'local', path: './plugins/jev-workflows' },
          policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
          category: 'Productivity',
        }],
      });
    }
    controlPlaneEvidence = await inspectControlPlaneFn({
      codexPath, codexHome, workspace: resolvedWorkspace, arm,
      marketplacePath: arm === 'on' ? marketplacePath : null,
      spawnFn: controlPlaneSpawnFn,
    });
    const selected = controlPlaneEvidence.models?.find(item => item?.model === model || item?.id === model);
    if (!selected) throw new Error(`requested Codex model is unavailable to this authenticated host: ${model}`);
    if (!selected.supportedReasoningEfforts?.includes(effort)) {
      throw new Error(`requested Codex reasoning effort is unavailable for ${model}: ${effort}`);
    }
    const args = buildLaunch({ arm, model, effort, workspace: resolvedWorkspace, lastMessagePath });
    processResult = await runChild({
      spawnFn, codexPath, args, env: childEnvironment(arm, codexHome),
      cwd: resolvedWorkspace, input, timeoutMs, graceMs, signal,
    });
    await writeFile(stdoutPath, processResult.stdout, { mode: 0o600 });
    await writeFile(stderrPath, processResult.stderr, { mode: 0o600 });
    const parsed = parseEvents(processResult.stdout);
    await writeJson(eventsPath, parsed.events);
    const session = await inspectCodexSession(codexHome);
    const trace = compactTrace(parsed.events);
    const hostFailure = compactHostFailure(parsed.events);
    const eventAdvice = trace.flatMap(item => item.advice).map(item => ({ ...item, evidenceSource: 'exec_json_stream' }));
    const hostAdvice = [...eventAdvice, ...session.advice];
    const jev = arm === 'on'
      ? await readJevAccounting(stateDir, hostAdvice)
      : {
          attempts: 0, responses: 0, validatedResponses: 0, abstentions: 0,
          requestIds: [], receiptCount: 0, invocationCount: 0,
          assessedInvocations: 0, adviceDeliveries: eventAdvice.filter(item => item.status === 'assessed' && item.decision).length,
          deliveries: [], usage: { inputTokens: null, cachedInputTokens: null, cacheCreationTokens: null, outputTokens: null }, latenciesMs: [],
          inventoryTruncated: false,
        };
    const streamModel = parsed.events.map(observedModel).find(Boolean) ?? null;
    const streamEffort = parsed.events.map(observedEffort).find(Boolean) ?? null;
    const resolvedModel = session.turn?.model ?? streamModel;
    const resolvedEffort = session.turn?.effort ?? streamEffort;
    const modelEvidenceSource = session.turn?.model ? 'isolated_session_turn_context' : streamModel ? 'json_stream' : null;
    const effortEvidenceSource = session.turn?.effort ? 'isolated_session_turn_context' : streamEffort ? 'json_stream' : null;
    const modelMatches = resolvedModel === model;
    const effortMatches = resolvedEffort === effort;
    const terminal = [...parsed.events].reverse().find(event => /turn\.(?:completed|failed)$/i.test(String(eventType(event))));
    const terminalStatus = terminal?.status ?? terminal?.turn?.status ?? 'completed';
    const hostCompleted = !hostFailure && !processResult.timedOut && !processResult.aborted && !processResult.spawnError && processResult.closeResult?.code === 0 && /turn\.completed$/i.test(String(eventType(terminal))) && terminalStatus === 'completed';
    const mechanismEligible = arm === 'off'
      ? jev.attempts === 0 && jev.adviceDeliveries === 0
      : jev.attempts > 0 && jev.validatedResponses > 0 && jev.assessedInvocations > 0 && jev.adviceDeliveries > 0;
    const comparisonEligible = hostCompleted && mechanismEligible && modelMatches && effortMatches && parsed.malformedLines === 0 && !processResult.aborted;
    const errors = [];
    if (hostFailure) errors.push(hostFailure.message);
    else if (processResult.closeResult?.code !== 0) errors.push(`Codex exited with code ${processResult.closeResult?.code ?? 'unknown'}`);
    if (!modelMatches) errors.push('resolved model differs from requested model');
    if (!effortMatches) errors.push('resolved effort differs from requested effort');
    if (parsed.malformedLines > 0) errors.push('Codex JSON stream contained malformed lines');
    if (!mechanismEligible) errors.push(arm === 'on' ? 'treatment lacked proved provider-backed actionable advice delivery' : 'control contained Jev activity');
    if (processResult.spawnError) errors.push(processResult.spawnError.message);
    receipt = {
      runId,
      arm,
      requestedModel: model,
      resolvedModel,
      modelEvidenceSource,
      requestedEffort: effort,
      resolvedEffort,
      effortEvidenceSource,
      exitCode: processResult.closeResult?.code ?? null,
      signal: processResult.closeResult?.signal ?? null,
      completion: hostCompleted && modelMatches && effortMatches,
      comparisonEligible,
      timeout: processResult.timedOut,
      aborted: processResult.aborted,
      wallMs: Date.now() - started,
      sessionId: session.sessionId ?? firstString(parsed.events.flatMap(event => [event?.thread_id, event?.threadId, event?.thread?.id])) ?? null,
      usage: collectUsage(parsed.events),
      cost: { reportedUsd: null, estimatedUsd: null, billedUsd: null, attribution: 'unavailable' },
      jev: { enabled: arm === 'on', ...jev },
      isolation: {
        ignoreUserConfig: false,
        isolatedUserConfig: true,
        ignoreRules: true,
        projectInstructionsDisabled: true,
        strictConfig: true,
        pluginId: arm === 'on' ? PLUGIN_ID : null,
        pluginVersion: arm === 'on' ? PLUGIN_VERSION : null,
        packageEvidence,
        controlPlaneEvidence,
        perRunState: arm === 'on' ? stateDir : null,
        authMode: 'symlink_to_existing_codex_auth',
        authSourceDigest: hash(authSource),
        modelEvidence: session,
        codexHomeRemovedAfterRun: true,
        cwd: resolvedWorkspace,
      },
      trace,
      hostFailure,
      raw: { stdoutPath, stderrPath, eventsPath, lastMessagePath },
      error: errors.length ? errors.join('; ') : null,
    };
  } catch (error) {
    receipt = {
      runId, arm, requestedModel: model, resolvedModel: null, requestedEffort: effort,
      resolvedEffort: null, exitCode: processResult?.closeResult?.code ?? null,
      signal: processResult?.closeResult?.signal ?? null, completion: false,
      comparisonEligible: false, timeout: processResult?.timedOut ?? false,
      aborted: processResult?.aborted ?? signal?.aborted ?? false,
      wallMs: Date.now() - started,
      usage: { inputTokens: null, cachedInputTokens: null, outputTokens: null, reasoningTokens: null },
      cost: { reportedUsd: null, estimatedUsd: null, billedUsd: null, attribution: 'unavailable' },
      jev: { enabled: arm === 'on', attempts: 0, responses: 0, validatedResponses: 0, abstentions: 0, requestIds: [], adviceDeliveries: 0 },
      isolation: { ignoreUserConfig: false, isolatedUserConfig: true, ignoreRules: true, pluginId: arm === 'on' ? PLUGIN_ID : null, packageEvidence, controlPlaneEvidence, cwd: resolvedWorkspace },
      raw: { stdoutPath, stderrPath, eventsPath, lastMessagePath },
      error: String(error?.message ?? error).slice(0, 2_000),
    };
  } finally {
    await rm(codexHome, { recursive: true, force: true });
    await rm(join(runRoot, 'plugins'), { recursive: true, force: true });
    await rm(join(runRoot, '.agents'), { recursive: true, force: true });
  }
  await writeJson(receiptPath, receipt);
  return receipt;
}

export const defaults = { codexPath: DEFAULT_CODEX, model: DEFAULT_MODEL, effort: DEFAULT_EFFORT };
