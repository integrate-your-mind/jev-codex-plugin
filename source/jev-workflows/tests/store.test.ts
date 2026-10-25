import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, symlink, stat, utimes } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { dataDirectory, FileStore } from '../src/store.js';

test('JEV_STATE_DIRECTORY is the validated host-local state override', () => {
  assert.equal(dataDirectory({JEV_STATE_DIRECTORY: '/tmp/jev-state', PLUGIN_DATA: '/tmp/plugin-data'}), '/tmp/jev-state');
  assert.equal(dataDirectory({JEV_STATE_DIRECTORY: '/tmp/jev-state', JEV_STATE_MODE: 'user', PLUGIN_DATA: '/tmp/plugin-data'}), '/tmp/jev-state');
  assert.equal(dataDirectory({JEV_STATE_DIRECTORY: 'relative', PLUGIN_DATA: '/tmp/plugin-data'}), '/tmp/plugin-data');
  assert.equal(dataDirectory({JEV_STATE_DIRECTORY: '/tmp/jev\0state', PLUGIN_DATA: '/tmp/plugin-data'}), '/tmp/plugin-data');
});

test('neutral user state mode bypasses host plugin data while portable mode preserves it', () => {
  assert.equal(dataDirectory({JEV_STATE_MODE: 'user', XDG_STATE_HOME: '/tmp/jev-user-state', PLUGIN_DATA: '/tmp/plugin-data'}), '/tmp/jev-user-state/jev-workflows');
  assert.equal(dataDirectory({JEV_STATE_MODE: 'user', XDG_STATE_HOME: '/tmp/jev-user-state', JEV_STATE_DIRECTORY: 'relative', PLUGIN_DATA: '/tmp/plugin-data'}), '/tmp/jev-user-state/jev-workflows');
  assert.equal(dataDirectory({XDG_STATE_HOME: '/tmp/jev-user-state', PLUGIN_DATA: '/tmp/plugin-data'}), '/tmp/plugin-data');
});

test('file budgets are shared across instances and never overspend on concurrent calls', async () => {
  const parent = resolve('../../work/jev-build');
  await mkdir(parent, {recursive: true});
  const dir = await mkdtemp(join(parent, 'store-test-'));
  try {
    const stores = [new FileStore(dir, 3, 300), new FileStore(dir, 3, 300)];
    const grants = await Promise.all(Array.from({length: 8}, (_, i) => stores[i % 2]!.reserve(100)));
    assert.equal(grants.filter(Boolean).length, 3);
    assert.equal(await new FileStore(dir, 3, 300).reserve(1), false);
    const usage = JSON.parse(await readFile(join(dir, `budget-${new Date().toISOString().slice(0, 10)}.json`), 'utf8'));
    assert.deepEqual(usage, {calls: 3, bytes: 300});
    await assert.rejects(() => stat(join(dir, `budget-${new Date().toISOString().slice(0, 10)}.json.lock`)), {code: 'ENOENT'});
    const receiptId = '12345678-1234-1234-1234-123456789abc';
    await stores[0]!.save({receiptId, status: 'assessed'});
    assert.equal(JSON.parse(await readFile(join(dir, 'receipts', `${receiptId}.json`), 'utf8')).receiptId, receiptId);
    await assert.rejects(() => stores[0]!.save({receiptId, status: 'overwritten'}), {code: 'EEXIST'});
    assert.equal(JSON.parse(await readFile(join(dir, 'receipts', `${receiptId}.json`), 'utf8')).status, 'assessed');
  } finally { await rm(dir, {recursive: true}); }
});

test('invalid or symlinked budget state fails closed rather than resetting usage', async () => {
  const parent = resolve('../../work/jev-build');
  await mkdir(parent, {recursive: true});
  const dir = await mkdtemp(join(parent, 'store-test-'));
  const path = join(dir, `budget-${new Date().toISOString().slice(0, 10)}.json`);
  try {
    await writeFile(path, '{"calls":-1,"bytes":0}');
    await assert.rejects(() => new FileStore(dir).reserve(1));
    await rm(path);
    const outside = join(dir, 'unrelated.json');
    await writeFile(outside, '{"calls":0,"bytes":0}');
    await symlink(outside, path);
    await assert.rejects(() => new FileStore(dir).reserve(1));
    assert.equal(await readFile(outside, 'utf8'), '{"calls":0,"bytes":0}');
  } finally { await rm(dir, {recursive: true}); }
});

