import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runTrial } from './qq.mjs';

function fakeSpawn(calls, { runCode = 0, runOutcome = 'completed', runCloseDelayMs = 0 } = {}) {
  return (command, args, options) => {
    calls.push({ command, args, options });
    const stdout = args[0] === 'mcp' ? JSON.stringify({ server: 'project_graph', digest: 'a'.repeat(64), matches_pin: null, tools: [{ name: 'project_graph', input_schema: { type: 'object' } }] }) : [
      JSON.stringify({ type: 'trial', model: 'openai-codex/gpt-6-astra', reasoning_effort: 'high', session_id: 's', run_id: 'r' }),
      JSON.stringify({ type: 'event', envelope: { run_id: 'r', event: { type: 'model_turn_completed', model: { model: 'openai-codex/gpt-6-astra' } } } }),
      JSON.stringify({ type: 'event', envelope: { run_id: 'r', event: { type: 'tool_call_requested', tool_call: { name: 'mcp__project_graph__project_graph', arguments: JSON.stringify({ operation: 'search' }) } } } }),
      JSON.stringify({ type: 'event', envelope: { run_id: 'r', event: { type: 'run_finished', outcome: { type: 'completed' }, session: { reasoning_effort: 'high' }, usage: { input_tokens: 3, output_tokens: 2 } } } }),
      JSON.stringify({ type: 'outcome', status: runOutcome, exit_code: runCode, usage: { input_tokens: 3, output_tokens: 2 } }),
    ].join('\n');
    let closeTimer;
    const child = { killed: false, kill(signal) { this.killed = true; this.signal = signal; clearTimeout(closeTimer); }, stdout: { on() {} }, stderr: { on() {} }, once(event, handler) { if (event === 'close') closeTimer = setTimeout(() => handler(args[0] === 'mcp' ? 0 : runCode, null), args[0] === 'mcp' ? 0 : runCloseDelayMs); } };
    const original = child.stdout.on;
    child.stdout.on = (_event, handler) => { handler(Buffer.from(stdout)); return child.stdout; };
    child.stderr.on = (_event, handler) => { handler(Buffer.from('')); return child.stderr; };
    return child;
  };
}

test('dry run performs only MCP inspect and isolates QQ state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qq-graph-'));
  try {
    const calls = [];
    const receipt = await runTrial({ workspace: root, prompt: 'inspect graph', arm: 'graph', outputDir: root, serverPath: '/private/project-graph/server.mjs', spawnImpl: fakeSpawn(calls) });
    assert.equal(receipt.completion, 'not_started');
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].args.slice(0, 3), ['mcp', 'inspect', 'project_graph']);
    assert.equal(calls[0].options.env.XDG_DATA_HOME.endsWith('/qq-data'), true);
    assert.equal(calls[0].options.env.PROJECT_GRAPH_ROOT, undefined);
    assert.equal(calls[0].options.env.JEV_API_KEY_FILE, undefined);
    assert.match(calls[0].options.env.QQ_CONFIG_CONTENT, /jev_review: off/);
    assert.equal(calls[0].options.env.TYPESAFE_API_KEY, undefined);
    assert.equal(receipt.graphNativeCalls.length, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('authorized run uses fixed model/effort, graph MCP grant, and records native calls', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qq-graph-'));
  try {
    const calls = [];
    const receipt = await runTrial({ workspace: root, prompt: 'repair graph fixture', arm: 'cheap', outputDir: root, runId: 'authorized', serverPath: '/private/project-graph/server.mjs', authorizeProvider: true, spawnImpl: fakeSpawn(calls) });
    assert.equal(receipt.completion, true);
    assert.equal(receipt.resolvedModel, 'openai-codex/gpt-6-astra');
    assert.equal(receipt.resolvedEffort, 'high');
    assert.equal(receipt.graphNativeCalls[0].operation, 'search');
    assert.equal(calls.length, 2);
    assert.ok(calls[1].args.includes('mcp__project_graph__project_graph'));
    assert.match(calls[1].options.env.QQ_CONFIG_CONTENT, /pin: "a{64}"/);
    assert.equal(calls[1].options.env.XDG_DATA_HOME.endsWith('/qq-data'), true);
    assert.equal(calls[1].options.env.PROJECT_GRAPH_ARM, undefined);
    const saved = JSON.parse(await readFile(join(root, 'authorized', 'receipt.json'), 'utf8'));
    assert.equal(saved.configEvidence.jevRouting, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('completed output with nonzero process exit is not native completion', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qq-graph-'));
  try {
    const receipt = await runTrial({ workspace: root, prompt: 'repair', arm: 'graph', outputDir: root, runId: 'failed-exit', serverPath: '/private/project-graph/server.mjs', authorizeProvider: true, spawnImpl: fakeSpawn([], { runCode: 1 }) });
    assert.equal(receipt.completion, false);
    assert.equal(receipt.exitCode, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('run timeout keeps cleanupRequired when the detached child does not close', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qq-graph-'));
  try {
    const receipt = await runTrial({ workspace: root, prompt: 'repair', arm: 'graph', outputDir: root, runId: 'timeout', serverPath: '/private/project-graph/server.mjs', timeoutMs: 5, authorizeProvider: true, spawnImpl: fakeSpawn([], { runCloseDelayMs: 10_000 }) });
    assert.equal(receipt.completion, false);
    assert.equal(receipt.cleanupRequired, true);
  } finally { await rm(root, { recursive: true, force: true }); }
});
