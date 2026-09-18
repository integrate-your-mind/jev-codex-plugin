import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import assert from 'node:assert/strict';

// Native Codex integration probe. This script is intentionally inert unless
// its explicit mutation gates are set by the caller. It captures only bounded
// hook/tool lifecycle metadata, never prompt, reasoning, or raw stream text.
const reportDir = resolve(process.argv[2] ?? '../jev-verification');
const fixtureDir = resolve(process.env.JEV_SMOKE_FIXTURE ?? join(reportDir, 'codex-native-fixture'));
const marketplacePath = resolve(process.env.JEV_MARKETPLACE_PATH ?? join(homedir(), '.agents/plugins/marketplace.json'));
const nativeTurn = process.env.JEV_NATIVE_TURN === '1';
const installPlugin = process.env.JEV_INSTALL_PLUGIN === '1';
const trustReviewedHooks = process.env.JEV_TRUST_REVIEWED_HOOKS === '1';
const enableAutomation = process.env.JEV_ENABLE_AUTOMATION === '1';
const EXPECTED_EVENTS = new Set(['sessionStart', 'userPromptSubmit', 'preToolUse', 'postToolUse', 'permissionRequest', 'preCompact', 'postCompact', 'interrupt', 'subagentStart', 'subagentStop', 'stop', 'sessionEnd']);
const NATIVE_SENTINEL = 'JEV_NATIVE_SENTINEL';
const scenario = process.env.JEV_NATIVE_SCENARIO ?? 'success';
if (!['success', 'failure', 'async'].includes(scenario)) throw new Error('Unknown JEV_NATIVE_SCENARIO');
const expectedExitCode = scenario === 'failure' ? 7 : 0;
const nativeCommandText = scenario === 'failure'
  ? `python3 -c 'import sys; print("${NATIVE_SENTINEL}"); sys.exit(7)'`
  : scenario === 'async'
  ? `python3 -c 'import time; time.sleep(2); print("${NATIVE_SENTINEL}")'`
  : `printf ${NATIVE_SENTINEL}`;
const RPC_TIMEOUT_MS = 20_000;
const TURN_TIMEOUT_MS = 60_000;

await mkdir(reportDir, { recursive: true });
await mkdir(fixtureDir, { recursive: true });

function hash(value) {
  return createHash('sha256').update(value).digest('hex');
}

function bounded(value, max = 4_000) {
  if (typeof value !== 'string') return undefined;
  return value.length <= max ? value : value.slice(-max);
}

function redact(value) {
  const secret = process.env.TYPESAFE_API_KEY;
  const text = bounded(String(value ?? '')) ?? '';
  return secret ? text.replaceAll(secret, '[REDACTED]') : text;
}

function compactStatus(value) {
  if (!value || typeof value !== 'object') return value;
  const result = {};
  for (const key of ['status', 'version', 'model', 'credentialConfigured', 'receiptPersisted', 'cached', 'stateDirectory', 'maxCallsPerDay', 'maxBytesPerDay']) {
    if (key in value && (typeof value[key] === 'string' || typeof value[key] === 'boolean' || typeof value[key] === 'number' || value[key] === null)) result[key] = value[key];
  }
  if (value.automation && typeof value.automation === 'object') {
    result.automation = {};
    for (const key of ['enabled', 'scope', 'maxHookCallsPerSession', 'maxCallsPerDay', 'maxBytesPerDay']) {
      if (key in value.automation) result.automation[key] = value.automation[key];
    }
    if (Array.isArray(value.automation.workspaces)) result.automation.workspaceCount = value.automation.workspaces.length;
  }
  // Retain accounting semantics and counts, but never the credential fingerprint.
  if (value.budget && typeof value.budget === 'object') {
    result.budget = {};
    for (const key of ['date', 'countingBasis', 'reservedAttempts', 'reservedPayloadBytes', 'status']) {
      if (key in value.budget) result.budget[key] = value.budget[key];
    }
  }
  if (value.evaluations && typeof value.evaluations === 'object') {
    result.evaluations = {};
    for (const key of ['date', 'timeZone', 'inventoryFiles', 'totals', 'currentCredential', 'otherCredential', 'unknownCredential', 'uniqueProviderRequestIds', 'malformedOrUnreadable', 'inventoryReadable', 'providerBilledRequests', 'providerBilledTokens', 'billingReconciled']) {
      if (key in value.evaluations) result.evaluations[key] = value.evaluations[key];
    }
  }
  return result;
}

