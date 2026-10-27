import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {readEvaluationUsage} from '../src/accounting.js';

const now = new Date('2026-10-27T12:00:00Z');
const currentId = '00000000-0000-4000-8000-000000000001';
const historicalId = '00000000-0000-4000-8000-000000000002';
const fingerprint = 'a'.repeat(64);
const receiptId = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

async function fixture() {
  const root = await fs.mkdtemp(join(tmpdir(), 'jev-status-index-'));
  await fs.mkdir(join(root, 'receipts'));
  return root;
}

async function writeReceipt(root: string, n: number, timestamp = now.toISOString()) {
  const id = receiptId(n);
  await fs.writeFile(join(root, 'receipts', `${id}.json`), JSON.stringify({receiptId: id, timestamp, status: 'assessed',
    transport: {fetchInvoked: true, responseStatus: 200, validatedResponse: true, credentialFingerprint: fingerprint}}));
}

async function writeIndex(root: string, ids: string[]) {
  await fs.writeFile(join(root, 'receipt-index-2026-10-27.json'), JSON.stringify({version: 1, date: '2026-10-27', receiptIds: ids}));
}

test('indexed status never enumerates history or treats its unobserved coverage as complete', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'jev-status-index-'));
  const receipts = join(root, 'receipts');
  await fs.mkdir(receipts);
  await fs.writeFile(join(receipts, `${currentId}.json`), JSON.stringify({
    receiptId: currentId, timestamp: now.toISOString(), status: 'assessed',
    transport: {fetchInvoked: true, responseStatus: 200, validatedResponse: true, credentialFingerprint: fingerprint},
  }));
  await fs.writeFile(join(receipts, `${historicalId}.json`), '{historical content is deliberately unreadable');
  await fs.writeFile(join(root, 'receipt-index-2026-10-27.json'), JSON.stringify({version: 1, date: '2026-10-27', receiptIds: [currentId]}));
  const original = fs.readdir;
  let historicalEnumerations = 0;
  fs.readdir = (async (...args: Parameters<typeof original>) => {
    if (String(args[0]) === receipts) {
      historicalEnumerations++;
      throw new Error('historical_enumeration_forbidden');
    }
    return original(...args);
  }) as typeof original;
  syncBuiltinESMExports();
  try {
    const result = await readEvaluationUsage(root, fingerprint, now, {mode: 'indexed'});
    assert.equal(historicalEnumerations, 0);
    assert.equal(result.totals.receipts, 1);
    assert.equal(result.malformedOrUnreadable, 0);
    assert.equal(result.inventoryFiles, null);
    assert.equal(result.unindexedReceiptFiles, null);
    assert.equal(result.inventoryComplete, false);
    assert.equal(result.countsIncomplete, true);
    assert.match(result.countsIncompleteReason ?? '', /full_inventory_not_scanned/);
    assert.equal(result.providerBilledRequests, null);
    assert.equal(result.billingReconciled, false);
  } finally {
    fs.readdir = original;
    syncBuiltinESMExports();
    await fs.rm(root, {recursive: true, force: true});
  }
});

test('indexed status returns partial diagnostics for missing and corrupt indexes without repairing them', async () => {
  for (const state of ['missing', 'corrupt'] as const) {
    const root = await fixture();
    const path = join(root, 'receipt-index-2026-10-27.json');
    try {
      await writeReceipt(root, 1);
      if (state === 'corrupt') await fs.writeFile(path, '{corrupt');
      const result = await readEvaluationUsage(root, fingerprint, now, {mode: 'indexed'});
      assert.equal(result.indexStatus, state);
      assert.equal(result.scanMode, 'daily-index');
      assert.equal(result.scannedFiles, 0);
      assert.equal(result.inventoryFiles, null);
      assert.equal(result.indexFallbackUsed, false);
      assert.equal(result.inventoryReadable, false);
      assert.equal(result.countsIncomplete, true);
      assert.match(result.countsIncompleteReason ?? '', new RegExp(`daily_index_${state}`));
      if (state === 'corrupt') assert.equal(await fs.readFile(path, 'utf8'), '{corrupt');
      else await assert.rejects(fs.stat(path), {code: 'ENOENT'});
    } finally { await fs.rm(root, {recursive: true, force: true}); }
  }
});

test('indexed status exposes wrong-date, missing and symlinked entries without reading outside evidence', async () => {
  const root = await fixture();
  try {
    await writeReceipt(root, 1, '2026-10-26T12:00:00Z');
    const privatePath = join(root, 'private.json');
    await fs.writeFile(privatePath, 'do not count this as receipt evidence');
    await fs.symlink(privatePath, join(root, 'receipts', `${receiptId(2)}.json`));
    await writeIndex(root, [receiptId(1), receiptId(2), receiptId(3)]);
    const result = await readEvaluationUsage(root, fingerprint, now, {mode: 'indexed'});
    assert.equal(result.totals.receipts, 0);
    assert.equal(result.indexDateMismatches, 1);
    assert.equal(result.missingIndexedReceiptFiles, 1);
    assert.equal(result.malformedOrUnreadable, 2);
    assert.equal(result.scannedFiles, 3);
    assert.equal(result.inventoryReadable, false);
    assert.equal(result.inventoryComplete, false);
    assert.match(result.countsIncompleteReason ?? '', /missing_indexed_receipts/);
    assert.match(result.countsIncompleteReason ?? '', /indexed_receipt_date_mismatch/);
    assert.equal(await fs.readFile(privatePath, 'utf8'), 'do not count this as receipt evidence');
  } finally { await fs.rm(root, {recursive: true, force: true}); }
});

