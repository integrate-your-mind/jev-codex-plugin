import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {mkdtemp, readFile, rm, stat} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import test, {after, before} from 'node:test';

import {buildSchedule, hash, validateTruthBoundary} from './freeze.mjs';
import {gradeRecords, validateCompleteRecords} from './grader.mjs';

const execFileAsync = promisify(execFile);
const dir = dirname(fileURLToPath(import.meta.url));
const repo = join(dir, '..', '..', '..');
const node22 = '/Users/romanmondello/.nvm/versions/node/v22.23.2/bin/node';
const runner = join(dir, 'run.mjs');
const source = join(repo, 'source/jev-workflows');
let temp;
let validPath;
let malformedPath;
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
  temp = await mkdtemp(join(process.env.TMPDIR ?? dir, 'jev-batch-test-'));
  validPath = join(temp, 'valid.jsonl');
  malformedPath = join(temp, 'malformed.jsonl');
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