function compactToolResult(result) {
  if (!result || typeof result !== 'object') return {};
  const structured = result.structuredContent;
  return {
    isError: result.isError === true,
    structuredContent: structured && typeof structured === 'object' ? compactStatus(structured) : undefined,
  };
}

function readConfigNames() {
  const python = String.raw`import json, os, pathlib, tomllib
p = pathlib.Path(os.environ.get("CODEX_HOME", str(pathlib.Path.home()/".codex"))) / "config.toml"
c = tomllib.loads(p.read_text()) if p.exists() else {}
print(json.dumps({"servers": list(c.get("mcp_servers", {})), "plugins": list(c.get("plugins", {}))}))`;
  return JSON.parse(execFileSync('python3', ['-c', python], { encoding: 'utf8' }));
}

const configNames = readConfigNames();
const args = ['app-server', '--stdio', '--disable', 'apps', '--disable', 'remote_plugin'];
for (const name of configNames.servers) args.push('-c', `mcp_servers.${name}.enabled=false`);
for (const name of configNames.plugins) {
  if (!name.startsWith('jev-workflows@')) args.push('-c', `plugins.${name}.enabled=false`);
}

const child = spawn('codex', args, {
  cwd: fixtureDir,
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, JEV_HOOKS_ENABLED: process.env.JEV_HOOKS_ENABLED ?? '1' },
});
const pending = new Map();
const turnCompletions = new Map();
const turnWaiters = new Map();
const relevantEvents = [];
let nextId = 0;
let stderr = '';
let childFailure;

function send(message) {
  if (!child.stdin.destroyed) child.stdin.write(JSON.stringify(message) + '\n');
}

function rejectPending(error) {
  childFailure = error;
  for (const pendingRequest of pending.values()) {
    clearTimeout(pendingRequest.timer);
    pendingRequest.reject(error);
  }
  pending.clear();
  for (const waiter of turnWaiters.values()) waiter.reject(error);
  turnWaiters.clear();
}

function compactItem(item) {
  if (!item || typeof item !== 'object') return undefined;
  if (item.type === 'commandExecution') {
    return {
      type: item.type,
      id: item.id,
      status: item.status,
      exitCode: item.exitCode,
      commandContainsSentinel: typeof item.command === 'string' && item.command.includes(NATIVE_SENTINEL),
      outputContainsSentinel: typeof item.aggregatedOutput === 'string' && item.aggregatedOutput.includes(NATIVE_SENTINEL),
    };
  }
  if (item.type === 'mcpToolCall') {
    return { type: item.type, id: item.id, server: item.server, tool: item.tool, status: item.status, pluginId: item.pluginId };
  }
  if (item.type === 'dynamicToolCall') {
    return { type: item.type, id: item.id, namespace: item.namespace, tool: item.tool, status: item.status, success: item.success };
  }
  return undefined;
}

function compactHookRun(run) {
  if (!run || typeof run !== 'object') return undefined;
  return {
    id: run.id,
    eventName: run.eventName,
    handlerType: run.handlerType,
    status: run.status,
    source: run.source,
    sourcePath: run.sourcePath,
    entryKinds: Array.isArray(run.entries) ? run.entries.map(entry => entry?.kind).filter(Boolean) : [],
    durationMs: run.durationMs,
    // Persist only the plugin's fixed fields, never arbitrary hook text.
    feedback: Array.isArray(run.entries) ? run.entries.flatMap(entry => {
      if (typeof entry?.text !== 'string') return [];
      const status = entry.text.match(/JEV advisory: status=(assessed|abstained|unavailable|skipped|preview)\b/);
      if (!status) return [];
      return [{kind: entry.kind, status: status[1],
        decision: entry.text.match(/\bdecision=(proceed|reconsider|gather_evidence|insufficient_evidence)\b/)?.[1],
        reason: entry.text.match(/\breason=([a-z_]{1,80})\b/)?.[1],
        receiptId: entry.text.match(/\breceipt=([a-f0-9-]{36})\b/)?.[1]}];
    }) : [],
  };
}

