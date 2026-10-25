import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildLaunch, runTrial } from './codex.mjs';

function fakeSpawn(lines, code = 0, onStart) {
  return (_file, _args, options) => {
    onStart?.(options);
    const listeners = {};
    const child = {
      pid: 999999,
      stdout: { setEncoding() {}, on(_event, callback) { if (_event === 'data') setImmediate(() => callback(lines.map(line => `${JSON.stringify(line)}\n`).join(''))); } },
      stderr: { setEncoding() {}, on() {} }, stdin: { on() {}, end() {} },
      on(event, callback) { (listeners[event] ??= []).push(callback); return this; },
      once(event, callback) { (listeners[event] ??= []).push(callback); if (event === 'close') setImmediate(() => callback(code, null)); return this; },
      kill() {},
    }; return child;
  };
}

test('native launch config includes a real project_graph MCP server and no Jev plugin', () => {
  const args = buildLaunch({ arm: 'graph', model: 'gpt-6-astra', effort: 'high', workspace: '/tmp/task', lastMessagePath: '/tmp/out', serverPath: '/tmp/project-graph/server.mjs', graphRoot: '/tmp/task', graphState: '/tmp/graph', jevState: '/tmp/jev', objective: 'fix bug' });
  assert.ok(args.includes('--ignore-user-config'));
  assert.ok(args.some(value => value.includes('mcp_servers.project_graph.command=')));
  assert.ok(args.some(value => value.includes('mcp_servers.project_graph.args=')));
  const env = args.find(value => value.startsWith('mcp_servers.project_graph.env='));
  assert.match(env, /PROJECT_GRAPH_ARM/);
  assert.match(env, /PROJECT_GRAPH_ROOT/);
  assert.match(env, /PROJECT_GRAPH_STATE/);
  assert.ok(env.includes('JEV_STATE_DIRECTORY') && env.includes('/tmp/jev'));
  assert.doesNotMatch(env, /JEV_API_KEY_FILE/);
  assert.doesNotMatch(args.join(' '), /jev-workflows|features\.plugins=true/);
});

test('graph trial records native graph calls, model resolution, and nullable cost', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jev-graph-codex-'));
  const source = await mkdtemp(join(tmpdir(), 'jev-graph-auth-'));
  try {
    await writeFile(join(source, 'auth.json'), '{}');
    const receipt = await runTrial({ workspace: root, prompt: 'repair the fixture', arm: 'graph', outputDir: root, serverPath: '/tmp/project-graph/server.mjs', sourceCodexHome: source, spawnFn: fakeSpawn([{ type: 'turn.started', model: 'gpt-6-astra', effort: 'high' }, { type: 'item.completed', item: { type: 'mcp_tool_call', server: 'project_graph', tool: 'project_graph', arguments: { operation: 'search', query: 'fixture' }, id: '1' } }, { type: 'mcp_tool_call', server: 'project_graph', tool: 'project_graph', arguments: { operation: 'read', nodeId: 'fixture' }, id: '2' }, { type: 'turn.completed', status: 'completed', usage: { input_tokens: 4, output_tokens: 2 } }]) });
    assert.equal(receipt.completion, true);
    assert.equal(receipt.graph.calls.length, 2);
    assert.equal(receipt.graph.calls[0].operation, 'search');
    assert.equal(receipt.resolvedModel, 'gpt-6-astra');
    assert.equal(receipt.cost.reportedUsd, null);
    assert.equal(receipt.isolation.jevCalls, 0);
    assert.equal(receipt.graphStateDir, join(root, receipt.runId, 'graph'));
    assert.equal(receipt.jevStateDir, join(root, receipt.runId, 'jev'));
    assert.equal(receipt.graph.calls[0].arguments.operation, 'search');
    assert.equal(receipt.graph.calls[1].operation, 'read');
    assert.equal(await readFile(join(root, receipt.runId, 'receipt.json'), 'utf8').then(Boolean), true);
  } finally { await rm(root, { recursive: true, force: true }); await rm(source, { recursive: true, force: true }); }
});

test('nonterminal and model mismatch trials are not eligible', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jev-graph-codex-'));
  const source = await mkdtemp(join(tmpdir(), 'jev-graph-auth-'));
  try {
    await writeFile(join(source, 'auth.json'), '{}');
    const receipt = await runTrial({ workspace: root, prompt: 'repair', arm: 'cheap', outputDir: root, serverPath: '/tmp/server.mjs', sourceCodexHome: source, spawnFn: fakeSpawn([{ type: 'turn.failed', model: 'gpt-6-astra', effort: 'high', is_error: true }], 1) });
    assert.equal(receipt.completion, false);
    assert.equal(receipt.comparisonEligible, false);
  } finally { await rm(root, { recursive: true, force: true }); await rm(source, { recursive: true, force: true }); }
});

test('session turn_context is authoritative model and effort evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jev-graph-codex-'));
  const source = await mkdtemp(join(tmpdir(), 'jev-graph-auth-'));
  try {
    await writeFile(join(source, 'auth.json'), '{}');
    const receipt = await runTrial({ workspace: root, prompt: 'repair', arm: 'graph', outputDir: root, serverPath: '/tmp/server.mjs', sourceCodexHome: source, spawnFn: fakeSpawn([
      { type: 'turn.started', model: 'requested-alias', effort: 'low' },
      { type: 'mcp_tool_call', server: 'project_graph', tool: 'project_graph', arguments: { operation: 'read' } },
      { type: 'turn.completed', status: 'completed' },
    ], 0, options => {
      mkdirSync(join(options.env.CODEX_HOME, 'sessions'), { recursive: true });
      writeFileSync(join(options.env.CODEX_HOME, 'sessions', 'native.jsonl'), `${JSON.stringify({ type: 'session_meta', payload: { id: 'native-session' } })}\n${JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-6-astra', effort: 'high', cwd: root } })}\n`);
    }) });
    assert.equal(receipt.completion, true);
    assert.equal(receipt.resolvedModel, 'gpt-6-astra');
    assert.equal(receipt.resolvedEffort, 'high');
    assert.equal(receipt.isolation.modelEvidence.sessionId, 'native-session');
  } finally { await rm(root, { recursive: true, force: true }); await rm(source, { recursive: true, force: true }); }
});
