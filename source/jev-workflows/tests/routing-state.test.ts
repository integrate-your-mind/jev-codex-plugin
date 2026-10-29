import {it} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir, mkdtemp, rm, stat, writeFile, unlink, symlink, readdir, readFile, truncate} from 'node:fs/promises';
import {resolve, join} from 'node:path';
import {RoutingStateStore} from '../src/routing/state.js';
import type {RoutingRecord} from '../src/routing/contracts.js';

const scope = {hostId: 'host', accountId: 'account', workspaceId: 'workspace', sessionId: 'session', agentId: 'agent'};
const day = 24 * 60 * 60 * 1000;
const start = Date.parse('2026-10-01T00:00:00Z');
function record(id: string, overrides: Partial<RoutingRecord> = {}): RoutingRecord { return {schemaVersion: 'routing-v1', kind: 'test_fact', id, scope, createdAt: new Date(start).toISOString(), retention: 'facts', ...overrides}; }
async function fixture(run: (root: string) => Promise<void>): Promise<void> {
  const output = resolve('.agent-work');
  await mkdir(output, {recursive: true});
  const root = await mkdtemp(join(output, 'routing-state-'));
  try { await run(root); } finally { await rm(root, {recursive: true, force: true}); }
}

it('publishes immutable private records before pointers and isolates every scope dimension', async () => fixture(async root => {
  const store = new RoutingStateStore({stateDirectory: root, scope, now: () => new Date(start)});
  const fact = await store.publish(record('task-1'));
  assert.equal(fact.expiresAt, new Date(start + 7 * day).toISOString());
  assert.equal((await stat(store.directory)).mode & 0o777, 0o700);
  assert.equal((await store.current()).revision, 0);
  const committed = await store.compareAndSet(0, {task: fact.id});
  assert.equal(committed.status, 'committed');
  assert.equal((await stat(join(store.directory, 'current.json'))).mode & 0o777, 0o600);
  assert.deepEqual((await store.snapshot()).records.map(item => item.id), ['task-1']);
  await store.publish(record('task-1'));
  await assert.rejects(store.publish(record('task-1', {kind: 'rewritten'})), /immutable_record_conflict/);
  await assert.rejects(store.compareAndSet(1, {task: 'missing'}), /missing_record/);
  await store.publish(record('missing-dependency', {dependsOn: ['unpublished']}));
  await assert.rejects(store.compareAndSet(1, {task: 'missing-dependency'}), /missing_record/);
  assert.equal((await store.current()).revision, 1);
  for (const dimension of Object.keys(scope) as Array<keyof typeof scope>) {
    const isolated = new RoutingStateStore({stateDirectory: root, scope: {...scope, [dimension]: 'different'}, now: () => new Date(start)});
    assert.notEqual(isolated.directory, store.directory);
    assert.equal(await isolated.read('task-1'), null);
    assert.equal((await isolated.current()).revision, 0);
  }
  const wrong = new RoutingStateStore({stateDirectory: root, scope: {...scope, agentId: 'other'}});
  await assert.rejects(wrong.publish(record('cross-scope')), /invalid_routing_record/);
}));

it('uses compare-and-set for concurrent writers and rejects late results', async () => fixture(async root => {
  const first = new RoutingStateStore({stateDirectory: root, scope, now: () => new Date(start)});
  const second = new RoutingStateStore({stateDirectory: root, scope, now: () => new Date(start)});
  await first.publish(record('first'));
  await second.publish(record('second'));
  const results = await Promise.all([first.compareAndSet(0, {task: 'first'}), second.compareAndSet(0, {task: 'second'})]);
  assert.equal(results.filter(result => result.status === 'committed').length, 1);
  assert.equal(results.filter(result => result.status === 'conflict').length, 1);
  const current = await first.current();
  assert.equal(current.revision, 1);
  assert.equal((await first.compareAndSet(0, {task: 'second'})).status, 'conflict');
  assert.deepEqual(await second.current(), current);
}));

it('recovers interrupted pointer publication from the immutable revision and preserves orphan observations', async () => fixture(async root => {
  const store = new RoutingStateStore({stateDirectory: root, scope, now: () => new Date(start)});
  await store.publish(record('one'));
  await store.compareAndSet(0, {task: 'one'});
  await store.publish(record('unreferenced'));
  await unlink(join(store.directory, 'current.json'));
  const recovered = await store.recoverCurrent();
  assert.equal(recovered.revision, 1);
  assert.deepEqual(recovered.records, {task: 'one'});
  assert.ok(await store.read('unreferenced'));
  await writeFile(join(store.directory, 'current.json'), '{partial', {mode: 0o600});
  assert.deepEqual(await store.recoverCurrent(), recovered);
  await store.publish(record('two'));
  await store.compareAndSet(1, {task: 'two'});
  await writeFile(join(store.directory, 'current.json'), JSON.stringify(recovered), {mode: 0o600});
  assert.equal((await store.compareAndSet(1, {task: 'one'})).status, 'conflict');
  assert.equal((await store.current()).revision, 2);
}));