function captureNotification(message) {
  if (!message || typeof message.method !== 'string') return;
  if (message.method === 'hook/started' || message.method === 'hook/completed') {
    const run = compactHookRun(message.params?.run);
    if (run?.source === 'plugin') relevantEvents.push({ method: message.method, threadId: message.params?.threadId, turnId: message.params?.turnId, run });
    return;
  }
  if (message.method === 'item/started' || message.method === 'item/completed') {
    const item = compactItem(message.params?.item);
    if (item) relevantEvents.push({ method: message.method, threadId: message.params?.threadId, turnId: message.params?.turnId, item });
    return;
  }
  if (message.method === 'turn/completed') {
    const threadId = message.params?.threadId;
    const turn = message.params?.turn;
    const compact = { id: turn?.id, status: turn?.status, threadId };
    turnCompletions.set(threadId, compact);
    const waiter = turnWaiters.get(threadId);
    if (waiter) {
      turnWaiters.delete(threadId);
      waiter.resolve(compact);
    }
  }
}

child.on('error', rejectPending);
child.on('exit', (code, signal) => {
  if (code !== null || signal) rejectPending(new Error(`Codex probe exited: ${code ?? signal}`));
});
child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-12_000); });
const lines = createInterface({ input: child.stdout });
lines.on('line', line => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message.id !== undefined && pending.has(message.id)) {
    const request = pending.get(message.id);
    pending.delete(message.id);
    clearTimeout(request.timer);
    if (message.error) request.reject(new Error(JSON.stringify(message.error)));
    else request.resolve(message.result);
    return;
  }
  if (message.id !== undefined && message.method) {
    // approvalPolicy=never should avoid this path. Decline unexpected requests
    // rather than granting permissions or executing an unreviewed action.
    if (message.method === 'item/commandExecution/requestApproval') send({ id: message.id, result: { decision: 'decline' } });
    else send({ id: message.id, error: { code: -32601, message: 'Native smoke harness does not handle server requests' } });
    return;
  }
  captureNotification(message);
});

