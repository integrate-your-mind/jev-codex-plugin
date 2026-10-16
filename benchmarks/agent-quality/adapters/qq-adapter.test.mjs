import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseDiscovery, runTrial } from './qq.mjs';

function fakeTransport({ profiles = [{ id: 'default', approval_mode: 'read_only' }, { id: 'jev', approval_mode: 'read_only' }], events = [] } = {}) {
  const calls = [];
  return {
    calls,
    async request(method, url, body) {
      calls.push({ method, url, body });
      if (url.endsWith('/v1/capabilities')) return { status: 200, body: { profiles, protocol_version: 32 } };
      if (url.endsWith('/v1/workspaces/resolve')) return { status: 200, body: { outcome: { workspace_id: 'w1' } } };
      if (url.endsWith('/v1/sessions')) return { status: 200, body: { outcome: { session_id: 's1' } } };
      if (url.endsWith('/v1/sessions/prompts')) return { status: 200, body: { outcome: { run_id: 'r1', queue_position: 0 } } };
      throw new Error(`unexpected route ${url}`);
    },
    async stream(_url, _headers, _timeout, onEvent) { for (const event of events) await onEvent(event); },
  };
}

async function discoveryFile(root) {
  const path = join(root, 'server.ron');
  await writeFile(path, '(address:"127.0.0.1:56470",protocol_version:32,version:"0.1.7",token:"secret-never-receipted")');
  return path;
}

test('discovery parser keeps token private', () => {
  const value = parseDiscovery('(address:"127.0.0.1:1",protocol_version:32,version:"x",token:"secret")');
  assert.deepEqual({ address: value.address, version: value.version, protocolVersion: value.protocolVersion }, { address: 'http://127.0.0.1:1', version: 'x', protocolVersion: 32 });
  assert.equal(Object.keys(value).includes('token'), true);
});

test('provider execution is explicit and off arm has no Jev prompt', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qq-adapter-'));
  try {
    const transport = fakeTransport();
    const receipt = await runTrial({ workspace: root, prompt: 'repair fixture', arm: 'off', outputDir: root, runId: 'off', discoveryPath: await discoveryFile(root), transport });
    assert.equal(receipt.completion, 'not_started');
    assert.equal(receipt.error, 'provider execution requires explicit authorizeProvider:true');
    assert.equal(receipt.configuration.profile, 'default');
    assert.equal(transport.calls.some((call) => call.url.endsWith('/v1/sessions/prompts')), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('on arm requires the trusted Jev profile and preserves fixed model, effort, and approvals', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qq-adapter-'));
  try {
    const transport = fakeTransport({ events: [
      { cursor: 1, event: { type: 'checkpoint_started', run_id: 'r1', phase: 'final' } },
      { cursor: 2, event: { type: 'checkpoint_reviewed', run_id: 'r1', outcome: 'abstained', feedback: 'low confidence' } },
      { cursor: 3, event: { type: 'run_finished', run_id: 'r1', outcome: 'completed', usage: { input_tokens: 8, cache_read_input_tokens: 2, output_tokens: 5, reasoning_tokens: 1, estimated_cost_usd_nanos: 420000000 } } },
    ] });
    const receipt = await runTrial({ workspace: root, prompt: 'repair fixture', arm: 'on', pluginRoot: '/private/plugin', outputDir: root, runId: 'on', discoveryPath: await discoveryFile(root), transport, model: 'openai-codex/gpt-6.1-sol', effort: 'medium', authorizeProvider: true });
    assert.equal(receipt.completion, true);
    assert.equal(receipt.configuration.profile, 'jev');
    assert.equal(receipt.configuration.routingDisabled, true);
    assert.deepEqual(receipt.usage, { inputTokens: 8, cachedInputTokens: 2, outputTokens: 5, reasoningTokens: 1 });
    assert.equal(receipt.cost.estimatedUsd, 0.42);
    assert.equal(receipt.jev.abstentions, 1);
    const create = transport.calls.find((call) => call.url.endsWith('/v1/sessions'));
    assert.equal(create.body.command.model.model, 'openai-codex/gpt-6.1-sol');
    assert.equal(create.body.command.reasoning_effort, 'medium');
    assert.equal(create.body.command.approval_mode, 'read_only');
    assert.equal(create.body.command.profile, 'jev');
    const text = await readFile(join(root, 'on', 'receipt.json'), 'utf8');
    assert.doesNotMatch(text, /secret-never-receipted/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('on arm reports an unavailable treatment instead of claiming a causal Jev run', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qq-adapter-'));
  try {
    const transport = fakeTransport({ profiles: [{ id: 'default', approval_mode: 'read_only' }] });
    const receipt = await runTrial({ workspace: root, prompt: 'repair fixture', arm: 'on', pluginRoot: '/private/plugin', outputDir: root, runId: 'unsupported', discoveryPath: await discoveryFile(root), transport });
    assert.equal(receipt.completion, false);
    assert.match(receipt.error, /treatment unavailable/);
    assert.equal(transport.calls.some((call) => call.url.endsWith('/v1/sessions/prompts')), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