it('expires facts at seven days, metadata at ninety days, and retains pinned evidence dependencies', async () => fixture(async root => {
  let now = start;
  const store = new RoutingStateStore({stateDirectory: root, scope, now: () => new Date(now)});
  await store.publish(record('fact'));
  await store.publish(record('retained-fact'));
  await store.publish(record('pinned-study', {retention: 'pinned', dependsOn: ['retained-fact']}));
  const metadata = await store.publish(record('metadata', {retention: 'metadata'}));
  assert.equal(metadata.expiresAt, new Date(start + 90 * day).toISOString());
  await store.compareAndSet(0, {task: 'fact', outcome: 'metadata', study: 'pinned-study'});
  now = start + 7 * day;
  assert.equal(await store.read('fact'), null);
  assert.deepEqual(await store.prune(), ['fact']);
  assert.equal(await store.read('fact', {includeExpired: true}), null);
  assert.ok(await store.read('retained-fact', {includeExpired: true}));
  assert.deepEqual((await store.current()).records, {outcome: 'metadata', study: 'pinned-study'});
  assert.deepEqual((await store.snapshot()).records.map(item => item.id), ['metadata', 'pinned-study', 'retained-fact']);
  now = start + 90 * day;
  assert.deepEqual(await store.prune(), ['metadata']);
  assert.deepEqual((await store.current()).records, {study: 'pinned-study'});
  assert.ok(await store.read('pinned-study'));
  assert.equal((await readdir(join(store.directory, 'records'))).length, 2);
}));

it('backs up one immutable revision with transitive dependencies', async () => fixture(async root => {
  const store = new RoutingStateStore({stateDirectory: root, scope, now: () => new Date(start)});
  await store.publish(record('source'));
  await store.publish(record('evidence', {dependsOn: ['source']}));
  await store.compareAndSet(0, {task: 'evidence'});
  const saved = await store.snapshot();
  await store.publish(record('next'));
  await store.compareAndSet(1, {task: 'next'});
  assert.deepEqual(saved.current.records, {task: 'evidence'});
  assert.deepEqual(saved.records.map(item => item.id), ['evidence', 'source']);
  assert.notDeepEqual((await store.current()).records, saved.current.records);
}));

it('refuses a symlink in its owned state boundary', async () => fixture(async root => {
  const outside = join(root, 'outside');
  await mkdir(outside, {mode: 0o700});
  await symlink(outside, join(root, 'routing-v1'));
  const store = new RoutingStateStore({stateDirectory: root, scope});
  await assert.rejects(store.current(), /unsafe_routing_directory/);
  assert.deepEqual(await readdir(outside), []);
}));

it('read-only status leaves an absent state tree unchanged', async () => fixture(async root => {
  const options = {stateDirectory: root, scope, now: () => new Date(start), readOnly: true};
  const absent = new RoutingStateStore(options);
  assert.equal((await absent.current()).revision, 0);
  assert.equal(await absent.read('missing'), null);
  assert.deepEqual(await readdir(root), []);
}));

it('read-only status leaves a partial state tree unchanged and rejects writes', async () => fixture(async root => {
  const options = {stateDirectory: root, scope, now: () => new Date(start), readOnly: true};
  const directory = new RoutingStateStore(options).directory;
  await mkdir(directory, {recursive: true, mode: 0o700});
  const partial = new RoutingStateStore(options);
  assert.equal((await partial.current()).revision, 0);
  assert.equal(await partial.read('missing'), null);
  assert.deepEqual(await readdir(partial.directory), []);
  for (const mutate of [() => partial.publish(record('forbidden')), () => partial.compareAndSet(0, {}), () => partial.recoverCurrent(), () => partial.snapshot(), () => partial.prune()]) {
    await assert.rejects(mutate(), /routing_store_read_only/);
    assert.deepEqual(await readdir(partial.directory), []);
  }
}));

it('read-only status reads existing state without repairing a missing pointer or journal children', async () => fixture(async root => {
  const writable = new RoutingStateStore({stateDirectory: root, scope, now: () => new Date(start)});
  await writable.publish(record('one'));
  await writable.compareAndSet(0, {task: 'one'});
  const before = await readFile(join(writable.directory, 'current.json'), 'utf8');
  const options = {stateDirectory: root, scope, now: () => new Date(start), readOnly: true};
  const readonly = new RoutingStateStore(options);
  assert.equal((await readonly.current()).revision, 1);
  assert.ok(await readonly.read('one'));
  assert.equal(await readFile(join(writable.directory, 'current.json'), 'utf8'), before);
  await unlink(join(writable.directory, 'current.json'));
  assert.equal((await readonly.current()).revision, 0);
  await assert.rejects(stat(join(writable.directory, 'current.json')), {code: 'ENOENT'});
}));

it('read-only status refuses directory symlinks and oversized or nonregular state files', async () => fixture(async root => {
  const options = {stateDirectory: root, scope, now: () => new Date(start), readOnly: true};
  const store = new RoutingStateStore(options);
  await mkdir(store.directory, {recursive: true, mode: 0o700});
  const target = join(root, 'outside');
  await mkdir(target, {mode: 0o700});
  await symlink(target, join(store.directory, 'records'));
  await assert.rejects(store.read('missing'), /unsafe_routing_directory/);
  assert.deepEqual(await readdir(target), []);
  await unlink(join(store.directory, 'records'));
  await mkdir(join(store.directory, 'current.json'), {mode: 0o700});
  await assert.rejects(store.current(), /unsafe_routing_file/);
  await rm(join(store.directory, 'current.json'), {recursive: true});
  await writeFile(join(store.directory, 'current.json'), '', {mode: 0o600});
  await truncate(join(store.directory, 'current.json'), 64 * 1024 * 1024 + 1);
  await assert.rejects(store.current(), /unsafe_routing_file/);
}));