function rpc(method, params, timeoutMs = RPC_TIMEOUT_MS) {
  return new Promise((resolvePromise, reject) => {
    if (childFailure) { reject(childFailure); return; }
    const id = ++nextId;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Timed out: ${method}`));
    }, method === 'initialize' ? 90_000 : timeoutMs);
    pending.set(id, { resolve: resolvePromise, reject, timer });
    send({ id, method, params });
  });
}

function waitForTurn(threadId) {
  const completed = turnCompletions.get(threadId);
  if (completed) return Promise.resolve(completed);
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => {
      turnWaiters.delete(threadId);
      reject(new Error('Timed out waiting for turn/completed'));
    }, TURN_TIMEOUT_MS);
    turnWaiters.set(threadId, {
      resolve: value => { clearTimeout(timer); resolvePromise(value); },
      reject: error => { clearTimeout(timer); reject(error); },
    });
  });
}

function isJevHook(hook, pluginId) {
  const plugin = typeof hook?.pluginId === 'string' ? hook.pluginId : '';
  const path = typeof hook?.sourcePath === 'string' ? hook.sourcePath : '';
  return plugin === pluginId || plugin.includes('jev-workflows') || path.includes('/jev-workflows/');
}

function compactHookMetadata(hook) {
  const result = {};
  for (const key of ['key', 'eventName', 'matcher', 'sourcePath', 'source', 'pluginId', 'enabled', 'isManaged', 'currentHash', 'trustStatus', 'handlerType', 'command', 'async', 'timeoutSec']) {
    if (key in hook) result[key] = hook[key];
  }
  return result;
}

function validateJevHooks(entries, pluginId) {
  const hooks = entries.flatMap(entry => Array.isArray(entry?.hooks) ? entry.hooks : []).filter(hook => isJevHook(hook, pluginId));
  if (hooks.length === 0) throw new Error('No loaded Jev hooks found');
  const events = new Set(hooks.map(hook => String(hook.eventName)));
  assert.deepEqual([...events].sort(), [...EXPECTED_EVENTS].sort(), 'Loaded Jev hooks differ from documented lifecycle event set');
  const keys = new Set();
  for (const hook of hooks) {
    assert.equal(typeof hook.key, 'string');
    assert.equal(keys.has(hook.key), false, `Duplicate Jev hook key: ${hook.key}`);
    keys.add(hook.key);
    assert.equal(hook.handlerType, 'command', `Unexpected Jev hook handler type for ${hook.key}`);
    assert.equal(typeof hook.command, 'string');
    assert.equal(hook.command.includes('decision-hook.mjs'), true, `Jev hook does not point to decision-hook.mjs: ${hook.key}`);
    assert.equal(hook.command.includes('/dist/hook.mjs'), false, `Jev hook points to old failure hook: ${hook.key}`);
    const sourcePath = resolve(String(hook.sourcePath));
    const installedRoot = resolve(dirname(dirname(sourcePath)));
    const expectedCommandPath = join(installedRoot, 'dist', 'decision-hook.mjs');
    assert.equal(sourcePath.endsWith(join('hooks', 'hooks.json')), true, `Jev hook source is not installed hooks/hooks.json: ${hook.key}`);
    const statePrefix = process.env.JEV_EXPECTED_STATE_MODE === 'user' ? "JEV_STATE_MODE='user' "
      : process.env.JEV_EXPECTED_STATE_DIR ? `JEV_STATE_DIRECTORY='${process.env.JEV_EXPECTED_STATE_DIR.replaceAll("'", "'\\''")}' ` : '';
    const command = statePrefix && hook.command.startsWith(statePrefix) ? hook.command.slice(statePrefix.length) : hook.command;
    assert.equal((command === `node "${expectedCommandPath}"` || command === 'node "${PLUGIN_ROOT}/dist/decision-hook.mjs"'), true, `Jev hook command does not point to installed dist: ${hook.key}`);
    assert.equal(typeof hook.currentHash === 'string' && hook.currentHash.length > 0, true, `Jev hook has no current hash: ${hook.key}`);
  }
  return hooks;
}

function compactModels(data) {
  return (Array.isArray(data) ? data : []).map(model => ({
    id: model.id,
    model: model.model,
    displayName: model.displayName,
    hidden: model.hidden,
    isDefault: model.isDefault,
    defaultReasoningEffort: model.defaultReasoningEffort,
  }));
}

function chooseModel(models) {
  const requested = process.env.JEV_SMOKE_MODEL;
  if (requested) {
    const match = models.find(model => model.model === requested || model.id === requested);
    if (!match) throw new Error(`JEV_SMOKE_MODEL is absent from model/list: ${requested}`);
    return match.model;
  }
  const hostDefault = models.find(model => model.isDefault === true && model.hidden !== true) ?? models.find(model => model.isDefault === true) ?? models.find(model => model.hidden !== true) ?? models[0];
  if (!hostDefault?.model) throw new Error('model/list returned no usable host default');
  return hostDefault.model;
}

async function readDecisionReceipts(threadSessionId, stateDirectory) {
  const result = { provided: Boolean(stateDirectory), correlated: false, markerCount: 0, invocationCount: 0, correlatedInvocationCount: 0, matchedReceipts: [] };
  if (!stateDirectory) return result;
  const dataRoot = resolve(stateDirectory);
  const workspace = await realpath(fixtureDir);
  const receiptDir = join(dataRoot, 'decision-hook-v1', hash(workspace), hash(threadSessionId));
  result.sessionHash = hash(threadSessionId);
  try {
    const entries = await readdir(receiptDir, { withFileTypes: true });
    const markers = entries.filter(entry => entry.isFile() && /^[a-f0-9]{64}$/.test(entry.name)).map(entry => entry.name);
    result.markerCount = markers.length;
    const invocationDirectory = join(receiptDir, 'invocations');
    const invocationEntries = await readdir(invocationDirectory, { withFileTypes: true }).catch(() => []);
    const invocationFiles = invocationEntries.filter(entry => entry.isFile() && /^[a-f0-9]{64}\.json$/.test(entry.name)).slice(0, 50);
    result.invocationCount = invocationFiles.length;
    for (const entry of invocationFiles) {
      try {
        const receipt = JSON.parse(await readFile(join(invocationDirectory, entry.name), 'utf8'));
        if (receipt && receipt.sessionHash === result.sessionHash) {
          result.correlatedInvocationCount += 1;
          let providerReceipt;
          if (/^[a-f0-9-]{36}$/.test(receipt.referenceReceiptId ?? '')) {
            providerReceipt = JSON.parse(await readFile(join(dataRoot, 'receipts', `${receipt.referenceReceiptId}.json`), 'utf8'));
          }
          result.matchedReceipts.push({
            file: entry.name,
            event: receipt.event,
            sessionHash: receipt.sessionHash,
            toolIdHash: receipt.toolIdHash,
            referenceReceiptId: receipt.referenceReceiptId,
            classification: receipt.classification,
            assessmentStatus: receipt.assessmentStatus,
            reasonCode: receipt.reasonCode,
            evidenceIds: receipt.evidenceIds,
            contextBytes: receipt.contextBytes,
            contextTruncated: receipt.contextTruncated,
            evidenceTruncated: receipt.evidenceTruncated,
            providerReceipt,
            output: receipt.output && typeof receipt.output === 'object'
              ? { status: receipt.output.status, exitCode: receipt.output.exitCode, isError: receipt.output.isError, resultExcerptBytes: receipt.output.resultExcerptBytes, resultExcerptDigest: receipt.output.resultExcerptDigest }
              : undefined,
          });
        }
      } catch {
        // A malformed private receipt is not evidence of a successful invocation.
      }
    }
    result.correlated = result.correlatedInvocationCount > 0;
  } catch {
    result.correlated = false;
  }
  return result;
}

const report = {
  startedAt: new Date().toISOString(),
  cliProbe: 'codex-native-smoke-v0.2',
  ephemeral: true,
  isolatedCodexHome: process.env.CODEX_HOME ?? null,
  mutationGates: { installPlugin, trustReviewedHooks, enableAutomation },
  nativeTurnRequested: nativeTurn,
  scenario,
  expectedExitCode,
  fixtureDir,
  generativeTurns: 0,
  events: relevantEvents,
};

let threadId;
try {
  if (nativeTurn && !enableAutomation) throw new Error('JEV_NATIVE_TURN=1 requires JEV_ENABLE_AUTOMATION=1');
  await rpc('initialize', {
    clientInfo: { name: 'jev_native_smoke', title: 'Jev native plugin smoke test', version: '0.2.2' },
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
  report.initialize = { completed: true };
  send({ method: 'initialized', params: {} });

  if (installPlugin) {
    const installed = await rpc('plugin/install', { marketplacePath, pluginName: 'jev-workflows' });
    report.install = { completed: true, responseType: typeof installed };
  }

  const pluginRead = await rpc('plugin/read', { marketplacePath, pluginName: 'jev-workflows' });
  const detail = pluginRead?.plugin;
  const pluginId = detail?.summary?.id ?? 'jev-workflows';
  report.plugin = {
    id: pluginId,
    name: detail?.summary?.name,
    installed: detail?.summary?.installed,
    enabled: detail?.summary?.enabled,
    localVersion: detail?.summary?.localVersion,
    source: detail?.summary?.source,
    mcpServers: detail?.mcpServers,
    skills: Array.isArray(detail?.skills) ? detail.skills.map(skill => skill.name).filter(Boolean) : [],
    hooks: Array.isArray(detail?.hooks) ? detail.hooks.map(hook => ({ key: hook.key, eventName: hook.eventName })) : [],
  };
  assert.equal(Array.isArray(detail?.mcpServers) && detail.mcpServers.some(name => String(name).includes('jev-workflows')), true, 'Jev MCP server missing from plugin/read');

  let hookList = await rpc('hooks/list', { cwds: [fixtureDir] });
  let jevHooks = validateJevHooks(hookList?.data ?? [], pluginId);
  report.hooks = jevHooks.map(compactHookMetadata);
  report.hookInspection = { expectedEvents: [...EXPECTED_EVENTS], loadedCount: jevHooks.length, permissionRequest: 'advisory-only; no permission decisions' };

  if (trustReviewedHooks) {
    const trusted = {};
    for (const hook of jevHooks) trusted[hook.key] = { trusted_hash: hook.currentHash };
    report.trustWrite = { keyCount: Object.keys(trusted).length, keyPaths: ['hooks.state'], mergeStrategy: 'upsert', reloadUserConfig: true };
    await rpc('config/batchWrite', { edits: Object.entries(trusted).map(([key, value]) => ({keyPath: `hooks.state.${JSON.stringify(key)}`, value, mergeStrategy: 'upsert'})), reloadUserConfig: true });
    hookList = await rpc('hooks/list', { cwds: [fixtureDir] });
    jevHooks = validateJevHooks(hookList?.data ?? [], pluginId);
    report.hooks = jevHooks.map(compactHookMetadata);
  }
  report.trust = jevHooks.map(hook => ({ key: hook.key, eventName: hook.eventName, trustStatus: hook.trustStatus, enabled: hook.enabled, currentHash: hook.currentHash }));

  const models = [];
  let cursor;
  for (let page = 0; page < 3; page += 1) {
    const modelPage = await rpc('model/list', { limit: 100, includeHidden: false, cursor: cursor ?? null });
    models.push(...(modelPage?.data ?? []));
    cursor = modelPage?.nextCursor;
    if (!cursor) break;
  }
  report.models = compactModels(models);
  const selectedModel = chooseModel(models);
  report.selectedModel = selectedModel;

  const started = await rpc('thread/start', {
    cwd: fixtureDir,
    ephemeral: true,
    approvalPolicy: 'never',
    sandbox: 'workspace-write',
    model: selectedModel,
  });
  threadId = started?.thread?.id;
  assert.equal(typeof threadId, 'string', 'thread/start did not return a thread id');
  let sessionId = started.thread.sessionId;
  report.thread = { id: threadId, sessionId, cwd: started.thread.cwd, ephemeral: started.thread.ephemeral, model: started.model, modelProvider: started.modelProvider };

  const serverStatus = await rpc('mcpServerStatus/list', { threadId, detail: 'full', limit: 100 });
  const jevServer = (serverStatus?.data ?? []).find(server => String(server.pluginId ?? '').includes('jev-workflows') || String(server.name).includes('jev-workflows'));
  assert.ok(jevServer, 'Installed plugin MCP server missing from runtime inventory');
  report.mcp = { name: jevServer.name, pluginId: jevServer.pluginId, runtimeStatus: jevServer.runtimeStatus, toolNames: Object.keys(jevServer.tools ?? {}) };

  const statusCall = await rpc('mcpServer/tool/call', { threadId, server: jevServer.name, tool: 'jev_status', arguments: {} });
  report.statusCall = compactToolResult(statusCall);
  const accountingStatus = statusCall.structuredContent;
  assert.equal(accountingStatus?.budget?.countingBasis, 'local_pre_dispatch_reservations', 'Native MCP must distinguish reservations from successful requests');
  assert.equal(accountingStatus?.evaluations?.billingReconciled, false, 'Local status must not claim provider billing reconciliation');
  assert.equal(accountingStatus?.evaluations?.providerBilledRequests, null);
  assert.equal(accountingStatus?.evaluations?.providerBilledTokens, null);
  assert.equal(typeof accountingStatus?.evaluations?.inventoryReadable, 'boolean');
  for (const [key, count] of Object.entries(accountingStatus.evaluations.totals)) {
    assert.equal(count, accountingStatus.evaluations.currentCredential[key] + accountingStatus.evaluations.otherCredential[key] + accountingStatus.evaluations.unknownCredential[key], `Credential buckets must partition ${key}`);
  }
  if (process.env.JEV_EXPECTED_STATE_DIR) assert.equal(statusCall.structuredContent?.stateDirectory, process.env.JEV_EXPECTED_STATE_DIR, 'Host variant must preserve shared accounting directory');
  if (enableAutomation) {
    // Reuse an already-authorized all-workspace policy. The native probe must
    // not narrow shared installation scope while other authorized work runs.
    const existing = statusCall.structuredContent?.automation;
    if (existing?.enabled === true && existing.scope === 'all-workspaces') {
      report.automation = {reusedExistingPolicy: true, structuredContent: existing};
    } else {
      const automationCall = await rpc('mcpServer/tool/call', {
      threadId,
      server: jevServer.name,
      tool: 'configure_automation',
      arguments: { enabled: true, scope: 'workspaces', workspaces: [fixtureDir], maxHookCallsPerSession: null, maxCallsPerDay: null, maxBytesPerDay: null },
    });
      report.automation = compactToolResult(automationCall);
    }
    if (nativeTurn) {
      const active = await rpc('thread/start', {cwd: fixtureDir, ephemeral: true, approvalPolicy: 'never', sandbox: 'workspace-write', model: selectedModel});
      threadId = active.thread.id;
      sessionId = active.thread.sessionId;
      report.thread = {id: threadId, sessionId, cwd: active.thread.cwd, ephemeral: true, model: active.model};
    }
  }

  if (nativeTurn) {
    const turnStart = await rpc('turn/start', {
      threadId,
      cwd: fixtureDir,
      input: [{ type: 'text', text: `This is an isolated plugin verification fixture. Use the command execution tool to run exactly: ${nativeCommandText}\n${scenario === 'async' ? 'Set yield_time_ms to 1000 and poll the returned running session until the command completes. ' : ''}The expected exit code is ${expectedExitCode}${scenario === 'failure' ? '; this intentional nonzero result is the test, so do not fix or rerun it' : ''}. Do not run any other command. After it completes, reply with a short factual confirmation.`, text_elements: [] }],
      model: selectedModel,
      effort: 'low',
      approvalPolicy: 'never',
      sandboxPolicy: { type: 'workspaceWrite', writableRoots: [fixtureDir], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false },
    }, 30_000);
    report.generativeTurns = 1;
    report.turn = { id: turnStart?.turn?.id, requestedModel: selectedModel };
    report.turnCompletion = await waitForTurn(threadId);
    assert.equal(report.turnCompletion.status, 'completed', 'Native turn did not complete');

    // This installed host advertises thread/items/list but rejects it as not supported.
    // Completed native item notifications are direct runtime evidence from this session.
    const items = relevantEvents.filter(event => event.method === 'item/completed' && event.threadId === threadId && event.item).map(event => ({...event.item, turnId:event.turnId}));
    report.items = items;
    const commandItems = items.filter(item => item.type === 'commandExecution');
    const nativeCommand = commandItems.find(item => item.commandContainsSentinel && item.outputContainsSentinel);
    assert.equal(commandItems.length, 1, 'Native turn did not produce exactly one command execution item');
    assert.ok(nativeCommand, 'Completed native command did not contain the sentinel in command and output');
    assert.equal(nativeCommand.status, expectedExitCode === 0 ? 'completed' : 'failed', 'Native command item did not reach the expected terminal state');
    assert.equal(nativeCommand.exitCode, expectedExitCode, 'Native command item did not return the expected fixture exit code');

    const stateDirectory = report.statusCall?.structuredContent?.stateDirectory;
    report.receipts = await readDecisionReceipts(sessionId, stateDirectory);
    assert.equal(report.receipts.correlated, true, 'No Jev decision-hook receipt files correlated to the native session hash');
    for (const event of ['UserPromptSubmit','PreToolUse','PostToolUse','Stop']) {
      assert.ok(report.receipts.matchedReceipts.some(r => r.event === event && ['assessed','abstained','unavailable'].includes(r.providerReceipt?.status)), `No live Jev response receipt for ${event}`);
    }
    report.providerStatuses = report.receipts.matchedReceipts.map(r => ({event:r.event,status:r.providerReceipt?.status,reason:r.providerReceipt?.reasonCode}));
    // Some native hosts expose only stdout to PostToolUse. Verify the actual
    // fixture output by digest; validate exit metadata when the host provides
    // it, and retain the authoritative command-item exit check above.
    const expectedOutputDigests = new Set([hash(NATIVE_SENTINEL), hash(`${NATIVE_SENTINEL}\n`)]);
    const terminalReceipt = report.receipts.matchedReceipts.find(receipt => receipt.event === 'PostToolUse'
      && expectedOutputDigests.has(receipt.output?.resultExcerptDigest)
      && receipt.providerReceipt?.evidenceIds?.some(id => id === 'tool.result' || id === 'tool.failure'));
    assert.ok(terminalReceipt, 'Native post-tool assessment did not include the observed terminal output evidence');
    report.terminalEvidence = {
      receiptId: terminalReceipt.referenceReceiptId,
      stdoutDigestMatched: true,
      hookExitCodeExposed: terminalReceipt.output.exitCode !== undefined,
      commandItemExitCode: nativeCommand.exitCode,
    };
    if (terminalReceipt.output.exitCode !== undefined) assert.equal(terminalReceipt.output.exitCode, expectedExitCode);
    assert.ok(report.receipts.matchedReceipts.some(receipt => receipt.event === 'Stop'
      && receipt.providerReceipt?.evidenceIds?.includes('result.tool_summaries')),
    'Native task-end assessment did not include same-turn observed tool evidence');
    if (scenario === 'async') {
      report.intermediateRunningHookExposed = report.receipts.matchedReceipts.some(receipt => receipt.event === 'PostToolUse'
        && receipt.output?.status === 'running');
      // Native command hooks may fire only on terminal completion even when
      // the execution tool yields a running session. Do not invent a hook.
    }
    for (const event of ['preToolUse', 'postToolUse', 'stop']) {
      const completed = relevantEvents.filter(entry => entry.method === 'hook/completed' && entry.threadId === threadId && entry.run?.eventName === event);
      assert.ok(completed.some(entry => entry.run.feedback.some(feedback =>
        ['assessed', 'abstained', 'unavailable'].includes(feedback.status) && report.receipts.matchedReceipts.some(receipt => receipt.referenceReceiptId === feedback.receiptId))),
      `No model/user-visible feedback correlated to a live provider receipt for ${event}`);
    }
    assert.equal(jevHooks.length, EXPECTED_EVENTS.size, 'Native smoke requires every documented lifecycle hook');
    assert.equal(jevHooks.every(hook => hook.trustStatus === 'trusted'), true, 'Native smoke requires all Jev hooks to be trusted');
  }
  report.runtimeChecksPassed = true;
  if (nativeTurn && process.env.JEV_ENABLE_ALL_AFTER_PASS === '1') {
    const enabled = await rpc('mcpServer/tool/call', {threadId, server: jevServer.name, tool: 'configure_automation', arguments: {enabled: true, scope: 'all-workspaces', maxHookCallsPerSession: null, maxCallsPerDay: null, maxBytesPerDay: null}});
    assert.equal(enabled.structuredContent?.enabled, true);
    assert.equal(enabled.structuredContent?.scope, 'all-workspaces');
    report.finalAutomation = enabled.structuredContent;
    for (const key of ['maxCallsPerDay','maxBytesPerDay','maxHookCallsPerSession']) assert.equal(enabled.structuredContent[key], null);
    const finalStatus = await rpc('mcpServer/tool/call', {threadId, server: jevServer.name, tool:'jev_status', arguments:{}});
    report.finalStatus = finalStatus.structuredContent;
    if (process.env.JEV_PUBLISH_TRUST_CONFIG) {
      const reviewed = {};
      for (const hook of jevHooks) reviewed[hook.key] = {trusted_hash:hook.currentHash};
      await rpc('config/batchWrite', {filePath:process.env.JEV_PUBLISH_TRUST_CONFIG, edits:Object.entries(reviewed).map(([key, value]) => ({keyPath:`hooks.state.${JSON.stringify(key)}`,value,mergeStrategy:'upsert'})), reloadUserConfig:true});
      report.publishedTrust = {filePath:process.env.JEV_PUBLISH_TRUST_CONFIG,keyCount:Object.keys(reviewed).length};
    }
  }
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.error = bounded(String(error), 2_000);
  report.diagnostic = redact(stderr);
  process.exitCode = 1;
} finally {
  for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error('Probe closed')); }
  pending.clear();
  turnWaiters.clear();
  lines.close();
  if (!child.stdin.destroyed) child.stdin.end();
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  await new Promise(resolvePromise => {
    if (child.exitCode !== null || child.signalCode !== null) resolvePromise();
    else {
      child.once('exit', resolvePromise);
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        resolvePromise();
      }, 2_000).unref();
    }
  });
  report.events = relevantEvents.slice(0, 200);
  report.finishedAt = new Date().toISOString();
  await writeFile(join(reportDir, 'codex-native-runtime.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ passed: report.passed, error: report.error, report: join(reportDir, 'codex-native-runtime.json') }, null, 2));
}
