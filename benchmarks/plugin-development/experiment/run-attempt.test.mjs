import assert from 'node:assert/strict';
import {mkdtemp, readFile, readdir, rm, stat, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {after, before, test} from 'node:test';

import {cleanupCase} from '../cases/fixture-engine.mjs';
import {parseDeliveredAssessment, runAttempt} from './run-attempt.mjs';
import {EXPECTED_PROVIDER_MODEL, loadVariantModules} from './source-integrity.mjs';
import {deterministicTransport} from './synthetic-transport.mjs';

let candidateRuntime;
let controlRuntime;
const ownedRoots = [];

before(async () => {
  [candidateRuntime, controlRuntime] = await Promise.all([
    loadVariantModules('candidate-bundled-repair'),
    loadVariantModules('control-released'),
  ]);
});

after(async () => {
  await Promise.all([
    candidateRuntime?.cleanup(),
    controlRuntime?.cleanup(),
    ...ownedRoots.map(root => rm(root, {recursive: true, force: true})),
  ]);
});

async function outputRoot() {
  const root = await mkdtemp(join(tmpdir(), 'jev-attempt-test-'));
  ownedRoots.push(root);
  return root;
}

function row(name, arm = 'candidate-bundled-repair', caseId = 'candidate-normal') {
  return {row: 1, attemptId: `${caseId}.${name}.${arm}`, caseId, repeat: 1, arm};
}

async function candidateAttempt(name, caseId, transport) {
  return runAttempt({
    row: row(name, 'candidate-bundled-repair', caseId),
    outputRoot: await outputRoot(),
    runDecisionHook: candidateRuntime.runDecisionHook,
    configurePolicy: candidateRuntime.configurePolicy,
    fetchFn: transport,
    transportKind: 'deterministic-local-response',
    expectedProviderModel: EXPECTED_PROVIDER_MODEL,
    offline: true,
  });
}

test('normal live-shape transport preserves exact request/receipts and verifies the real action', async () => {
  const attempt = await candidateAttempt('normal', 'candidate-normal', deterministicTransport({caseId: 'candidate-normal'}));
  const result = attempt.result;
  assert.equal(result.hookCalls, 1);
  assert.equal(result.stages.request.status, 'sent');
  assert.equal(result.stages.request.count, 1);
  assert.ok(Number.isFinite(result.stages.request.requestElapsedMs));
  assert.ok(result.stages.request.requestElapsedMs >= 0);
  assert.equal(result.stages.validatedResponse.status, 'validated');
  assert.equal(result.stages.validatedResponse.modelVersionStatus, 'matches');
  assert.equal(result.stages.validatedResponse.receiptPersisted, true);
  assert.equal(result.pluginEvidence.serviceReceipts.length, 1);
  assert.equal(result.pluginEvidence.invocationReceipts.length, 1);
  assert.equal(result.providerRequests[0].providerRequestId, null);
  assert.equal(result.providerRequests[0].transportKind, 'deterministic-local-response');
  assert.equal(result.providerRequests[0].requestBody.includes('passingAction'), false);
  assert.equal(result.providerRequests[0].requestBody.includes('postconditions'), false);
  assert.equal(result.stages.delivery.status, 'delivered');
  assert.equal(result.stages.delivery.candidateId, 'run-focused-test');
  assert.equal(result.stages.action.status, 'completed');
  assert.ok(result.stages.action.workspaceAfter['artifacts/test-result.json']);
  assert.equal(result.stages.postcondition.status, 'passed');
  assert.equal(result.stages.postcondition.oracle, 'independent-authored-fixture-engine');
  assert.ok(Number.isFinite(result.operationElapsedMs));
  assert.ok(result.operationElapsedMs >= result.stages.request.requestElapsedMs);
  assert.ok(attempt.completion.completeOperationElapsedMs >= result.operationElapsedMs);

  assert.equal((await stat(join(attempt.resultPath, '..'))).mode & 0o777, 0o700);
  for (const path of [attempt.reservationPath, attempt.journalPath, attempt.resultPath, attempt.completionPath]) {
    assert.equal((await stat(path)).mode & 0o777, 0o600);
  }
});

test('provider model drift is explicit and retains the actual response without action', async () => {
  const attempt = await candidateAttempt('model-drift', 'candidate-normal', deterministicTransport({
    caseId: 'candidate-normal', responseModel: 'jev-unreviewed-drift',
  }));
  assert.equal(attempt.result.stages.validatedResponse.status, 'model_drift');
  assert.equal(attempt.result.stages.validatedResponse.expectedProviderModel, EXPECTED_PROVIDER_MODEL);
  assert.equal(attempt.result.stages.validatedResponse.actualResponseModel, 'jev-unreviewed-drift');
  assert.equal(attempt.result.stages.validatedResponse.modelDrift, true);
  assert.match(attempt.result.providerRequests[0].responseBody, /jev-unreviewed-drift/);
  assert.equal(attempt.result.stages.delivery.status, 'not_delivered');
  assert.equal(attempt.result.stages.action.status, 'not_attempted');
});

test('caller state-directory overrides cannot redirect experiment writes', async () => {
  const foreignState = await outputRoot();
  await writeFile(join(foreignState, 'sentinel.txt'), 'preserve caller state\n');
  const attempt = await runAttempt({
    row: row('isolated-state'),
    outputRoot: await outputRoot(),
    runDecisionHook: candidateRuntime.runDecisionHook,
    configurePolicy: candidateRuntime.configurePolicy,
    fetchFn: deterministicTransport({caseId: 'candidate-normal'}),
    transportKind: 'deterministic-local-response',
    environment: {JEV_STATE_DIRECTORY: foreignState, JEV_STATE_MODE: 'user', PLUGIN_DATA: foreignState},
    offline: true,
  });
  assert.equal(attempt.result.stages.postcondition.status, 'passed');
  assert.equal(attempt.result.pluginEvidence.serviceReceipts.length, 1);
  assert.deepEqual(await readdir(foreignState), ['sentinel.txt']);
  assert.equal(await readFile(join(foreignState, 'sentinel.txt'), 'utf8'), 'preserve caller state\n');
});

test('abstention performs no action and cannot inherit a passing untouched oracle state', async () => {
  const attempt = await candidateAttempt('abstention', 'candidate-conflict', deterministicTransport({
    caseId: 'candidate-conflict', scenario: 'abstention',
  }));
  assert.equal(attempt.result.stages.validatedResponse.status, 'validated');
  assert.equal(attempt.result.stages.delivery.status, 'abstained');
  assert.equal(attempt.result.stages.action.status, 'not_attempted');
  assert.equal(attempt.result.stages.postcondition.status, 'unknown');
  assert.equal(attempt.result.stages.postcondition.pass, null);
  assert.equal(attempt.result.caseProvenance.authoredSurface, 'explicit_mcp');
  assert.equal(attempt.result.caseProvenance.authoredMcpMethod, 'classify_decision');
  assert.equal(attempt.result.caseProvenance.exercisedComponent, 'runDecisionHook');
  assert.equal(attempt.result.caseProvenance.normalizedHookEvent, 'PreToolUse');
  assert.equal(attempt.result.caseProvenance.nativeMcpInvocationExercised, false);
});

test('a wrong delivered available candidate is actioned and independently fails', async () => {
  const attempt = await candidateAttempt('wrong', 'candidate-normal', deterministicTransport({
    caseId: 'candidate-normal', choice: 'read-source',
  }));
  assert.equal(attempt.result.stages.delivery.candidateId, 'read-source');
  assert.equal(attempt.result.stages.action.status, 'completed');
  assert.equal(attempt.result.stages.postcondition.status, 'failed');
  assert.ok(attempt.result.stages.postcondition.violations.some(violation => violation.code === 'missing_expected_file'));
});

test('released control cannot turn its undelivered raw assessment into an action', async () => {
  const attempt = await runAttempt({
    row: row('missing-delivery', 'control-released', 'candidate-normal'),
    outputRoot: await outputRoot(),
    runDecisionHook: controlRuntime.runDecisionHook,
    configurePolicy: controlRuntime.configurePolicy,
    fetchFn: deterministicTransport({caseId: 'candidate-normal'}),
    transportKind: 'deterministic-local-response',
    offline: true,
  });
  assert.equal(attempt.result.stages.validatedResponse.status, 'validated');
  assert.equal(attempt.result.pluginEvidence.serviceReceipts[0].parsed.status, 'assessed');
  assert.equal(attempt.result.pluginEvidence.serviceReceipts[0].parsed.choice, 'run-focused-test');
  assert.equal(attempt.result.stages.delivery.status, 'not_delivered');
  assert.equal(attempt.result.stages.delivery.reason, 'assessed_without_delivered_candidate');
  assert.equal(attempt.result.stages.action.status, 'not_attempted');
  assert.equal(attempt.result.stages.postcondition.status, 'unknown');
});

test('foreign, unavailable, and missing delivered candidates are rejected before action', () => {
  const candidates = [{id: 'available', available: true}, {id: 'unavailable', available: false}];
  assert.deepEqual(
    parseDeliveredAssessment({hookSpecificOutput: {additionalContext: 'JEV advisory: status=assessed; decision=foreign; advisory only, continue ordinary reasoning.'}}, candidates).reason,
    'foreign_candidate',
  );
  assert.deepEqual(
    parseDeliveredAssessment({hookSpecificOutput: {additionalContext: 'JEV advisory: status=assessed; decision=unavailable; advisory only, continue ordinary reasoning.'}}, candidates).reason,
    'unavailable_candidate',
  );
  assert.deepEqual(
    parseDeliveredAssessment({hookSpecificOutput: {additionalContext: 'JEV advisory: status=assessed; advisory only, continue ordinary reasoning.'}}, candidates).reason,
    'assessed_without_delivered_candidate',
  );
});

test('request evidence remains fsynced when the hook path errors', async () => {
  const root = await outputRoot();
  const attempt = await runAttempt({
    row: row('interrupted'),
    outputRoot: root,
    configurePolicy: candidateRuntime.configurePolicy,
    runDecisionHook: async (_raw, {fetchFn}) => {
      await fetchFn('https://example.invalid/provider', {
        method: 'POST',
        body: JSON.stringify({model: 'synthetic', state: {}, questions: {}}),
      });
      return {};
    },
    fetchFn: async () => { throw new Error('synthetic interrupted transport'); },
    transportKind: 'deterministic-error',
    offline: true,
  });
  assert.equal(attempt.result.harnessStatus, 'error');
  assert.equal(attempt.result.stages.request.status, 'error');
  assert.equal(attempt.result.providerRequests.length, 1);
  const journal = await readFile(attempt.journalPath, 'utf8');
  assert.match(journal, /"kind":"request_started"/);
  assert.match(journal, /"kind":"request_failed"/);
  assert.match(journal, /synthetic interrupted transport/);
});

test('an existing reservation, including an ambiguous one, is never rerun', async () => {
  const root = await outputRoot();
  const reservedRow = row('reserved');
  await writeFile(join(root, `${reservedRow.attemptId}.reservation.json`), '{}\n', {mode: 0o600});
  let hookCalls = 0;
  let policyCalls = 0;
  const attempt = await runAttempt({
    row: reservedRow,
    outputRoot: root,
    runDecisionHook: async () => { hookCalls += 1; return {}; },
    configurePolicy: async () => { policyCalls += 1; },
    fetchFn: async () => { throw new Error('must not fetch'); },
    transportKind: 'must-not-run',
    offline: true,
  });
  assert.equal(attempt.execution, 'ambiguous_started');
  assert.equal(hookCalls, 0);
  assert.equal(policyCalls, 0);
});

test('only a hash-validated completion is reusable and tampering becomes ambiguous', async () => {
  const root = await outputRoot();
  const completedRow = row('resume-validated');
  const first = await runAttempt({
    row: completedRow,
    outputRoot: root,
    runDecisionHook: candidateRuntime.runDecisionHook,
    configurePolicy: candidateRuntime.configurePolicy,
    fetchFn: deterministicTransport({caseId: 'candidate-normal'}),
    transportKind: 'deterministic-local-response',
    expectedProviderModel: EXPECTED_PROVIDER_MODEL,
    manifestSha256: 'a'.repeat(64),
    offline: true,
  });
  let hookCalls = 0;
  const second = await runAttempt({
    row: completedRow,
    outputRoot: root,
    runDecisionHook: async () => { hookCalls += 1; return {}; },
    configurePolicy: async () => { throw new Error('must not configure'); },
    fetchFn: async () => { throw new Error('must not fetch'); },
    transportKind: 'must-not-run',
    expectedProviderModel: EXPECTED_PROVIDER_MODEL,
    manifestSha256: 'a'.repeat(64),
    offline: true,
  });
  assert.equal(second.execution, 'completed_existing');
  assert.equal(second.priorEvidenceStatus, 'validated_complete');
  assert.equal(second.result.harnessStatus, 'completed_verified');
  assert.equal(hookCalls, 0);

  await writeFile(first.resultPath, `${await readFile(first.resultPath, 'utf8')} `, {mode: 0o600});
  const afterTamper = await runAttempt({
    row: completedRow,
    outputRoot: root,
    runDecisionHook: async () => { hookCalls += 1; return {}; },
    configurePolicy: async () => { throw new Error('must not configure'); },
    fetchFn: async () => { throw new Error('must not fetch'); },
    transportKind: 'must-not-run',
    expectedProviderModel: EXPECTED_PROVIDER_MODEL,
    manifestSha256: 'a'.repeat(64),
    offline: true,
  });
  assert.equal(afterTamper.execution, 'ambiguous_started');
  assert.equal(afterTamper.priorEvidenceStatus, 'integrity_failure');
  assert.match(afterTamper.priorEvidenceError.message, /hash mismatch/);
  assert.equal(hookCalls, 0);
});

test('reservation manifest mismatch stays ambiguous and is never rerun', async () => {
  const root = await outputRoot();
  const completedRow = row('manifest-mismatch');
  await runAttempt({
    row: completedRow,
    outputRoot: root,
    runDecisionHook: candidateRuntime.runDecisionHook,
    configurePolicy: candidateRuntime.configurePolicy,
    fetchFn: deterministicTransport({caseId: 'candidate-normal'}),
    transportKind: 'deterministic-local-response',
    manifestSha256: 'b'.repeat(64),
    offline: true,
  });
  let hookCalls = 0;
  const mismatch = await runAttempt({
    row: completedRow,
    outputRoot: root,
    runDecisionHook: async () => { hookCalls += 1; return {}; },
    configurePolicy: async () => { throw new Error('must not configure'); },
    fetchFn: async () => { throw new Error('must not fetch'); },
    transportKind: 'must-not-run',
    manifestSha256: 'c'.repeat(64),
    offline: true,
  });
  assert.equal(mismatch.execution, 'ambiguous_started');
  assert.match(mismatch.priorEvidenceError.message, /row or manifest identity mismatch/);
  assert.equal(hookCalls, 0);
});

test('a pre-reservation content failure creates no row reservation', async () => {
  const root = await outputRoot();
  const rejectedRow = row('pre-reservation-drift');
  let hookCalls = 0;
  await assert.rejects(() => runAttempt({
    row: rejectedRow,
    outputRoot: root,
    runDecisionHook: async () => { hookCalls += 1; return {}; },
    configurePolicy: async () => {},
    fetchFn: async () => { throw new Error('must not fetch'); },
    transportKind: 'must-not-run',
    beforeReserve: async () => { throw new Error('frozen content drift before row'); },
    offline: true,
  }), /frozen content drift before row/);
  await assert.rejects(() => stat(join(root, `${rejectedRow.attemptId}.reservation.json`)), {code: 'ENOENT'});
  assert.equal(hookCalls, 0);
});

test('cleanup failure is retained and prevents a successful harness status', async () => {
  const root = await outputRoot();
  const attempt = await runAttempt({
    row: row('cleanup-failure'),
    outputRoot: root,
    runDecisionHook: candidateRuntime.runDecisionHook,
    configurePolicy: candidateRuntime.configurePolicy,
    fetchFn: deterministicTransport({caseId: 'candidate-normal'}),
    transportKind: 'deterministic-local-response',
    expectedProviderModel: EXPECTED_PROVIDER_MODEL,
    cleanupPrepared: async prepared => {
      await cleanupCase(prepared);
      throw new Error('synthetic cleanup receipt failure');
    },
    offline: true,
  });
  assert.equal(attempt.result.stages.postcondition.status, 'passed');
  assert.equal(attempt.result.cleanup.status, 'failed');
  assert.equal(attempt.result.harnessStatus, 'error');
  assert.match(attempt.result.cleanup.error.message, /synthetic cleanup receipt failure/);
  assert.match(await readFile(attempt.journalPath, 'utf8'), /fixture_cleanup_failed/);
});
