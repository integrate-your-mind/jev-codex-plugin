import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile, symlink } from 'node:fs/promises';
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
