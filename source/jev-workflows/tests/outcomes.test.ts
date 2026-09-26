import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {recordDecisionOutcome} from '../src/outcomes.js';

const receiptId = '12345678-1234-4234-8234-123456789abc';

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'jev-outcomes-'));
  await mkdir(join(root, 'receipts'));
  await writeFile(join(root, 'receipts', `${receiptId}.json`), JSON.stringify({receiptId, timestamp: new Date().toISOString(), status: 'assessed', transport: {providerRequestId: 'provider:req-1'}}));
  return root;
}

test('records a caller observation only against an existing receipt', async () => {
  const root = await fixture();
  try {
    const result = await recordDecisionOutcome({
      receiptId,
      actualActionId: 'tool:run-tests',
      evidenceIds: ['receipt:result-1', 'test:unit-1'],
      observedOutcome: 'supported',
      callerReported: true,
      observedAt: '2026-09-26T06:00:00Z',
      providerRequestId: 'provider:req-1',
    }, {directory: root});
    assert.equal(result.schemaVersion, 1);
    assert.equal(result.receiptId, receiptId);
    assert.equal(result.actualActionId, 'tool:run-tests');
    assert.equal(result.provenance.independentlyVerified, false);
    assert.equal(result.provenance.callerClaimOnly, true);
    assert.equal(result.providerRequestId, 'provider:req-1');
    const files = await readdir(join(root, 'outcomes'));
    assert.deepEqual(files, [`${result.outcomeId}.json`]);
    assert.deepEqual(JSON.parse(await readFile(join(root, 'outcomes', files[0]!), 'utf8')), result);
  } finally { await rm(root, {recursive: true, force: true}); }
});

test('rejects private claims, unknown fields, duplicate evidence, and missing receipts', async () => {
  const root = await fixture();
  try {
    const base = {receiptId, actionId: 'action-1', evidenceIds: ['evidence-1'], observed: 'unknown', callerReported: true, observedAt: '2026-09-26T06:00:00Z'};
    await assert.rejects(() => recordDecisionOutcome({...base, privateContext: 'secret'}, {directory: root}), /invalid_outcome/);
    await assert.rejects(() => recordDecisionOutcome({...base, evidenceIds: ['evidence-1', 'evidence-1']}, {directory: root}), /invalid_outcome/);
    await assert.rejects(() => recordDecisionOutcome({...base, receiptId: '12345678-1234-4234-8234-000000000000'}, {directory: root}), /receipt_not_found/);
    await assert.rejects(() => recordDecisionOutcome({...base, callerReported: false}, {directory: root}), /invalid_outcome/);
    await assert.rejects(() => recordDecisionOutcome({...base, responseClass: 'billed'}, {directory: root}), /invalid_outcome/);
    await assert.rejects(() => recordDecisionOutcome({...base, providerRequestId: 'provider:other'}, {directory: root}), /provider_request_mismatch/);
  } finally { await rm(root, {recursive: true, force: true}); }
});
