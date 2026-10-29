import assert from 'node:assert/strict';
import {lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {test} from 'node:test';
import fsp from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import {configurePolicy} from '../src/policy.js';
import {runClaudeHook} from '../src/claude-hook.js';
import {BRIDGE_VERSION, CausalBridge, parseConfig, parseRecord, recordPath, toolIds, type BridgeConfig, type DecisionRecord, type Inference} from '../src/hosts/claude/bridge.js';
import {register, type API, type Step, type StreamNext} from '../src/hosts/claude/mod.js';

const config: BridgeConfig = {version: BRIDGE_VERSION, enabled: true, stateDirectory: '/private/jev-state', hostId: 'claude-code', providerId: 'anthropic-account-epoch', catalogGeneration: 'catalog-1', policyGeneration: 'policy-1', profiles: [{id: 'fast', model: 'verified-fast-model', effort: 'low', hostId: 'claude-code', providerId: 'anthropic-account-epoch', availability: 'verified'}, {id: 'original', model: 'original-model', effort: 'high', hostId: 'claude-code', providerId: 'anthropic-account-epoch', availability: 'verified'}], transitions: [{from: 'original', to: 'fast', kind: 'upshift'}]};
const step = (index: number): Step => ({turnId: 'turn-1', index, model: 'original-model', effort: 'high', messageCount: 2});
const record = (extra: Partial<DecisionRecord> = {}): DecisionRecord => ({version: BRIDGE_VERSION, producer: 'trusted-post-tool-batch', sessionId: 'session-1', agentId: 'main', workspace: '/workspace', toolUseIds: ['a', 'b'], createdAt: 101, expiresAt: 1000, hostId: config.hostId, providerId: config.providerId, catalogGeneration: config.catalogGeneration, policyGeneration: config.policyGeneration, status: 'assessed', selection: 'fast', objectiveDigest: 'a'.repeat(64), evidenceDigest: 'b'.repeat(64), ...extra});
function completed(): CausalBridge {
  const bridge = new CausalBridge();
  bridge.begin(step(0), 100);
  bridge.streamTool(step(0), 'b'); bridge.streamTool(step(0), 'a');
  bridge.finish(step(0), true);
  bridge.completeTool(undefined, 'a'); bridge.completeTool(undefined, 'b');
  return bridge;
}

test('causal bridge applies one trusted profile after the exact complete preceding batch', () => {
  const bridge = completed();
  assert.deepEqual(bridge.select(step(1), record(), config, {sessionId: 'session-1', workspace: '/workspace'}, 200), {...step(1), model: 'verified-fast-model', effort: 'low'});
  assert.deepEqual(bridge.select(step(0), record(), config, {sessionId: 'session-1', workspace: '/workspace'}, 200), step(0));
  assert.deepEqual(new CausalBridge().select(step(1), record(), config, {sessionId: 'session-1', workspace: '/workspace'}, 200), step(1));
  assert.deepEqual(bridge.select({...step(1), model: 'human-pinned-model'}, record(), config, {sessionId: 'session-1', workspace: '/workspace'}, 200), {...step(1), model: 'human-pinned-model'});
  assert.deepEqual(bridge.select({...step(1), effort: 'max'}, record(), config, {sessionId: 'session-1', workspace: '/workspace'}, 200), {...step(1), effort: 'max'});
  assert.deepEqual(bridge.select(step(1), record(), {...config, transitions: [{from: 'original', to: 'fast', kind: 'downshift'}]}, {sessionId: 'session-1', workspace: '/workspace'}, 200), step(1));
});

test('wrong scope, stale, late, partial and changed policy/catalog records preserve the incoming pair', () => {
  for (const delta of [{sessionId: 'other'}, {agentId: 'child'}, {workspace: '/other'}, {toolUseIds: ['a']}, {toolUseIds: ['a', 'b', 'c']}, {createdAt: 99}, {createdAt: 201}, {expiresAt: 150}, {catalogGeneration: 'changed'}, {policyGeneration: 'changed'}, {providerId: 'changed'}, {status: 'abstained' as const}, {selection: 'invented'}]) {
    assert.deepEqual(completed().select(step(1), record(delta), config, {sessionId: 'session-1', workspace: '/workspace'}, 200), step(1), JSON.stringify(delta));
  }
  const unknown = {...config, profiles: config.profiles.map(p => ({...p, availability: 'unknown' as const}))};
  assert.deepEqual(completed().select(step(1), record(), unknown, {sessionId: 'session-1', workspace: '/workspace'}, 200), step(1));
});

test('queued objectives, overlaps, missing completions and duplicate IDs invalidate routing', () => {
  const queued = completed(); queued.invalidate();
  assert.equal(queued.preceding(step(1)), undefined);
  queued.begin(step(1), 200); queued.streamTool(step(1), 'c'); queued.completeTool(undefined, 'c'); queued.finish(step(1), true);
  assert.equal(queued.preceding(step(2)), undefined);
  const overlap = new CausalBridge(); overlap.begin(step(0), 100); overlap.begin(step(1), 101); overlap.finish(step(0), true);
  overlap.streamTool(step(1), 'a'); overlap.completeTool(undefined, 'a'); overlap.finish(step(1), true);
  assert.equal(overlap.preceding(step(2)), undefined);
  const partial = new CausalBridge(); partial.begin(step(0), 100); partial.streamTool(step(0), 'a'); partial.finish(step(0), true);
  assert.equal(partial.preceding(step(1)), undefined);
  partial.completeTool(undefined, 'a'); partial.completeTool(undefined, 'a');
  assert.equal(partial.preceding(step(1)), undefined);
  const incompleteStream = completed(); incompleteStream.begin(step(1), 200); incompleteStream.streamTool(step(1), 'c'); incompleteStream.completeTool(undefined, 'c'); incompleteStream.finish(step(1), true, 2);
  assert.equal(incompleteStream.preceding(step(2)), undefined);
});

test('wire parsers reject unsupported effort, duplicate identities and malformed provenance', () => {
  assert.equal(parseConfig({...config, profiles: [{...config.profiles[0], effort: 'ultra'}]}), undefined);
  assert.equal(parseConfig({...config, profiles: [{...config.profiles[0], effort: 1024}]}), undefined);
  assert.equal(parseConfig({...config, profiles: [config.profiles[0], config.profiles[0]]}), undefined);
  assert.equal(parseRecord({...record(), producer: 'native-mod'}), undefined);
  assert.equal(parseRecord({...record(), toolUseIds: ['a', 'a']}), undefined);
  assert.equal(parseRecord({...record(), expiresAt: 0}), undefined);
  assert.equal(parseConfig({...config, apiKey: 'must-not-be-packaged'}), undefined);
  assert.equal(toolIds(Array.from({length: 129}, (_, n) => `tool-${n}`))?.length, 129);
});

type StepHook = (api: API, e: Step, next: StreamNext) => AsyncGenerator<{kind: string; [key: string]: unknown}, unknown, unknown>;
type ToolHook = (api: API, e: {tool: string; tool_use_id: string}, next: unknown) => Promise<unknown>;
type PromptHook = (api: API, e: {turnId: string}, next: unknown) => Promise<unknown>;
function harness() {
  const hooks: Record<string, unknown> = {};
  register((event: string, hook: unknown) => { hooks[event] = hook; return {catch() {}}; }, {});
  const files = new Map<string, string>();
  const api: API = {plugin: {root: '/plugin'}, session: {id: async () => 'session-1', cwd: async () => '/workspace'}, fs: {
    read: async path => { const text = files.get(path); if (text === undefined) throw new Error('missing'); return text; },
    stat: async path => path === config.stateDirectory ? {kind: 'dir', size: 0, mtimeMs: 1, isLink: false, realPath: path} : {kind: 'file', size: files.get(path)?.length ?? 0, mtimeMs: 1, isLink: false, realPath: path},
  }};
  files.set('/plugin/claude-routing.json', JSON.stringify(config));
  return {api, files, stepHook: hooks['turn.step'] as StepHook, toolHook: hooks['tool.call'] as ToolHook, promptHook: hooks['prompt.submit'] as PromptHook};
}
async function consume(stream: ReturnType<StepHook>) {
  const chunks: unknown[] = [];
  while (true) { const item = await stream.next(); if (item.done) return {chunks, result: item.value}; chunks.push(item.value); }
}
const origin = {plugin: 'engine', tier: 'core'};

test('native hooks forward exact chunks/result once and preserve ordinary tool results', async () => {
  const h = harness();
  const controller = new AbortController();
  const sent: Inference[] = [];
  const chunks = [{kind: 'text', index: 0, text: 'hello'}, {kind: 'tool', index: 1, id: 'a', name: 'Read'}, {kind: 'tool', index: 2, id: 'b', name: 'Bash'}, {kind: 'engine', ref: 44}];
  const result = {answer: 'opaque-host-result', toolUses: [{name: 'Read', input: {}}, {name: 'Bash', input: {}}]};
  const next = Object.assign(async function* (e: Step) { sent.push(e); for (const chunk of chunks) yield chunk; return result; }, {signal: controller.signal, origin});
  const first = await consume(h.stepHook(h.api, step(0), next));
  assert.deepEqual(sent, [step(0)]); assert.deepEqual(first, {chunks, result});
  const toolResult = {deny: 'ordinary permission decision'};
  const toolNext = Object.assign(async () => toolResult, {signal: controller.signal, origin});
  for (const id of ['a', 'b']) assert.equal(await h.toolHook(h.api, {tool: 'Read', tool_use_id: id}, toolNext), toolResult);
  h.files.set(recordPath(config, 'session-1', 'main', ['a', 'b']), JSON.stringify(record({createdAt: Date.now(), expiresAt: Date.now() + 30_000})));
  await consume(h.stepHook(h.api, step(1), next));
  assert.equal(sent.length, 2); assert.equal(sent[1]?.model, 'verified-fast-model'); assert.equal(sent[1]?.effort, 'low');
});

test('native cancellation opens no inference and stream errors never trigger a retry', async () => {
  const h = harness(); const controller = new AbortController(); let calls = 0; let closed = 0;
  const next = Object.assign(async function* () { calls++; try { yield {kind: 'text', text: 'partial'}; throw new Error('stream failed'); } finally { closed++; } }, {signal: controller.signal, origin});
  await assert.rejects(consume(h.stepHook(h.api, step(0), next)), /stream failed/);
  assert.equal(calls, 1); assert.equal(closed, 1);
  controller.abort();
  await assert.rejects(consume(h.stepHook(h.api, step(1), next)), /cancelled/);
  assert.equal(calls, 1);
});

test('native abort during a record read discards advice and queued prompts also invalidate the batch', async () => {
  const h = harness(); const controller = new AbortController(); const sent: Step[] = [];
  const next = Object.assign(async function* (e: Step) { sent.push(e); yield {kind: 'tool', index: 0, id: 'a', name: 'Read'}; return {toolUses: [{name: 'Read', input: {}}]}; }, {signal: controller.signal, origin});
  await consume(h.stepHook(h.api, step(0), next));
  const toolNext = Object.assign(async () => ({text: 'read'}), {signal: controller.signal, origin});
  await h.toolHook(h.api, {tool: 'Read', tool_use_id: 'a'}, toolNext);
  const path = recordPath(config, 'session-1', 'main', ['a']);
  h.files.set(path, JSON.stringify(record({toolUseIds: ['a'], createdAt: Date.now(), expiresAt: Date.now() + 30_000})));
  const read = h.api.fs.read;
  h.api.fs.read = async p => { if (p === path) controller.abort(); return await read(p); };
  await assert.rejects(consume(h.stepHook(h.api, step(1), next)), /cancelled/);
  assert.equal(sent.length, 1);
  const retry = Object.assign(async function* (e: Step) { sent.push(e); return 'retry'; }, {signal: new AbortController().signal, origin});
  await consume(h.stepHook(h.api, step(1), retry));
  assert.equal(sent[1]?.model, 'original-model');
  const queued = harness();
  const queuedSent: Step[] = [];
  const queuedSignal = new AbortController().signal;
  const queuedNext = Object.assign(async function* (e: Step) { queuedSent.push(e); yield {kind: 'tool', id: 'a'}; return {toolUses: [{name: 'Read', input: {}}]}; }, {signal: queuedSignal, origin});
  await consume(queued.stepHook(queued.api, step(0), queuedNext));
  await queued.toolHook(queued.api, {tool: 'Read', tool_use_id: 'a'}, Object.assign(async () => ({text: 'result'}), {signal: queuedSignal, origin}));
  queued.files.set(path, JSON.stringify(record({toolUseIds: ['a'], createdAt: Date.now(), expiresAt: Date.now() + 30_000})));
  const promptNext = Object.assign(async () => ({text: 'new objective'}), {signal: new AbortController().signal, origin});
  assert.deepEqual(await queued.promptHook(queued.api, {turnId: 'turn-1'}, promptNext), {text: 'new objective'});
  await consume(queued.stepHook(queued.api, step(1), queuedNext));
  assert.equal(queuedSent[1]?.model, 'original-model');
});

test('native symlink, changed file provenance or concurrent policy updates preserve the incoming pair', async () => {
  for (const unsafe of ['symlink', 'retarget', 'changed', 'config-changed']) {
    const h = harness(); const signal = new AbortController().signal; const sent: Step[] = [];
    const next = Object.assign(async function* (e: Step) { sent.push(e); yield {kind: 'tool', id: 'a'}; return {toolUses: [{name: 'Read', input: {}}]}; }, {signal, origin});
    await consume(h.stepHook(h.api, step(0), next));
    await h.toolHook(h.api, {tool: 'Read', tool_use_id: 'a'}, Object.assign(async () => ({text: 'result'}), {signal, origin}));
    const path = recordPath(config, 'session-1', 'main', ['a']);
    h.files.set(path, JSON.stringify(record({toolUseIds: ['a'], createdAt: Date.now(), expiresAt: Date.now() + 30_000})));
    if (unsafe === 'config-changed') {
      const read = h.api.fs.read;
      h.api.fs.read = async p => { const text = await read(p); if (p === path) h.files.set('/plugin/claude-routing.json', JSON.stringify({...config, enabled: false})); return text; };
    }
    const stat = h.api.fs.stat; let reads = 0;
    h.api.fs.stat = async (p, o) => {
      const result = await stat(p, o);
      if (p !== path) return result;
      reads++;
      return {...result, isLink: unsafe === 'symlink', realPath: unsafe === 'retarget' ? '/untrusted' : p, mtimeMs: unsafe === 'changed' ? reads : result.mtimeMs};
    };
    await consume(h.stepHook(h.api, step(1), next));
    assert.equal(sent[1]?.model, 'original-model', unsafe);
  }
});

test('native consumer cancellation closes the one underlying stream', async () => {
  const h = harness(); let calls = 0; let closed = 0;
  const next = Object.assign(async function* () { calls++; try { yield {kind: 'text', text: 'partial'}; yield {kind: 'text', text: 'rest'}; } finally { closed++; } }, {signal: new AbortController().signal, origin});
  const stream = h.stepHook(h.api, step(0), next);
  assert.equal((await stream.next()).done, false);
  await stream.return(undefined);
  assert.equal(calls, 1); assert.equal(closed, 1);
});

test('trusted PostToolBatch publishes private immutable advice once and suppresses classic duplicate evaluation', async () => {
  const parent = join(process.cwd(), '..', '..', '.agent-work'); await mkdir(parent, {recursive: true});
  const root = await mkdtemp(join(parent, 'claude-bridge-'));
  try {
    const stateDirectory = join(root, 'state'); const configPath = join(root, 'config.json');
    const local = {...config, stateDirectory};
    const env = {JEV_STATE_DIRECTORY: stateDirectory, JEV_ENABLED: '1', JEV_CLAUDE_NATIVE_BRIDGE: '1', JEV_CLAUDE_ROUTING_CONFIG: configPath};
    await configurePolicy({enabled: true, scope: 'all-workspaces', workspaces: []}, env);
    await writeFile(configPath, JSON.stringify(local));
    await runClaudeHook({hook_event_name: 'UserPromptSubmit', session_id: 'session-1', cwd: process.cwd(), prompt: 'Inspect the parser regression and repair the observed failure.'}, {env});
    let calls = 0;
    const service = {classifyDecision: async () => { calls++; return {status: 'assessed', choice: 'fast'}; }};
    const event = {hook_event_name: 'PostToolBatch', session_id: 'session-1', cwd: process.cwd(), tool_calls: [{tool_name: 'Bash', tool_use_id: 'a', tool_response: {exit_code: 1}}, {tool_name: 'Read', tool_use_id: 'b'}]};
    const result = await runClaudeHook(event, {env, service});
    assert.match(result.hookSpecificOutput?.additionalContext ?? '', /decision=fast/);
    const path = recordPath(local, 'session-1', 'main', ['a', 'b']);
    const before = await readFile(path, 'utf8'); assert.equal(JSON.parse(before).selection, 'fast');
    assert.equal((await lstat(path)).mode & 0o777, 0o600);
    assert.deepEqual(await runClaudeHook(event, {env, service}), {});
    assert.equal(await readFile(path, 'utf8'), before); assert.equal(calls, 1);
    assert.deepEqual(await runClaudeHook({hook_event_name: 'PreToolUse', session_id: 'session-1', cwd: process.cwd(), tool_use_id: 'c', tool_name: 'Read'}, {env, service}), {});
    assert.equal(calls, 1);
    assert.equal((await readdir(join(path, '..'))).some(name => name.endsWith('.partial')), false);
  } finally { await rm(root, {recursive: true, force: true}); }
});

test('producer deadline, duplicate concurrency and interrupted publication never publish a late selection', async () => {
  const parent = join(process.cwd(), '..', '..', '.agent-work'); await mkdir(parent, {recursive: true});
  const root = await mkdtemp(join(parent, 'claude-producer-failures-'));
  try {
    const stateDirectory = join(root, 'state'); const configPath = join(root, 'config.json'); const local = {...config, stateDirectory};
    const env = {JEV_STATE_DIRECTORY: stateDirectory, JEV_ENABLED: '1', JEV_CLAUDE_NATIVE_BRIDGE: '1', JEV_CLAUDE_ROUTING_CONFIG: configPath};
    await configurePolicy({enabled: true, scope: 'all-workspaces', workspaces: []}, env); await writeFile(configPath, JSON.stringify(local));
    await runClaudeHook({hook_event_name: 'UserPromptSubmit', session_id: 'session-1', cwd: process.cwd(), prompt: 'Inspect the parser regression.'}, {env});
    const event = (id: string) => ({hook_event_name: 'PostToolBatch', session_id: 'session-1', cwd: process.cwd(), tool_calls: [{tool_name: 'Read', tool_use_id: id, tool_input: {secret: 'excluded'}, tool_response: {output: 'excluded'}}]});
    let calls = 0; let release: ((result: {status: string; choice: string}) => void) | undefined;
    const service = {classifyDecision: async (input: {context: string}) => { calls++; assert.doesNotMatch(input.context, /excluded/); return await new Promise<{status: string; choice: string}>(resolve => { release = resolve; }); }};
    const first = runClaudeHook(event('late'), {env, service, hookTimeoutMs: 20});
    const duplicate = runClaudeHook(event('late'), {env, service, hookTimeoutMs: 20});
    const outputs = await Promise.all([first, duplicate]);
    assert.equal(calls, 1); assert.equal(outputs.filter(output => output.hookSpecificOutput).length, 1);
    const latePath = recordPath(local, 'session-1', 'main', ['late']);
    await assert.rejects(readFile(latePath, 'utf8'));
    release?.({status: 'assessed', choice: 'fast'}); await Promise.resolve();
    await assert.rejects(readFile(latePath, 'utf8'));
    const brokenPath = recordPath(local, 'session-1', 'main', ['interrupted']); await mkdir(brokenPath);
    const immediate = {classifyDecision: async () => ({status: 'assessed', choice: 'fast'})};
    assert.deepEqual(await runClaudeHook(event('interrupted'), {env, service: immediate}), {});
    assert.equal((await lstat(brokenPath)).isDirectory(), true);
    assert.equal((await readdir(join(brokenPath, '..'))).some(name => name.endsWith('.partial')), false);
    const linkPath = recordPath(local, 'session-1', 'main', ['unsafe']); await symlink(join(root, 'outside'), `${linkPath}.claim`);
    let unsafeCalls = 0;
    assert.deepEqual(await runClaudeHook(event('unsafe'), {env, service: {classifyDecision: async () => { unsafeCalls++; return {status: 'assessed', choice: 'fast'}; }}}), {});
    assert.equal(unsafeCalls, 0);
  } finally { await rm(root, {recursive: true, force: true}); }
});

test('changed-state producer suppresses fresh delivery IDs and consults again for changed objective or evidence', async () => {
  const parent = join(process.cwd(), '..', '..', '.agent-work'); await mkdir(parent, {recursive: true});
  const root = await mkdtemp(join(parent, 'claude-semantic-'));
  try {
    const stateDirectory = join(root, 'state'); const configPath = join(root, 'config.json'); const local = {...config, stateDirectory};
    const env = {JEV_STATE_DIRECTORY: stateDirectory, JEV_ENABLED: '1', JEV_CLAUDE_NATIVE_BRIDGE: '1', JEV_CLAUDE_ROUTING_CONFIG: configPath};
    await configurePolicy({enabled: true, scope: 'all-workspaces', workspaces: [], consultationMode: 'changed_state'}, env); await writeFile(configPath, JSON.stringify(local));
    const prompt = async (text: string) => await runClaudeHook({hook_event_name: 'UserPromptSubmit', session_id: 'session-1', cwd: process.cwd(), prompt: text}, {env});
    await prompt('Repair the parser regression.');
    let calls = 0;
    const consult = async (id: string, output = 'same observed result') => await runClaudeHook({hook_event_name: 'PostToolBatch', session_id: 'session-1', cwd: process.cwd(), tool_calls: [{tool_name: 'Read', tool_use_id: id, tool_input: {path: 'parser.ts'}, tool_response: {output}}]}, {env, service: {classifyDecision: async () => { calls++; return {status: 'assessed', choice: 'fast'}; }}});
    assert.ok((await consult('first')).hookSpecificOutput); assert.equal(calls, 1);
    assert.deepEqual(await consult('second'), {}); assert.equal(calls, 1);
    await prompt('Now investigate the failing concurrency case.');
    assert.ok((await consult('third')).hookSpecificOutput); assert.equal(calls, 2);
    assert.ok((await consult('fourth', 'contradictory failure evidence')).hookSpecificOutput); assert.equal(calls, 3);
  } finally { await rm(root, {recursive: true, force: true}); }
});

test('publication finishing after the absolute producer deadline leaves no applicable record', async () => {
  const parent = join(process.cwd(), '..', '..', '.agent-work'); await mkdir(parent, {recursive: true});
  const root = await mkdtemp(join(parent, 'claude-delayed-publication-'));
  const originalLink = fsp.link;
  let release: (() => void) | undefined;
  try {
    const stateDirectory = join(root, 'state'); const configPath = join(root, 'config.json'); const local = {...config, stateDirectory};
    const env = {JEV_STATE_DIRECTORY: stateDirectory, JEV_ENABLED: '1', JEV_CLAUDE_NATIVE_BRIDGE: '1', JEV_CLAUDE_ROUTING_CONFIG: configPath};
    await configurePolicy({enabled: true, scope: 'all-workspaces', workspaces: []}, env); await writeFile(configPath, JSON.stringify(local));
    await runClaudeHook({hook_event_name: 'UserPromptSubmit', session_id: 'session-1', cwd: process.cwd(), prompt: 'Repair the parser regression.'}, {env});
    const path = recordPath(local, 'session-1', 'main', ['a', 'b']);
    const gate = new Promise<void>(resolve => { release = resolve; });
    let entered: (() => void) | undefined; const linking = new Promise<void>(resolve => { entered = resolve; });
    let completedLink: (() => void) | undefined; const linked = new Promise<void>(resolve => { completedLink = resolve; });
    fsp.link = async (existing, destination) => {
      if (destination === path) { entered?.(); await gate; }
      await originalLink(existing, destination);
      if (destination === path) completedLink?.();
    };
    syncBuiltinESMExports();
    const work = runClaudeHook({hook_event_name: 'PostToolBatch', session_id: 'session-1', cwd: process.cwd(), tool_calls: [{tool_name: 'Read', tool_use_id: 'a'}, {tool_name: 'Bash', tool_use_id: 'b'}]}, {env, hookTimeoutMs: 200, service: {classifyDecision: async () => ({status: 'assessed', choice: 'fast'})}});
    await linking;
    assert.match((await work).hookSpecificOutput?.additionalContext ?? '', /reason=hook_timeout/);
    release?.(); await linked;
    const published = parseRecord(JSON.parse(await readFile(path, 'utf8')));
    assert.ok(published);
    assert.ok(published.expiresAt <= Date.now());
    assert.deepEqual(completed().select(step(1), published, local, {sessionId: 'session-1', workspace: process.cwd()}, Date.now()), step(1));
  } finally {
    release?.(); fsp.link = originalLink; syncBuiltinESMExports(); await rm(root, {recursive: true, force: true});
  }
});
