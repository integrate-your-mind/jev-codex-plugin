import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runTrial, stagePlugin, readJevAccounting } from './claude.mjs';

const noStage = async (_source, destination) => destination;

function fakeSpawn(lines, code = 0) {
  return (_file, _args, opts) => {
    const events = lines.map((line) => `${JSON.stringify(line)}\n`).join('');
    const listeners = {};
    const child = {
      pid: process.pid,
      stdout: { setEncoding() {}, on(_event, cb) { if (_event === 'data') setImmediate(() => cb(events)); } },
      stderr: { setEncoding() {}, on() {} },
      stdin: { end() {}, on() {} },
      on(event, cb) { (listeners[event] ??= []).push(cb); if (event === 'error') this.error = cb; return this; },
      once(event, cb) { (listeners[event] ??= []).push(cb); if (event === 'close') setImmediate(() => cb(code, null)); return this; },
      kill() {},
    };
    return child;
  };
}

test('off arm excludes Jev and uses empty setting sources', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jev-claude-adapter-'));
  try {
    const receipt = await runTrial({ workspace: root, prompt: 'repair the fixture', arm: 'off', outputDir: root, runId: 'off', spawnFn: fakeSpawn([{ type: 'system', model: 'opus[1m]' }, { type: 'result', result: { status: 'ok' } }]) });
    assert.equal(receipt.completion, true);
    assert.equal(receipt.isolation.safeMode, false);
    assert.equal(receipt.isolation.settingSources, '');
    assert.equal(receipt.jev.enabled, false);
    const args = await readFile(join(root, 'off', 'settings.json'), 'utf8');
    assert.match(args, /enabledPlugins/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('on arm selects only Jev, private state, strict MCP, and preserves nullable accounting', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jev-claude-adapter-'));
  try {
    const receipt = await runTrial({ workspace: root, prompt: 'repair the fixture', arm: 'on', pluginRoot: '/plugin/jev-workflows', outputDir: root, runId: 'on', stagePluginFn: noStage, spawnFn: fakeSpawn([{ type: 'system', model: 'opus[1m]', session_id: 's1' }, { type: 'system', output: 'JEV advisory: status=assessed; receipt=11111111-1111-1111-1111-111111111111' }, { type: 'result', result: { status: 'ok' }, usage: { input_tokens: 3, output_tokens: 2 } }]) });
    assert.equal(receipt.completion, true);
    assert.equal(receipt.jev.enabled, true);
    assert.equal(receipt.isolation.strictMcpConfig, true);
    assert.match(receipt.isolation.perRunState, /on\/jev-state$/);
    assert.deepEqual(receipt.usage, { inputTokens: 3, cachedInputTokens: null, cacheCreationTokens: null, outputTokens: 2, reasoningTokens: null });
    assert.equal(receipt.cost.billedUsd, null);
    assert.equal(receipt.jev.deliveryReceipts, 1);
    assert.equal(receipt.jev.adviceDeliveries, 1);
    const mcp = JSON.parse(await readFile(join(root, 'on', 'mcp.json'), 'utf8'));
    assert.equal(mcp.mcpServers['jev-workflows'].env.JEV_STATE_DIRECTORY, receipt.isolation.perRunState);
    const policy = JSON.parse(await readFile(join(root, 'on', 'jev-state', 'policy.json'), 'utf8'));
    assert.deepEqual(policy, { enabled: true, scope: 'workspaces', workspaces: [root], maxHookCallsPerSession: null, maxCallsPerDay: null, maxBytesPerDay: null });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('model downgrade is not reported as completion', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jev-claude-adapter-'));
  try {
    const receipt = await runTrial({ workspace: root, prompt: 'repair', arm: 'off', outputDir: root, runId: 'downgrade', spawnFn: fakeSpawn([{ type: 'system', model: 'sonnet' }, { type: 'result', result: {} }]) });
    assert.equal(receipt.completion, false);
    assert.match(receipt.error, /resolved model differs/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('errors and ambient MCP contamination are invalid trials', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jev-claude-adapter-'));
  try {
    const receipt = await runTrial({ workspace: root, prompt: 'repair', arm: 'on', pluginRoot: '/plugin/jev-workflows', outputDir: root, runId: 'error', stagePluginFn: noStage, spawnFn: fakeSpawn([{ type: 'system', model: 'opus[1m]', tools: ['mcp__jev-workflows__classify_decision', 'mcp__other__tool'] }, { type: 'result', is_error: true }]) });
    assert.equal(receipt.completion, false);
    assert.equal(receipt.isolation.pluginEvidence.status, 'contaminated');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('followups are rejected until native continuation is implemented', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jev-claude-adapter-'));
  try {
    await assert.rejects(() => runTrial({ workspace: root, prompt: 'repair', followups: ['continue'], arm: 'off', outputDir: root }), /followups require native continuation/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('aborted trials terminate as interrupted and never complete', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jev-claude-adapter-'));
  try {
    const controller = new AbortController();
    controller.abort();
    const receipt = await runTrial({ workspace: root, prompt: 'repair', arm: 'off', outputDir: root, runId: 'aborted', signal: controller.signal, spawnFn: fakeSpawn([{ type: 'system', model: 'opus[1m]' }, { type: 'result', result: {} }]) });
    assert.equal(receipt.interrupted, true);
    assert.equal(receipt.completion, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('both arms use the same task allowlist and never pass credential values', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jev-claude-adapter-'));
  const captures = [];
  const spawn = (file, args, opts) => {
    captures.push({ file, args, env: opts.env });
    return fakeSpawn([{ type: 'system', model: 'opus[1m]' }, { type: 'result', result: {} }])(file, args, opts);
  };
  const old = process.env.TYPESAFE_API_KEY;
  const oldFile = process.env.JEV_API_KEY_FILE;
  process.env.TYPESAFE_API_KEY = 'secret-test-value';
  process.env.JEV_API_KEY_FILE = '/private/jev-key.env';
  try {
    await runTrial({ workspace: root, prompt: 'repair', arm: 'off', outputDir: root, runId: 'perm-off', spawnFn: spawn });
    await runTrial({ workspace: root, prompt: 'repair', arm: 'on', pluginRoot: '/plugin/jev-workflows', outputDir: root, runId: 'perm-on', stagePluginFn: noStage, spawnFn: spawn });
    assert.deepEqual(captures[0].args.slice(captures[0].args.indexOf('--allowed-tools'), captures[0].args.indexOf('--settings')), captures[1].args.slice(captures[1].args.indexOf('--allowed-tools'), captures[1].args.indexOf('--settings')));
    assert.equal(captures[0].env.TYPESAFE_API_KEY, undefined);
    assert.equal(captures[0].env.JEV_API_KEY_FILE, undefined);
    assert.equal(captures[1].env.TYPESAFE_API_KEY, undefined);
    assert.equal(captures[1].env.JEV_API_KEY_FILE, '/private/jev-key.env');
  } finally {
    if (old === undefined) delete process.env.TYPESAFE_API_KEY; else process.env.TYPESAFE_API_KEY = old;
    if (oldFile === undefined) delete process.env.JEV_API_KEY_FILE; else process.env.JEV_API_KEY_FILE = oldFile;
    await rm(root, { recursive: true, force: true });
  }
});

test('staged Claude plugin rewrites every hook command to the private state path', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jev-claude-adapter-'));
  try {
    const source = join(root, 'source');
    const destination = join(root, 'staged');
    await mkdir(join(source, 'hooks'), { recursive: true });
    await writeFile(join(source, 'hooks', 'hooks.json'), JSON.stringify({ hooks: {
      SessionStart: [{ hooks: [{ type: 'command', command: "JEV_STATE_DIRECTORY='/global/state' JEV_API_KEY_FILE='/global/key' node \"${CLAUDE_PLUGIN_ROOT}/dist/claude-hook.mjs\"" }] }],
      PostToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: "JEV_STATE_DIRECTORY='/global/state' JEV_API_KEY_FILE='/global/key' node \"${CLAUDE_PLUGIN_ROOT}/dist/claude-hook.mjs\"" }] }],
    } }));
    await stagePlugin(source, destination, join(root, 'state'));
    const hooks = JSON.parse(await readFile(join(destination, 'hooks', 'hooks.json'), 'utf8'));
    for (const groups of Object.values(hooks.hooks)) {
      const command = groups[0].hooks[0].command;
      assert.ok(command.startsWith(`JEV_STATE_DIRECTORY='${join(root, 'state')}' `));
      assert.equal((command.match(/JEV_STATE_DIRECTORY=/g) ?? []).length, 1);
      assert.equal((command.match(/JEV_API_KEY_FILE=/g) ?? []).length, 1);
      assert.doesNotMatch(command, /\/global\/state|\/global\/key/);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('provider accounting deduplicates duplicate receipt files and separates local attempts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jev-claude-accounting-'));
  try {
    const receipt = { receiptId: '11111111-1111-1111-1111-111111111111', status: 'assessed', usage: { input_tokens: 10, output_tokens: 2 }, latencyMs: 9, transport: { fetchInvoked: true, validatedResponse: true, providerRequestId: 'req_1' } };
    await writeFile(join(root, 'one.json'), JSON.stringify(receipt));
    await writeFile(join(root, 'two.json'), JSON.stringify(receipt));
    await mkdir(join(root, 'decision-hook-v1', 'invocations'), { recursive: true });
    await writeFile(join(root, 'decision-hook-v1', 'invocations', 'local.json'), JSON.stringify({ status: 'assessed' }));
    const accounting = await readJevAccounting(root);
    assert.equal(accounting.fetchInvoked, 1);
    assert.equal(accounting.responses, 1);
    assert.equal(accounting.validatedResponses, 1);
    assert.equal(accounting.attempts, 1);
    assert.deepEqual(accounting.usage, { inputTokens: 10, cachedInputTokens: null, cacheCreationTokens: null, outputTokens: 2 });
    assert.deepEqual(accounting.latenciesMs, [9]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
