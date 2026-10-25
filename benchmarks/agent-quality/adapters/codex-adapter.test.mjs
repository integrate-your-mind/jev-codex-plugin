import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { execFile as nodeExecFile, spawn as nodeSpawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectCodexSession, readJevAccounting, runTrial, writeHookTrusts } from './codex.mjs';

const NATIVE_CODEX = '/opt/homebrew/bin/codex';

function fakeSpawn(events, capture, code = 0) {
  return (file, args, options) => {
    capture.push({ file, args, options });
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.kill = () => {};
    setImmediate(() => {
      child.stdout.end(events.map(event => `${JSON.stringify(event)}\n`).join(''));
      child.stderr.end();
      child.emit('close', code, null);
    });
    return child;
  };
}

function controlPlane(arm, model = 'gpt-6-astra') {
  return async () => ({
    models: [{ id: model, model, supportedReasoningEfforts: ['ultra'] }],
    trustedHooks: arm === 'on'
      ? Array.from({ length: 12 }, (_, index) => ({ key: `jev-workflows@personal:hook:${index}`, currentHash: `sha256:${String(index).padStart(64, '0')}`, eventName: `event-${index}` }))
      : [],
  });
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'jev-codex-adapter-'));
  const workspace = join(root, 'workspace');
  const outputDir = join(root, 'private');
  const codexHome = join(root, 'source-codex-home');
  await mkdir(workspace);
  await mkdir(codexHome);
  await writeFile(join(codexHome, 'auth.json'), '{"fixture":true}\n', { mode: 0o600 });
  return { root, workspace, outputDir, codexHome };
}

