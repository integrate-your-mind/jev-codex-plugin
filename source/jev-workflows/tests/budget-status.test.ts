import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readBudgetUsage } from '../src/store.js';

async function makeTempDirectory(): Promise<string> {
  const parent = join(process.cwd(), 'work', 'jev-build');
  await mkdir(parent, {recursive: true});
  return mkdtemp(join(parent, 'budget-status-'));
}

test('reports valid usage and the next UTC midnight without writing state', async () => {
  const directory = await makeTempDirectory();
  const now = new Date('2026-09-18T23:59:59.999Z');
  const path = join(directory, 'budget-2026-09-18.json');
  try {
    await writeFile(path, JSON.stringify({calls: 7, bytes: 640}), {mode: 0o600});
    const before = await readFile(path, 'utf8');
    assert.deepEqual(await readBudgetUsage(directory, 64, 1_000, now), {
      date: '2026-09-18',
      countingBasis: 'local_pre_dispatch_reservations',
      reservedAttempts: 7,
      reservedPayloadBytes: 640,
      note: 'Reserved before provider dispatch, including attempts that fail or never receive a response. callsUsed and bytesUsed are compatibility aliases, not successful-request counts or billed usage. See evaluations for retained response evidence.',
      callsUsed: 7,
      bytesUsed: 640,
      callsRemaining: 57,
      bytesRemaining: 360,
      resetsAt: '2026-09-19T00:00:00.000Z',
      status: 'ok',
    });
    assert.equal(await readFile(path, 'utf8'), before);
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

test('treats a missing budget as unused without creating its directory', async () => {
  const parent = await makeTempDirectory();
  const directory = join(parent, 'missing');
  try {
    assert.deepEqual(await readBudgetUsage(directory, 64, 1_000, new Date('2026-09-18T01:02:03Z')), {
      date: '2026-09-18',
      countingBasis: 'local_pre_dispatch_reservations',
      reservedAttempts: 0,
      reservedPayloadBytes: 0,
      note: 'Reserved before provider dispatch, including attempts that fail or never receive a response. callsUsed and bytesUsed are compatibility aliases, not successful-request counts or billed usage. See evaluations for retained response evidence.',
      callsUsed: 0,
      bytesUsed: 0,
      callsRemaining: 64,
      bytesRemaining: 1_000,
      resetsAt: '2026-09-19T00:00:00.000Z',
      status: 'ok',
    });
    await assert.rejects(() => stat(directory), {code: 'ENOENT'});
  } finally {
    await rm(parent, {recursive: true, force: true});
  }
});

test('fails closed for malformed or oversized budget state', async () => {
  const directory = await makeTempDirectory();
  const path = join(directory, 'budget-2026-09-18.json');
  try {
    await writeFile(path, '{"calls":"seven","bytes":0}', {mode: 0o600});
    const malformed = await readBudgetUsage(directory, 64, 1_000, new Date('2026-09-18T12:00:00Z'));
    assert.equal(malformed.status, 'unavailable');
    assert.equal(malformed.callsUsed, null);
    assert.equal(malformed.bytesUsed, null);
    assert.equal(malformed.callsRemaining, 0);
    assert.equal(malformed.bytesRemaining, 0);

    await writeFile(path, 'x'.repeat(4097), {mode: 0o600});
    const oversized = await readBudgetUsage(directory, 64, 1_000, new Date('2026-09-18T12:00:00Z'));
    assert.equal(oversized.status, 'unavailable');
    assert.equal(oversized.callsUsed, null);
    assert.equal(oversized.bytesUsed, null);
    assert.equal(oversized.callsRemaining, 0);
    assert.equal(oversized.bytesRemaining, 0);
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

test('fails closed for a symlinked budget and does not read outside state', async () => {
  const directory = await makeTempDirectory();
  const path = join(directory, 'budget-2026-09-18.json');
  const outside = join(directory, 'outside.json');
  try {
    await writeFile(outside, JSON.stringify({calls: 2, bytes: 20}), {mode: 0o600});
    await symlink(outside, path);
    const usage = await readBudgetUsage(directory, 64, 1_000, new Date('2026-09-18T12:00:00Z'));
    assert.equal(usage.status, 'unavailable');
    assert.equal(usage.callsUsed, null);
    assert.equal(usage.bytesUsed, null);
    assert.equal(usage.callsRemaining, 0);
    assert.equal(usage.bytesRemaining, 0);
    assert.equal(await readFile(outside, 'utf8'), JSON.stringify({calls: 2, bytes: 20}));
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

test('uses the UTC date even when the local offset crosses a calendar boundary', async () => {
  const directory = await makeTempDirectory();
  try {
    const usage = await readBudgetUsage(directory, 64, 1_000, new Date('2026-09-18T23:30:00-05:00'));
    assert.equal(usage.date, '2026-09-19');
    assert.equal(usage.resetsAt, '2026-09-20T00:00:00.000Z');
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

test('reports reserved attempts while leaving remaining caps null when unlimited', async () => {
  const directory = await makeTempDirectory();
  const path = join(directory, 'budget-2026-09-18.json');
  try {
    await writeFile(path, JSON.stringify({calls: 65, bytes: 1_000_001}), {mode: 0o600});
    const usage = await readBudgetUsage(directory, null, null, new Date('2026-09-18T12:00:00Z'));
    assert.equal(usage.status, 'ok');
    assert.equal(usage.callsUsed, 65);
    assert.equal(usage.bytesUsed, 1_000_001);
    assert.equal(usage.callsRemaining, null);
    assert.equal(usage.bytesRemaining, null);
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});
