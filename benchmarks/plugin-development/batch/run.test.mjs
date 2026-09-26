import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {mkdtemp, readFile, rm, stat} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import test, {after, before} from 'node:test';

import {buildSchedule, hash, validateTruthBoundary} from './freeze.mjs';
import {gradeRecords, validateCompleteRecords} from './grader.mjs';
import {mergeUsage} from './run.mjs';

const execFileAsync = promisify(execFile);
const dir = dirname(fileURLToPath(import.meta.url));
const repo = join(dir, '..', '..', '..');
const node22 = process.env.NODE22_BIN ?? process.execPath;
const runner = join(dir, 'run.mjs');
const source = join(repo, 'source/jev-workflows');
let temp;
let validPath;
let malformedPath;
let unavailablePath;
let mixedPath;
let serviceErrorPath;
let inputs;
let oracle;
let schedule;
let validRecords;

async function invoke(args, env = process.env) {
  try {
    const result = await execFileAsync(node22, [runner, ...args], {env, maxBuffer: 8 * 1024 * 1024});
    return {exitCode: 0, ...result};
  } catch (error) {
    return {exitCode: typeof error.code === 'number' ? error.code : 255, stdout: error.stdout ?? '', stderr: error.stderr ?? ''};
  }
}

async function readJsonl(path) {
  return (await readFile(path, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
}

before(async () => {
  const version = await execFileAsync(node22, ['--version']);
  assert.equal(version.stdout.trim(), 'v22.23.2', 'Set NODE22_BIN to Node v22.23.2');
  temp = await mkdtemp(join(process.env.TMPDIR ?? dir, 'jev-batch-test-'));
  validPath = join(temp, 'valid.jsonl');
  malformedPath = join(temp, 'malformed.jsonl');
  unavailablePath = join(temp, 'unavailable.jsonl');
  mixedPath = join(temp, 'mixed.jsonl');
  serviceErrorPath = join(temp, 'service-error.jsonl');
  [inputs, oracle, schedule] = await Promise.all([
    readFile(join(dir, 'inputs.json'), 'utf8').then(JSON.parse),
    readFile(join(dir, 'oracle/oracle.json'), 'utf8').then(JSON.parse),
    readFile(join(dir, 'schedule.json'), 'utf8').then(JSON.parse),
  ]);
  const result = await invoke(['--source', source, '--out', validPath]);
  assert.equal(result.exitCode, 0, result.stderr);
  validRecords = await readJsonl(validPath);
});

after(async () => {
  if (temp) await rm(temp, {recursive: true, force: true});
});

test('freeze enforces four clusters, typed questions, truth isolation, and counterbalanced denominators', () => {
  validateTruthBoundary(inputs, oracle);
  assert.deepEqual(buildSchedule(inputs), schedule);
  assert.equal(schedule.attempts.length, 16);
  assert.equal(schedule.attempts.filter(attempt => attempt.arm === 'serial').reduce((sum, attempt) => sum + attempt.expectedProviderRequests, 0), 24);
  assert.equal(schedule.attempts.filter(attempt => attempt.arm === 'batch').reduce((sum, attempt) => sum + attempt.expectedProviderRequests, 0), 8);
  const leaked = structuredClone(inputs);
  leaked.cases[0].expectedChoice = 'apply_targeted_fix';
  assert.throws(() => validateTruthBoundary(leaked, oracle), /truth-shaped key/);
  const marked = structuredClone(inputs);
  marked.cases[0].state.note = oracle.oracleMarker;
  assert.throws(() => validateTruthBoundary(marked, oracle), /oracle marker/);
});

test('dry run uses identical state/questions/policy and exact serial versus batch request denominators', () => {
  const {header, finished} = validateCompleteRecords(validRecords, schedule);
  assert.equal(header.mode, 'dry-synthetic');
  assert.equal(header.externalProviderCalls, false);
  assert.equal(header.truthPassedToProvider, false);
  assert.equal(header.runtime.node, 'v22.23.2');
  const providerStarts = validRecords.filter(record => record.kind === 'provider_request_started');
  assert.equal(providerStarts.length, 32);
  assert.equal(finished.filter(record => record.arm === 'serial').reduce((sum, record) => sum + record.accounting.providerRequestsStarted, 0), 24);
  assert.equal(finished.filter(record => record.arm === 'batch').reduce((sum, record) => sum + record.accounting.providerRequestsStarted, 0), 8);
  assert.ok(providerStarts.every(record => !JSON.stringify(record.payload).includes(oracle.oracleMarker)));
  assert.ok(providerStarts.every(record => !/"(?:expected|oracle|truth|correctChoice)"\s*:/i.test(JSON.stringify(record.payload))));

  for (const fixture of inputs.cases) for (let repeat = 1; repeat <= 2; repeat += 1) {
    const serial = finished.find(record => record.caseId === fixture.id && record.repeat === repeat && record.arm === 'serial');
    const batch = finished.find(record => record.caseId === fixture.id && record.repeat === repeat && record.arm === 'batch');
    assert.equal(serial.inputProjectionSha256, batch.inputProjectionSha256);
    assert.deepEqual(serial.inputPolicy, batch.inputPolicy);
    assert.equal(serial.providerRequests.length, 3);
    assert.equal(batch.providerRequests.length, 1);
    assert.deepEqual(serial.providerRequests.map(request => request.payload.state), [fixture.state, fixture.state, fixture.state]);
    assert.deepEqual(batch.providerRequests[0].payload.state, fixture.state);
    assert.deepEqual(Object.assign({}, ...serial.providerRequests.map(request => request.payload.questions)), batch.providerRequests[0].payload.questions);
  }
  assert.ok(finished.every(record => record.operationDurationMs >= 0));
  assert.ok(finished.every(record => record.accounting.retriesConfigured === 0 && record.accounting.retriesObserved === 0));
  assert.ok(finished.every(record => record.accounting.receiptIdsPresent === record.accounting.persistedReceipts));
  assert.ok(finished.every(record => record.providerRequests.every(request => Number.isFinite(request.requestLatencyMs))));
});

test('code grader rejects missing attempts instead of shrinking the denominator', () => {
  const missing = validRecords.filter(record => !(record.kind === 'attempt_finished' && record.attemptId === schedule.attempts[0].attemptId));
  assert.throws(() => validateCompleteRecords(missing, schedule), /missing or extra attempt_finished/);
  const grade = gradeRecords(validRecords, schedule, oracle);
  assert.equal(grade.plannedAttempts, 16);
  assert.match(grade.claimBoundary, /cannot establish automatic Codex behavior/);
  assert.match(grade.rangeSemantics, /authored code-grading criteria/);
  assert.match(grade.rangeSemantics, /not empirically or locally calibrated/);
  assert.ok(grade.attemptGrades.every(record => record.actualActionExecuted === null && record.actualHarmfulAction === null));
  assert.ok(grade.attemptGrades.every(record => Object.values(record.questionGrades)
    .filter(question => question.rangeKind)
    .every(question => question.rangeKind === 'authored_not_calibrated' && question.calibration === 'not_calibrated')));
  const normal = grade.attemptGrades.filter(record => record.caseId === 'normal-targeted-repair');
  assert.ok(normal.every(record => record.rawProviderChoiceOracleCorrect && record.policyDispositionCorrect && record.deliveredRecommendationCorrect));
  const conflicting = grade.attemptGrades.filter(record => record.caseId === 'conflicting-observations');
  assert.ok(conflicting.every(record => !record.rawProviderChoiceOracleCorrect && !record.policyDispositionCorrect && !record.deliveredRecommendationCorrect));
  const rawHarm = grade.attemptGrades.filter(record => record.harmfulRawProviderChoice);
  const recommendationHarm = grade.attemptGrades.filter(record => record.harmfulActionableRecommendation);
  assert.equal(rawHarm.length, 8);
  assert.equal(recommendationHarm.length, 8);
  for (const arm of ['serial', 'batch']) {
    assert.equal(grade.byArm[arm].actualHarmfulActions, null);
    assert.equal(grade.byArm[arm].independentlyVerifiedTaskActionBenefits, null);
    assert.equal(Object.hasOwn(grade.byArm[arm], 'independentlyCorrectOperations'), false);
    assert.equal(Object.hasOwn(grade.byArm[arm], 'harmfulOperations'), false);
  }

  const lowConfidenceRawHarm = structuredClone(validRecords);
  const stale = lowConfidenceRawHarm.find(record => record.kind === 'attempt_finished' && record.caseId === 'stale-receipt-after-change');
  stale.answers.action = {
    ...stale.answers.action,
    providerChoice: 'reuse_prior_result',
    disposition: 'abstained',
    reasonCode: 'low_confidence',
  };
  delete stale.answers.action.recommendation;
  const separated = gradeRecords(lowConfidenceRawHarm, schedule, oracle).attemptGrades.find(record => record.attemptId === stale.attemptId);
  assert.equal(separated.harmfulRawProviderChoice, true);
  assert.equal(separated.harmfulActionableRecommendation, false);
  assert.equal(separated.actualHarmfulAction, null);
});

test('malformed provider responses remain unavailable with no retry or hidden rerun', async () => {
  const result = await invoke(['--source', source, '--out', malformedPath, '--synthetic', 'malformed']);
  assert.equal(result.exitCode, 0, result.stderr);
  const records = await readJsonl(malformedPath);
  const {finished} = validateCompleteRecords(records, schedule);
  assert.equal(records.filter(record => record.kind === 'provider_request_started').length, 32);
  assert.ok(finished.every(record => record.accounting.validatedResponses === 0));
  assert.ok(finished.every(record => record.accounting.retriesObserved === 0));
  assert.ok(finished.every(record => record.serviceResults.every(serviceResult => serviceResult.status === 'unavailable' && serviceResult.reasonCode === 'invalid_response')));
  assert.ok(finished.every(record => record.serviceResults.every(serviceResult => serviceResult.transport.validatedResponse === false)));
});

test('local unavailability is graded with frozen denominators and no invented fetch or usage', async () => {
  const result = await invoke(['--source', source, '--out', unavailablePath, '--synthetic', 'unavailable']);
  assert.equal(result.exitCode, 0, result.stderr);
  const records = await readJsonl(unavailablePath);
  const {finished} = validateCompleteRecords(records, schedule);
  assert.equal(records.filter(record => record.kind === 'provider_request_started').length, 0);
  assert.equal(records.filter(record => record.kind === 'service_request_completed').length, 32);
  assert.ok(finished.every(record => record.harnessStatus === 'completed'));
  assert.ok(finished.every(record => record.usage === null));
  assert.ok(finished.every(record => record.serviceResults.every(serviceResult => serviceResult.status === 'unavailable' && serviceResult.reasonCode === 'missing_api_key')));
  const grade = gradeRecords(records, schedule, oracle);
  assert.deepEqual({
    serial: {
      planned: grade.byArm.serial.plannedProviderRequests,
      actual: grade.byArm.serial.providerRequests,
      missing: grade.byArm.serial.missingProviderRequests,
      completed: grade.byArm.serial.serviceRequestsCompleted,
      unknown: grade.byArm.serial.unknownServiceRequestOutcomes,
      unavailableWithoutFetch: grade.byArm.serial.unavailableWithoutFetch,
      usage: grade.byArm.serial.totalUsage,
    },
    batch: {
      planned: grade.byArm.batch.plannedProviderRequests,
      actual: grade.byArm.batch.providerRequests,
      missing: grade.byArm.batch.missingProviderRequests,
      completed: grade.byArm.batch.serviceRequestsCompleted,
      unknown: grade.byArm.batch.unknownServiceRequestOutcomes,
      unavailableWithoutFetch: grade.byArm.batch.unavailableWithoutFetch,
      usage: grade.byArm.batch.totalUsage,
    },
  }, {
    serial: {planned: 24, actual: 0, missing: 24, completed: 24, unknown: 0, unavailableWithoutFetch: 24, usage: null},
    batch: {planned: 8, actual: 0, missing: 8, completed: 8, unknown: 0, unavailableWithoutFetch: 8, usage: null},
  });
});

test('request groups retain frozen ordinals when an early local result makes no fetch', async () => {
  const result = await invoke(['--source', source, '--out', mixedPath, '--synthetic', 'mixed']);
  assert.equal(result.exitCode, 0, result.stderr);
  const records = await readJsonl(mixedPath);
  const {finished} = validateCompleteRecords(records, schedule);
  for (const record of finished.filter(record => record.arm === 'serial')) {
    assert.deepEqual(record.serviceResults.map(serviceResult => serviceResult.requestOrdinal), [1, 2, 3]);
    assert.equal(record.serviceResults[0].status, 'unavailable');
    assert.equal(record.serviceResults[0].reasonCode, 'budget_store_unavailable');
    assert.deepEqual(record.providerRequests.map(request => request.requestOrdinal), [2, 3]);
    assert.deepEqual(record.providerRequests.map(request => request.requestGroupId), [
      `${record.attemptId}.request-2`,
      `${record.attemptId}.request-3`,
    ]);
  }
  for (const record of finished.filter(record => record.arm === 'batch')) {
    assert.deepEqual(record.serviceResults.map(serviceResult => serviceResult.requestOrdinal), [1]);
    assert.equal(record.serviceResults[0].status, 'unavailable');
    assert.equal(record.providerRequests.length, 0);
  }
  const grade = gradeRecords(records, schedule, oracle);
  assert.equal(grade.byArm.serial.plannedProviderRequests, 24);
  assert.equal(grade.byArm.serial.providerRequests, 16);
  assert.equal(grade.byArm.serial.missingProviderRequests, 8);
  assert.equal(grade.byArm.batch.plannedProviderRequests, 8);
  assert.equal(grade.byArm.batch.providerRequests, 0);
  assert.equal(grade.byArm.batch.missingProviderRequests, 8);
});

test('grader rejects frozen identity or header-order tampering and represents pre-completion errors', () => {
  const wrongArm = structuredClone(validRecords);
  wrongArm.find(record => record.kind === 'attempt_finished').arm = 'batch';
  assert.throws(() => validateCompleteRecords(wrongArm, schedule), /arm differs from frozen schedule/);

  const headerMoved = structuredClone(validRecords);
  [headerMoved[0], headerMoved[1]] = [headerMoved[1], headerMoved[0]];
  assert.throws(() => validateCompleteRecords(headerMoved, schedule), /header must be the first record/);

  const errored = structuredClone(validRecords.filter(record => record.kind !== 'summary'));
  const attempt = schedule.attempts[0];
  const completionIndex = errored.findIndex(record => record.kind === 'service_request_completed' && record.attemptId === attempt.attemptId && record.requestOrdinal === attempt.expectedProviderRequests);
  assert.notEqual(completionIndex, -1);
  errored.splice(completionIndex, 1);
  const finished = errored.find(record => record.kind === 'attempt_finished' && record.attemptId === attempt.attemptId);
  finished.harnessStatus = 'error';
  finished.harnessError = {name: 'Error', message: 'synthetic pre-completion failure'};
  finished.serviceResults = finished.serviceResults.filter(result => result.requestOrdinal !== attempt.expectedProviderRequests);
  finished.usage = mergeUsage(finished.serviceResults);
  validateCompleteRecords(errored, schedule);
  const grade = gradeRecords(errored, schedule, oracle);
  assert.equal(grade.byArm.serial.completedOperations, 7);
  assert.equal(grade.byArm.serial.serviceRequestsCompleted, 23);
  assert.equal(grade.byArm.serial.unknownServiceRequestOutcomes, 1);
  assert.equal(grade.attemptGrades.find(record => record.attemptId === attempt.attemptId).complete, false);
});

test('runner records and grades service exceptions before completion without inventing observations', async () => {
  const result = await invoke(['--source', source, '--out', serviceErrorPath, '--synthetic', 'service-error']);
  assert.equal(result.exitCode, 0, result.stderr);
  const records = await readJsonl(serviceErrorPath);
  const {finished} = validateCompleteRecords(records, schedule);
  assert.equal(records.filter(record => record.kind === 'provider_request_started').length, 0);
  assert.equal(records.filter(record => record.kind === 'service_request_completed').length, 0);
  assert.ok(finished.every(record => record.harnessStatus === 'error'));
  assert.ok(finished.every(record => record.harnessError?.message === 'synthetic service exception before completion'));
  assert.ok(finished.every(record => record.serviceResults.length === 0 && record.usage === null));
  const grade = gradeRecords(records, schedule, oracle);
  assert.equal(grade.byArm.serial.completedOperations, 0);
  assert.equal(grade.byArm.serial.unknownServiceRequestOutcomes, 24);
  assert.equal(grade.byArm.batch.completedOperations, 0);
  assert.equal(grade.byArm.batch.unknownServiceRequestOutcomes, 8);
  assert.ok(grade.attemptGrades.every(record => record.complete === false));
});

test('empty and partially unavailable usage remains unknown', () => {
  assert.equal(mergeUsage([]), null);
  assert.equal(mergeUsage([{usage: null}]), null);
  assert.deepEqual(mergeUsage([{usage: {input_tokens: 2, output_tokens: 3}}]), {input_tokens: 2, output_tokens: 3});
});

test('output creation is exclusive and the live gate fails before provider access', async () => {
  const before = hash(await readFile(validPath));
  const duplicate = await invoke(['--source', source, '--out', validPath]);
  assert.notEqual(duplicate.exitCode, 0);
  assert.equal(hash(await readFile(validPath)), before);

  const livePath = join(temp, 'blocked-live.jsonl');
  const env = {...process.env};
  delete env.JEV_RUN_LIVE_BATCH_BENCHMARK;
  delete env.JEV_API_KEY_FILE;
  delete env.TYPESAFE_API_KEY;
  const blocked = await invoke(['--source', source, '--out', livePath, '--live', '--reviewed-freeze-sha', '0'.repeat(64)], env);
  assert.notEqual(blocked.exitCode, 0);
  await assert.rejects(stat(livePath), {code: 'ENOENT'});
});
