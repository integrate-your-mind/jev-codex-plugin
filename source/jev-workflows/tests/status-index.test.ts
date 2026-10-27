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