test('indexed status rejects duplicate, oversized and symlinked indexes without following or replacing them', async () => {
  for (const kind of ['duplicate', 'oversized', 'symlink'] as const) {
    const root = await fixture();
    const path = join(root, 'receipt-index-2026-10-27.json');
    try {
      await writeReceipt(root, 1);
      if (kind === 'duplicate') await writeIndex(root, [receiptId(1), receiptId(1)]);
      else if (kind === 'oversized') await fs.writeFile(path, 'x'.repeat(1024 * 1024 + 1));
      else {
        await fs.writeFile(join(root, 'private-index.json'), JSON.stringify({version: 1, date: '2026-10-27', receiptIds: [receiptId(1)]}));
        await fs.symlink(join(root, 'private-index.json'), path);
      }
      const before = await fs.readFile(path, 'utf8');
      const result = await readEvaluationUsage(root, fingerprint, now, {mode: 'indexed'});
      assert.equal(result.indexStatus, 'corrupt');
      assert.equal(result.scannedFiles, 0);
      assert.equal(result.indexFallbackUsed, false);
      assert.equal(result.inventoryComplete, false);
      assert.equal(result.inventoryReadable, false);
      assert.equal(await fs.readFile(path, 'utf8'), before);
      if (kind === 'symlink') assert.equal((await fs.lstat(path)).isSymbolicLink(), true);
    } finally { await fs.rm(root, {recursive: true, force: true}); }
  }
});

test('an explicit full audit recovers an omitted current-day receipt without changing the index', async () => {
  const root = await fixture();
  try {
    await writeReceipt(root, 1);
    await writeReceipt(root, 2);
    await writeReceipt(root, 3, '2026-10-26T12:00:00Z');
    await writeIndex(root, [receiptId(1)]);
    const indexPath = join(root, 'receipt-index-2026-10-27.json');
    const before = await fs.readFile(indexPath, 'utf8');
    const indexed = await readEvaluationUsage(root, fingerprint, now, {mode: 'indexed'});
    const full = await readEvaluationUsage(root, fingerprint, now, {mode: 'full', publishIndex: false});
    assert.equal(indexed.totals.receipts, 1);
    assert.equal(indexed.inventoryComplete, false);
    assert.equal(full.scanMode, 'full');
    assert.equal(full.totals.receipts, 2);
    assert.equal(full.inventoryFiles, 3);
    assert.equal(full.unindexedReceiptFiles, 1);
    assert.equal(full.inventoryComplete, true);
    assert.equal(full.providerBilledRequests, null);
    assert.equal(full.billingReconciled, false);
    assert.equal(await fs.readFile(indexPath, 'utf8'), before);
    await fs.unlink(indexPath);
    const missing = await readEvaluationUsage(root, fingerprint, now, {mode: 'full', publishIndex: false});
    assert.equal(missing.totals.receipts, 2);
    await assert.rejects(fs.stat(indexPath), {code: 'ENOENT'});
  } finally { await fs.rm(root, {recursive: true, force: true}); }
});

test('a pre-cancelled audit does not begin file I/O', async () => {
  const controller = new AbortController();
  const reason = new Error('audit_cancelled');
  controller.abort(reason);
  const original = fs.readdir;
  let enumerations = 0;
  fs.readdir = (async () => { enumerations++; throw new Error('unexpected_io'); }) as typeof original;
  syncBuiltinESMExports();
  try {
    await assert.rejects(readEvaluationUsage('/unused', fingerprint, now, {mode: 'full', signal: controller.signal}), error => error === reason);
    assert.equal(enumerations, 0);
  } finally { fs.readdir = original; syncBuiltinESMExports(); }
});

test('cancelling a full audit stops queued reads and waits for active handles to close', async () => {
  const root = await fixture();
  for (let n = 1; n <= 20; n++) await writeReceipt(root, n);
  const controller = new AbortController();
  const reason = new Error('audit_cancelled');
  const original = fs.open;
  let opened = 0;
  let closed = 0;
  fs.open = (async (...args: Parameters<typeof original>) => {
    const handle = await original(...args);
    if (String(args[0]).startsWith(join(root, 'receipts') + '/')) {
      opened++;
      const close = handle.close.bind(handle);
      handle.close = async () => { await close(); closed++; };
      controller.abort(reason);
    }
    return handle;
  }) as typeof original;
  syncBuiltinESMExports();
  try {
    await assert.rejects(readEvaluationUsage(root, fingerprint, now, {mode: 'full', signal: controller.signal}), error => error === reason);
    assert.ok(opened > 0 && opened <= 8, `only active worker reads may open, observed ${opened}`);
    assert.equal(closed, opened);
  } finally {
    fs.open = original;
    syncBuiltinESMExports();
    await fs.rm(root, {recursive: true, force: true});
  }
});