test('unlimited stores retain usage past the former default caps', async () => {
  const parent = resolve('../../work/jev-build');
  await mkdir(parent, {recursive: true});
  const dir = await mkdtemp(join(parent, 'store-test-'));
  try {
    const store = new FileStore(dir, null, null);
    for (let i = 0; i < 65; i++) assert.equal(await store.reserve(1), true);
    const usage = JSON.parse(await readFile(join(dir, `budget-${new Date().toISOString().slice(0, 10)}.json`), 'utf8'));
    assert.deepEqual(usage, {calls: 65, bytes: 65});
  } finally { await rm(dir, {recursive: true}); }
});

test('rejects invalid reservation byte sizes before touching shared state', async () => {
  const parent = resolve('../../work/jev-build');
  await mkdir(parent, {recursive: true});
  const dir = await mkdtemp(join(parent, 'store-test-'));
  try {
    const store = new FileStore(dir, null, null);
    await assert.rejects(() => store.reserve(-1), {name: 'TypeError', message: 'invalid_reservation_bytes'});
    await assert.rejects(() => store.reserve(Number.NaN), {name: 'TypeError', message: 'invalid_reservation_bytes'});
    await assert.rejects(() => store.reserve(Number.MAX_SAFE_INTEGER + 1), {name: 'TypeError', message: 'invalid_reservation_bytes'});
    await assert.rejects(() => stat(join(dir, `budget-${new Date().toISOString().slice(0, 10)}.json`)), {code: 'ENOENT'});
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test('reclaims only an old lock whose recorded writer is definitely gone', async () => {
  const parent = resolve('../../work/jev-build');
  await mkdir(parent, {recursive: true});
  const dir = await mkdtemp(join(parent, 'store-test-'));
  const path = join(dir, `budget-${new Date().toISOString().slice(0, 10)}.json`);
  const lock = `${path}.lock`;
  try {
    await writeFile(lock, JSON.stringify({pid: 99999999, token: '12345678-1234-4234-8234-123456789abc', createdAt: '2020-01-01T00:00:00.000Z'}));
    const old = new Date(Date.now() - 120_000);
    await utimes(lock, old, old);
    assert.equal(await new FileStore(dir, 1, 10).reserve(1), true);
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), {calls: 1, bytes: 1});
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test('reclaims an old ownerless lock left by a writer interrupted before publishing its owner', async () => {
  const parent = resolve('../../work/jev-build');
  await mkdir(parent, {recursive: true});
  const dir = await mkdtemp(join(parent, 'store-test-'));
  const day = new Date().toISOString().slice(0, 10);
  const budget = join(dir, `budget-${day}.json`);
  const index = join(dir, `receipt-index-${day}.json`);
  try {
    // Releases up to 0.5.1 created the lock before writing its owner, so a
    // process killed in between (for example by a host hook timeout) left an
    // empty lock that every later writer waited on for the rest of the day.
    const old = new Date(Date.now() - 120_000);
    for (const lock of [`${budget}.lock`, `${index}.lock`]) {
      await writeFile(lock, '');
      await utimes(lock, old, old);
    }
    const store = new FileStore(dir, 5, 100);
    assert.equal(await store.reserve(1), true);
    assert.deepEqual(JSON.parse(await readFile(budget, 'utf8')), {calls: 1, bytes: 1});
    const receiptId = '12345678-1234-4234-8234-123456789abd';
    await store.save({receiptId, status: 'assessed', timestamp: new Date().toISOString()});
    assert.deepEqual(JSON.parse(await readFile(index, 'utf8')).receiptIds, [receiptId]);
    for (const lock of [`${budget}.lock`, `${index}.lock`]) await assert.rejects(() => stat(lock), {code: 'ENOENT'});
    assert.deepEqual((await readdir(dir)).filter(name => name.endsWith('.tmp')), []);
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test('keeps a recent ownerless lock because its writer may still be publishing', async () => {
  const parent = resolve('../../work/jev-build');
  await mkdir(parent, {recursive: true});
  const dir = await mkdtemp(join(parent, 'store-test-'));
  const budget = join(dir, `budget-${new Date().toISOString().slice(0, 10)}.json`);
  try {
    await writeFile(`${budget}.lock`, '');
    await assert.rejects(() => new FileStore(dir, 5, 100).reserve(1), /budget_busy/);
    assert.equal((await stat(`${budget}.lock`)).size, 0);
    await assert.rejects(() => stat(budget), {code: 'ENOENT'});
    assert.deepEqual((await readdir(dir)).filter(name => name.endsWith('.tmp')), []);
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test('an index past its bound is left alone without blocking the receipt on its lock', async () => {
  const parent = resolve('../../work/jev-build');
  await mkdir(parent, {recursive: true});
  const dir = await mkdtemp(join(parent, 'store-test-'));
  const index = join(dir, `receipt-index-${new Date().toISOString().slice(0, 10)}.json`);
  try {
    const oversized = JSON.stringify({version: 1, date: 'x', receiptIds: [], padding: 'p'.repeat(65_536)});
    await writeFile(index, oversized);
    // A busy index lock must not hold up the receipt once the index is full.
    await writeFile(`${index}.lock`, JSON.stringify({pid: process.pid, token: '12345678-1234-4234-8234-123456789abe', createdAt: new Date().toISOString()}));
    const receiptId = '12345678-1234-4234-8234-123456789abf';
    await new FileStore(dir).save({receiptId, status: 'assessed', timestamp: new Date().toISOString()});
    assert.equal(JSON.parse(await readFile(join(dir, 'receipts', `${receiptId}.json`), 'utf8')).receiptId, receiptId);
    assert.equal(await readFile(index, 'utf8'), oversized);
    assert.match(await readFile(`${index}.lock`, 'utf8'), /12345678-1234-4234-8234-123456789abe/);
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test('contended lock acquisitions publish complete owners and leave no temporary files', async () => {
  const parent = resolve('../../work/jev-build');
  await mkdir(parent, {recursive: true});
  const dir = await mkdtemp(join(parent, 'store-test-'));
  try {
    const limited = Array.from({length: 4}, () => new FileStore(dir, 100, 10_000));
    const unlimited = Array.from({length: 4}, () => new FileStore(dir));
    const grants = await Promise.all([...limited, ...unlimited].flatMap(store => [store.reserve(10), store.reserve(10)]));
    assert.ok(grants.every(Boolean));
    await Promise.all(Array.from({length: 6}, (_, index) => limited[index % 4]!.save({receiptId: `12345678-1234-4234-8234-1234567890${String(index).padStart(2, '0')}`, status: 'assessed', timestamp: new Date().toISOString()})));
    const leftovers = (await readdir(dir)).filter(name => name.endsWith('.tmp') || name.endsWith('.lock'));
    assert.deepEqual(leftovers, []);
    const usage = JSON.parse(await readFile(join(dir, `budget-${new Date().toISOString().slice(0, 10)}.json`), 'utf8')) as {calls: number};
    assert.ok(usage.calls >= 8 && usage.calls <= 16);
  } finally { await rm(dir, {recursive: true, force: true}); }
});


test('a delayed legacy reclaimer cannot delete a replacement owner', async () => {
  const parent = resolve('../../work/jev-build');
  await mkdir(parent, {recursive: true});
  const dir = await mkdtemp(join(parent, 'store-reclaimer-race-'));
  const budget = join(dir, `budget-${new Date().toISOString().slice(0, 10)}.json`);
  const lock = `${budget}.lock`;
  const deferred = () => {
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    return {promise, resolve};
  };
  const sawA = deferred();
  const releaseA = deferred();
  const sawB = deferred();
  const releaseB = deferred();
  const originalUnlink = fs.unlink;
  const originalRename = fs.rename;
  let unlinks = 0;
  let writes = 0;
  try {
    await writeFile(lock, '');
    const old = new Date(Date.now() - 120_000);
    await utimes(lock, old, old);
    fs.unlink = async path => {
      if (String(path) === lock && unlinks++ === 0) { sawA.resolve(); await releaseA.promise; }
      return originalUnlink(path);
    };
    fs.rename = async (source, target) => {
      if (String(target) === budget && writes++ === 0) { sawB.resolve(); await releaseB.promise; }
      return originalRename(source, target);
    };
    syncBuiltinESMExports();
    const a = new FileStore(dir, 1, 100).reserve(1).catch(error => {
      assert.match(error.message, /budget_busy/);
      return false;
    });
    await sawA.promise;
    const b = new FileStore(dir, 1, 100).reserve(1);
    await sawB.promise;
    releaseA.resolve();
    const aGranted = await a;
    releaseB.resolve();
    const bGranted = await b;
    assert.equal(Number(aGranted) + Number(bGranted), 1);
    assert.deepEqual(JSON.parse(await readFile(budget, 'utf8')), {calls: 1, bytes: 1});
  } finally {
    releaseA.resolve();
    releaseB.resolve();
    fs.unlink = originalUnlink;
    fs.rename = originalRename;
    syncBuiltinESMExports();
    await rm(dir, {recursive: true, force: true});
  }
});

function storeProcess(script: string) {
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script], {stdio: ['pipe', 'pipe', 'pipe', 'ipc']});
  let output = '';
  let errors = '';
  assert.ok(child.stdout);
  assert.ok(child.stderr);
  child.stdout.on('data', data => { output += data; });
  child.stderr.on('data', data => { errors += data; });
  const finished = once(child, 'exit').then(([code, signal]) => ({code, signal, output, errors}));
  return {child, finished};
}

const storeModule = pathToFileURL(resolve('src/store.ts')).href;

test('separate processes recover one abandoned lock without losing reservations', async () => {
  const parent = resolve('../../work/jev-build');
  await mkdir(parent, {recursive: true});
  const dir = await mkdtemp(join(parent, 'store-process-race-'));
  const budget = join(dir, `budget-${new Date().toISOString().slice(0, 10)}.json`);
  try {
    await writeFile(`${budget}.lock`, '');
    const old = new Date(Date.now() - 120_000);
    await utimes(`${budget}.lock`, old, old);
    const children = Array.from({length: 8}, () => storeProcess(`
      import {FileStore} from ${JSON.stringify(storeModule)};
      await new Promise(resolve => { process.once('message', resolve); process.send('ready'); });
      process.stdout.write(JSON.stringify(await new FileStore(${JSON.stringify(dir)}, 4, 4).reserve(1)));
      process.disconnect();
    `));
    await Promise.all(children.map(({child}) => once(child, 'message')));
    for (const {child} of children) child.send('go');
    const results = await Promise.all(children.map(({finished}) => finished));
    for (const result of results) assert.equal(result.code, 0, result.errors);
    assert.equal(results.filter(result => JSON.parse(result.output)).length, 4);
    assert.deepEqual(JSON.parse(await readFile(budget, 'utf8')), {calls: 4, bytes: 4});
    assert.deepEqual((await readdir(dir)).filter(name => name.endsWith('.lock') || name.endsWith('.tmp')), []);
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test('a killed process releases no lock early and its abandoned directory is recoverable', async () => {
  const parent = resolve('../../work/jev-build');
  await mkdir(parent, {recursive: true});
  const dir = await mkdtemp(join(parent, 'store-killed-owner-'));
  const budget = join(dir, `budget-${new Date().toISOString().slice(0, 10)}.json`);
  const lock = `${budget}.lock`;
  const {child, finished} = storeProcess(`
    import fs from 'node:fs/promises';
    import {syncBuiltinESMExports} from 'node:module';
    const original = fs.rename;
    fs.rename = async (source, target) => {
      if (String(target) === ${JSON.stringify(budget)}) { process.send('held'); setInterval(() => {}, 1000); await new Promise(() => {}); }
      return original(source, target);
    };
    syncBuiltinESMExports();
    const {FileStore} = await import(${JSON.stringify(storeModule)});
    await new FileStore(${JSON.stringify(dir)}, 1, 100).reserve(1);
  `);
  try {
    await once(child, 'message');
    const entries = await readdir(lock);
    assert.equal(entries.length, 1);
    assert.equal((await stat(lock)).mode & 0o777, 0o700);
    assert.equal((await stat(join(lock, entries[0]!))).mode & 0o777, 0o600);
    const old = new Date(Date.now() - 120_000);
    await utimes(lock, old, old);
    await assert.rejects(() => new FileStore(dir, 1, 100).reserve(1), /budget_busy/);
    child.kill('SIGKILL');
    assert.equal((await finished).signal, 'SIGKILL');
    assert.equal(await new FileStore(dir, 1, 100).reserve(1), true);
    assert.deepEqual(JSON.parse(await readFile(budget, 'utf8')), {calls: 1, bytes: 1});
    await assert.rejects(() => stat(lock), {code: 'ENOENT'});
  } finally {
    child.kill('SIGKILL');
    await finished;
    await rm(dir, {recursive: true, force: true});
  }
});

test('unknown lock directory contents fail closed and remain untouched', async () => {
  const parent = resolve('../../work/jev-build');
  await mkdir(parent, {recursive: true});
  const dir = await mkdtemp(join(parent, 'store-invalid-lock-'));
  const budget = join(dir, `budget-${new Date().toISOString().slice(0, 10)}.json`);
  const lock = `${budget}.lock`;
  try {
    await mkdir(lock);
    await writeFile(join(lock, 'unknown'), 'preserve');
    const old = new Date(Date.now() - 120_000);
    await utimes(lock, old, old);
    await assert.rejects(() => new FileStore(dir, 1, 100).reserve(1), /budget_busy/);
    assert.equal(await readFile(join(lock, 'unknown'), 'utf8'), 'preserve');
  } finally { await rm(dir, {recursive: true, force: true}); }
});
