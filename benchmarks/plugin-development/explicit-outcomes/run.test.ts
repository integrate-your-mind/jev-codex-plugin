import assert from 'node:assert/strict';
import {mkdtemp, readFile, readdir, rm, stat, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';

import {runExperiment, validateFrozenInputs} from './run.ts';

test('frozen source, fixtures, runner, and dependency versions validate', async () => {
  const validation = await validateFrozenInputs();
  assert.equal(validation.baseCommit, '7dfe432d7463bab7186a8dacf50924af282f9a20');
  assert.deepEqual(validation.apiSource, validation.frozenApiSource);
  assert.equal(validation.dependencyVersions.tsx, '4.23.13');
  assert.equal(validation.dependencyVersions.zod, '4.6.5');
  assert.ok(validation.fileCount >= 20);
});

test('real API storage remains caller-reported while fixture evidence is graded independently', async t => {
  const root = await mkdtemp(join(tmpdir(), 'jev-explicit-outcomes-test-'));
  const receiptPath = join(root, 'receipt.json');
  try {
    const result = await runExperiment({receiptPath});

    await t.test('all four cases retain the caller observation and read back exact stored records', () => {
      assert.equal(result.summary.plannedCases, 4);
      assert.equal(result.summary.completedCases, 4);
      assert.equal(result.summary.excludedCases, 0);
      assert.equal(result.summary.callerSupportedObservations, 4);
      assert.equal(result.summary.independentHarnessOraclePasses, 4);
      assert.equal(result.summary.storedRecordReadbacks, 6);
      assert.equal(result.summary.storedRecordReadbackMatches, 6);
      for (const item of result.cases) {
        assert.equal(item.apiRequest.observed, 'supported');
        assert.equal(item.pluginStorage.record.observedOutcome, 'supported');
        assert.equal(item.pluginStorage.record.provenance.independentlyVerified, false);
        assert.equal(item.pluginStorage.record.provenance.callerClaimOnly, true);
        assert.equal(item.pluginStorage.readback.exactMatch, true);
        assert.equal(item.pluginStorage.readback.mode, '600');
        assert.equal('providerRequestId' in item.pluginStorage.record, false);
        for (const harnessOnly of ['status', 'claim', 'revision', 'exitCode', 'stdoutDigest']) {
          assert.equal(harnessOnly in item.apiRequest, false, `${harnessOnly} leaked into API request`);
        }
      }
    });

    await t.test('false caller success claims are not overwritten by the independent verdict', () => {
      const assessments = Object.fromEntries(result.cases.map((item: any) => [item.caseId, item.independentHarness.assessment]));
      assert.deepEqual(assessments, {
        'outcome-normal': 'supported',
        'outcome-conflict': 'unknown',
        'outcome-stale': 'unsupported',
        'outcome-adversarial': 'contradicted',
      });
      assert.equal(result.summary.callerHarnessDivergences, 3);
      for (const caseId of ['outcome-conflict', 'outcome-stale', 'outcome-adversarial']) {
        const item = result.cases.find((candidate: any) => candidate.caseId === caseId);
        assert.equal(item.pluginStorage.record.observedOutcome, 'supported');
        assert.notEqual(item.independentHarness.assessment, item.pluginStorage.record.observedOutcome);
        assert.equal(item.callerAndHarnessAgree, false);
      }
    });

    await t.test('actual schema rejects harness fields and malformed alias combinations', () => {
      assert.equal(result.regressions.schema.validPayloads, 1);
      assert.equal(result.regressions.schema.invalidPayloads, 10);
      assert.ok(result.regressions.schema.invalidCases.every((item: any) => item.rejected));
      assert.deepEqual(result.regressions.schema.harnessOnlyFieldsRejected, ['status', 'claim', 'revision']);
    });

    await t.test('missing and invalid persisted receipts reject without storing records', () => {
      assert.deepEqual(result.regressions.receipts.missing, {
        attempts: 1,
        rejected: true,
        error: 'receipt_not_found',
        storedRecords: 0,
      });
      assert.deepEqual(result.regressions.receipts.invalidPersisted, {
        attempts: 1,
        rejected: true,
        error: 'receipt_invalid',
        storedRecords: 0,
      });
      assert.equal(result.summary.apiCallsRejected, 2);
    });

    await t.test('duplicate observations append two records and establish no effect idempotency', () => {
      const duplicate = result.regressions.duplicateObservations;
      assert.equal(duplicate.calls, 2);
      assert.equal(duplicate.storedRecords, 2);
      assert.equal(duplicate.deduplicated, false);
      assert.equal(duplicate.effectIdempotencyEstablished, false);
      assert.equal(duplicate.outcomeIdsDistinct, true);
      assert.notEqual(duplicate.records[0].record.outcomeId, duplicate.records[1].record.outcomeId);
      assert.equal(duplicate.records[0].record.observedOutcome, 'unknown');
      assert.equal(duplicate.records[1].record.observedOutcome, 'unknown');
    });

    await t.test('private temporary state is removed and only the compact receipt remains', async () => {
      assert.deepEqual(result.cleanup, {temporaryStateRemoved: true, retainedReceiptOnly: true});
      assert.deepEqual(await readdir(root), ['receipt.json']);
      assert.equal(((await stat(receiptPath)).mode & 0o777).toString(8), '600');
      assert.deepEqual(JSON.parse(await readFile(receiptPath, 'utf8')), result);
    });

    await t.test('receipt output refuses overwrite before running another experiment', async () => {
      await assert.rejects(() => runExperiment({receiptPath}), /receipt_exists/);
      assert.deepEqual(await readdir(root), ['receipt.json']);
    });
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test('pre-existing receipt path is rejected without replacing its contents', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jev-explicit-outcomes-overwrite-'));
  const receiptPath = join(root, 'receipt.json');
  try {
    await writeFile(receiptPath, 'preserve-me\n', {mode: 0o600});
    await assert.rejects(() => runExperiment({receiptPath}), /receipt_exists/);
    assert.equal(await readFile(receiptPath, 'utf8'), 'preserve-me\n');
    assert.deepEqual(await readdir(root), ['receipt.json']);
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});