test('off arm excludes ambient config, plugins, rules, and Jev credentials', async () => {
  const f = await fixture();
  const launches = [];
  const priorKey = process.env.TYPESAFE_API_KEY;
  process.env.TYPESAFE_API_KEY = 'must-not-reach-control';
  try {
    const receipt = await runTrial({
      workspace: f.workspace,
      prompt: 'repair the fixture',
      arm: 'off',
      outputDir: f.outputDir,
      runId: 'off',
      sourceCodexHome: f.codexHome,
      inspectControlPlaneFn: controlPlane('off'),
      spawnFn: fakeSpawn([
        { type: 'thread.started', thread_id: 't1', model: 'gpt-6-astra', effort: 'ultra' },
        { type: 'item.completed', item: { type: 'file_change', status: 'completed' } },
        { type: 'turn.completed', status: 'completed', usage: { input_tokens: 12, cached_input_tokens: 2, output_tokens: 4 } },
      ], launches),
    });
    assert.equal(receipt.completion, true);
    assert.equal(receipt.comparisonEligible, true);
    assert.equal(receipt.jev.attempts, 0);
    assert.equal(launches.length, 1);
    const [{ args, options }] = launches;
    assert.equal(args.includes('--ignore-user-config'), false);
    assert.equal(args.includes('--ignore-rules'), true);
    assert.equal(args.includes('--ephemeral'), false);
    assert.equal(args.includes('--dangerously-bypass-hook-trust'), false);
    assert.equal(args.includes('features.plugins=false'), true);
    assert.equal(args.some(value => value.includes('shell_environment_policy.set.HOME=')), false);
    assert.equal(args.some(value => value.includes('"HOME"')), false);
    assert.equal(options.env.TYPESAFE_API_KEY, undefined);
    assert.match(options.env.CODEX_HOME, /private\/off\/codex-home$/);
    assert.deepEqual(receipt.usage, { inputTokens: 12, cachedInputTokens: 2, outputTokens: 4, reasoningTokens: null });
  } finally {
    if (priorKey === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = priorKey;
    await rm(f.root, { recursive: true, force: true });
  }
});

test('on arm stages only Jev, retains private provider evidence, and proves advice delivery', async () => {
  const f = await fixture();
  const launches = [];
  const stages = [];
  const priorKey = process.env.TYPESAFE_API_KEY;
  process.env.TYPESAFE_API_KEY = 'fixture-provider-key';
  try {
    const receiptId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const receipt = await runTrial({
      workspace: f.workspace,
      prompt: 'repair the fixture',
      arm: 'on',
      pluginRoot: join(f.root, 'plugin-source'),
      outputDir: f.outputDir,
      runId: 'on',
      sourceCodexHome: f.codexHome,
      inspectControlPlaneFn: controlPlane('on'),
      stagePluginFn: async ({ target, stateDir }) => {
        stages.push({ target, stateDir });
        await mkdir(target, { recursive: true });
        await mkdir(join(stateDir, 'receipts'), { recursive: true });
        await writeFile(join(stateDir, 'receipts', `${receiptId}.json`), JSON.stringify({
          receiptId, status: 'assessed', usage: { input_tokens: 10, output_tokens: 2 }, latencyMs: 9, transport: {
            fetchInvoked: true, responseStatus: 200, validatedResponse: true,
            providerRequestId: 'provider-request-1',
          },
        }));
        const invocationDir = join(stateDir, 'decision-hook-v1', 'workspace', 'session', 'invocations');
        await mkdir(invocationDir, { recursive: true });
        await writeFile(join(invocationDir, 'event.json'), JSON.stringify({
          assessmentStatus: 'assessed', classification: 'proceed', referenceReceiptId: receiptId,
        }));
        return { version: '0.5.1', sourceHashes: { fixture: 'hash' } };
      },
      spawnFn: fakeSpawn([
        { type: 'thread.started', thread_id: 't2', model: 'gpt-6-astra', effort: 'ultra' },
        { type: 'hook.completed', run: { pluginId: 'jev-workflows@personal', eventName: 'UserPromptSubmit', status: 'completed' }, output: `JEV advisory: status=assessed; decision=proceed; receipt=${receiptId}; advisory only, continue ordinary reasoning.` },
        { type: 'turn.completed', status: 'completed', usage: { input_tokens: 20, output_tokens: 7, reasoning_tokens: 3 } },
      ], launches),
    });
    assert.equal(receipt.completion, true);
    assert.equal(receipt.comparisonEligible, true);
    assert.equal(receipt.jev.attempts, 1);
    assert.equal(receipt.jev.validatedResponses, 1);
    assert.equal(receipt.jev.assessedInvocations, 1);
    assert.equal(receipt.jev.adviceDeliveries, 1);
    assert.deepEqual(receipt.jev.usage, { inputTokens: 10, cachedInputTokens: null, cacheCreationTokens: null, outputTokens: 2 });
    assert.deepEqual(receipt.jev.latenciesMs, [9]);
    assert.deepEqual(receipt.jev.deliveries, [{ status: 'assessed', decision: 'proceed', receiptId, evidenceSource: 'exec_json_stream' }]);
    assert.deepEqual(receipt.jev.requestIds, ['provider-request-1']);
    assert.equal(stages.length, 1);
    assert.match(stages[0].target, /private\/on\/plugins\/jev-workflows$/);
    assert.match(stages[0].stateDir, /private\/on\/jev-state$/);
    const [{ args, options }] = launches;
    assert.equal(args.includes('features.plugins=true'), true);
    assert.equal(args.includes('plugins."jev-workflows@personal".enabled=true'), true);
    assert.equal(args.includes('--dangerously-bypass-hook-trust'), false);
    assert.equal(args.some(value => value.startsWith('hooks.state.')), false);
    assert.equal(options.env.TYPESAFE_API_KEY, 'fixture-provider-key');
    const policy = JSON.parse(await readFile(join(stages[0].stateDir, 'policy.json'), 'utf8'));
    assert.deepEqual([policy.maxCallsPerDay, policy.maxBytesPerDay, policy.maxHookCallsPerSession], [null, null, null]);
  } finally {
    if (priorKey === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = priorKey;
    await rm(f.root, { recursive: true, force: true });
  }
});

test('private session capture retains only compact developer advisory evidence', async () => {
  const f = await fixture();
  const sessionDir = join(f.root, 'private-codex-home', 'sessions', '2026', '10', '16');
  const receiptId = '11111111-1111-4111-8111-111111111111';
  await mkdir(sessionDir, { recursive: true });
  await writeFile(join(sessionDir, 'session.jsonl'), [
    JSON.stringify({ type: 'session_meta', payload: { id: 'session-1' } }),
    JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-6-astra', effort: 'high', cwd: f.workspace } }),
    JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'JEV advisory: status=assessed; decision=proceed; receipt=22222222-2222-4222-8222-222222222222' }] } }),
    JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: `JEV advisory: status=assessed; decision=proceed; confidence=0.8; receipt=${receiptId}; advisory only.` }] } }),
  ].join('\n'));
  try {
    const session = await inspectCodexSession(join(f.root, 'private-codex-home'));
    assert.equal(session.sessionId, 'session-1');
    assert.deepEqual(session.turn, { model: 'gpt-6-astra', effort: 'high', cwd: f.workspace, approvalPolicy: null, sandboxPolicyType: null });
    assert.deepEqual(session.advice, [{ status: 'assessed', decision: 'proceed', receiptId, evidenceSource: 'isolated_session_developer_message' }]);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('Jev accounting deduplicates receipts and requires session, invocation, and transport correlation for delivery', async () => {
  const f = await fixture();
  const stateDir = join(f.root, 'jev-state');
  const receiptDir = join(stateDir, 'receipts');
  const invocationDir = join(stateDir, 'decision-hook-v1', 'scope', 'invocations');
  const receiptId = '33333333-3333-4333-8333-333333333333';
  await mkdir(receiptDir, { recursive: true });
  await mkdir(invocationDir, { recursive: true });
  const providerReceipt = { receiptId, status: 'assessed', usage: { input_tokens: 10, output_tokens: 2 }, latencyMs: 9, transport: { fetchInvoked: true, responseStatus: 200, validatedResponse: true, providerRequestId: 'req_1' } };
  await writeFile(join(receiptDir, `${receiptId}.json`), JSON.stringify(providerReceipt));
  await writeFile(join(receiptDir, '55555555-5555-4555-8555-555555555555.json'), JSON.stringify(providerReceipt));
  await writeFile(join(invocationDir, 'one.json'), JSON.stringify({ referenceReceiptId: receiptId, assessmentStatus: 'assessed', classification: 'proceed' }));
  try {
    const accounting = await readJevAccounting(stateDir, [
      { status: 'assessed', decision: 'proceed', receiptId, evidenceSource: 'isolated_session_developer_message' },
      { status: 'assessed', decision: 'proceed', receiptId: '44444444-4444-4444-8444-444444444444', evidenceSource: 'isolated_session_developer_message' },
    ]);
    assert.equal(accounting.fetchInvoked, 1);
    assert.equal(accounting.responses, 1);
    assert.equal(accounting.validatedResponses, 1);
    assert.equal(accounting.adviceDeliveries, 1);
    assert.equal(accounting.deliveryReceipts, 1);
    assert.deepEqual(accounting.usage, { inputTokens: 10, cachedInputTokens: null, cacheCreationTokens: null, outputTokens: 2 });
    assert.deepEqual(accounting.latenciesMs, [9]);
    assert.deepEqual(accounting.deliveries, [{ status: 'assessed', decision: 'proceed', receiptId, evidenceSource: 'isolated_session_developer_message' }]);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('native Codex accepts exact hook trust written to an isolated private home', async t => {
  if (process.platform !== 'darwin') return t.skip('native Codex integration is macOS-only');
  const f = await fixture();
  const privateHome = join(f.root, 'private-codex-home');
  await mkdir(privateHome, { mode: 0o700 });
  const env = { ...process.env, CODEX_HOME: privateHome };
  const child = nodeSpawn(NATIVE_CODEX, [
    'app-server', '--stdio', '--strict-config', '--disable', 'apps', '--disable', 'remote_plugin', '--disable', 'plugins',
  ], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  let buffer = '';
  let stderr = '';
  let nextId = 0;
  const pending = new Map();
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.stdout.on('data', chunk => {
    buffer += chunk;
    for (;;) {
      const newline = buffer.indexOf('\n');
      if (newline < 0) break;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      const request = pending.get(message.id);
      if (!request) continue;
      pending.delete(message.id);
      if (message.error) request.reject(new Error(message.error.message ?? 'RPC failed'));
      else request.resolve(message.result);
    }
  });
  const rpc = (method, params) => new Promise((resolvePromise, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve: resolvePromise, reject });
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
  });
  try {
    await rpc('initialize', {
      clientInfo: { name: 'jev_agent_quality_test', title: 'Jev agent quality test', version: '1.0.0' },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    child.stdin.write(`${JSON.stringify({ method: 'initialized', params: {} })}\n`);
    const hook = {
      key: 'jev-workflows@personal:hooks/hooks.json:pre_tool_use:0:0',
      currentHash: `sha256:${'a'.repeat(64)}`,
    };
    await writeHookTrusts(rpc, [hook]);
    child.stdin.end();
    await new Promise((resolveClose, reject) => {
      child.once('close', resolveClose);
      child.once('error', reject);
    });
    const config = await readFile(join(privateHome, 'config.toml'), 'utf8');
    assert.match(config, /jev-workflows@personal:hooks\/hooks\.json:pre_tool_use:0:0/);
    assert.match(config, new RegExp(hook.currentHash));
    await new Promise((resolvePromise, reject) => {
      nodeExecFile(NATIVE_CODEX, ['debug', 'models', '--bundled'], {
        env, encoding: 'utf8', timeout: 30_000, maxBuffer: 2_000_000,
      }, (error, stdout, nativeStderr) => {
        if (error) reject(Object.assign(error, { stdout, stderr: nativeStderr }));
        else resolvePromise();
      });
    });
    assert.equal(stderr, '');
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await rm(f.root, { recursive: true, force: true });
  }
});

test('successful exit is not comparison eligible without provider-backed actionable advice', async () => {
  const f = await fixture();
  try {
    const receipt = await runTrial({
      workspace: f.workspace,
      prompt: 'repair',
      arm: 'on',
      pluginRoot: join(f.root, 'plugin-source'),
      outputDir: f.outputDir,
      runId: 'missing-advice',
      sourceCodexHome: f.codexHome,
      inspectControlPlaneFn: controlPlane('on'),
      stagePluginFn: async ({ target }) => { await mkdir(target, { recursive: true }); return { version: '0.5.1' }; },
      spawnFn: fakeSpawn([
        { type: 'thread.started', model: 'gpt-6-astra', effort: 'ultra' },
        { type: 'turn.completed', status: 'completed' },
      ], []),
    });
    assert.equal(receipt.completion, true);
    assert.equal(receipt.comparisonEligible, false);
    assert.match(receipt.error, /lacked proved provider-backed actionable advice/);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('private evidence is rejected inside the candidate workspace', async () => {
  const f = await fixture();
  try {
    await assert.rejects(runTrial({
      workspace: f.workspace,
      prompt: 'repair',
      arm: 'off',
      outputDir: join(f.workspace, 'hidden'),
      sourceCodexHome: f.codexHome,
    }), /outside the candidate workspace/);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('failed provider turn retains the cause and is never comparison eligible', async () => {
  const f = await fixture();
  try {
    const receipt = await runTrial({
      workspace: f.workspace,
      prompt: 'repair',
      arm: 'off',
      outputDir: f.outputDir,
      runId: 'provider-failure',
      sourceCodexHome: f.codexHome,
      inspectControlPlaneFn: controlPlane('off'),
      spawnFn: fakeSpawn([
        { type: 'thread.started', model: 'gpt-6-astra', effort: 'ultra' },
        { type: 'turn.started' },
        { type: 'turn.failed', error: { message: '{"type":"error","status":400,"error":{"type":"invalid_request_error","message":"unsupported model"}}' } },
      ], [], 1),
    });
    assert.equal(receipt.completion, false);
    assert.equal(receipt.comparisonEligible, false);
    assert.equal(receipt.hostFailure.status, 400);
    assert.equal(receipt.hostFailure.message, 'unsupported model');
    assert.match(receipt.error, /^unsupported model/);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('unavailable model is rejected before spawning a model turn', async () => {
  const f = await fixture();
  let spawned = false;
  try {
    const receipt = await runTrial({
      workspace: f.workspace,
      prompt: 'repair',
      arm: 'off',
      model: 'gpt-6.1-sol',
      outputDir: f.outputDir,
      runId: 'missing-model',
      sourceCodexHome: f.codexHome,
      inspectControlPlaneFn: controlPlane('off', 'gpt-6-astra'),
      spawnFn: () => { spawned = true; throw new Error('must not spawn'); },
    });
    assert.equal(spawned, false);
    assert.equal(receipt.completion, false);
    assert.match(receipt.error, /model is unavailable/);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
