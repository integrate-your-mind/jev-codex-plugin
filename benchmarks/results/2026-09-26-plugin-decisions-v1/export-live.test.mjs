import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {exportDecisionResults} from './export-live.mjs';

const hashJson = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const hashBytes = (value) => createHash('sha256').update(value).digest('hex');

function fixture() {
  const oracle = {schemaVersion: 'synthetic-oracle-v1', episodes: [
    {episodeId: 'e-assessed', expectedDisposition: 'assessed', expectedChoice: 'candidate_a'},
    {episodeId: 'e-abstain', expectedDisposition: 'abstained', expectedChoice: null},
  ]};
  const sourceRecords = [
    {arm: 'baseline', sourceRoot: '/private/source', entrypoint: 'src/decision-hook.ts', gitCommit: 'abc', sourceSha256: 'a'.repeat(64), entrypointSha256: 'b'.repeat(64), fileCount: 2},
    {arm: 'repair', sourceRoot: '/private/repair', entrypoint: 'src/decision-hook.ts', gitCommit: 'def', sourceSha256: 'c'.repeat(64), entrypointSha256: 'd'.repeat(64), fileCount: 2},
  ];
  const header = {kind: 'header', schemaVersion: 'plugin-live-eval-run-v2', plannedAttempts: 2, runtime: {node: 'v22.23.2', platform: 'darwin', arch: 'arm64', execPath: '/private/node'}, sourceRecords, fixtureSha256: 'e'.repeat(64), oracleSha256: hashJson(oracle)};
  const started = (attemptId, episodeId, arm) => ({kind: 'attempt_started', attemptId, episodeId, family: 'synthetic', repeat: 1, arm, sourceSha256: sourceRecords.find((source) => source.arm === arm).sourceSha256});
  const finished = (attemptId, episodeId, arm, assessed) => ({
    kind: 'attempt_finished', attemptId, episodeId, family: 'synthetic', repeat: 1, arm, sourceSha256: sourceRecords.find((source) => source.arm === arm).sourceSha256, status: 'completed',
    validatedProviderChoice: assessed ? 'candidate_a' : 'insufficient_evidence', validatedConfidence: 0.9, validatedProbabilities: {candidate_a: assessed ? 1 : 0, insufficient_evidence: assessed ? 0 : 1},
    modelVisibleDecision: {status: assessed ? 'assessed' : 'abstained', choice: assessed ? 'candidate_a' : null, receiptId: 'local-secret-receipt', latencyMs: 11},
    delivered: {status: assessed ? 'assessed' : 'abstained', decision: assessed ? (arm === 'repair' ? 'candidate_a' : null) : null},
    receiptParity: true, transportAttempts: 1, outgoingPayloadBytes: 123, outgoingPayloadDigest: 'f'.repeat(64), latencyMs: 14,
    receipt: {receiptId: `local-${attemptId}`, persisted: true, providerRequestIdPresent: true, usage: {input_tokens: 10, output_tokens: 2}, responseStatus: 200, validatedResponse: true},
    modelVisibleInput: {privatePath: '/private/workspace', payload: {secret: 'never-export'}},
  });
  return {oracle, rows: [header, started('e-assessed.r1.baseline', 'e-assessed', 'baseline'), finished('e-assessed.r1.baseline', 'e-assessed', 'baseline', true), started('e-abstain.r1.repair', 'e-abstain', 'repair'), finished('e-abstain.r1.repair', 'e-abstain', 'repair', false)]};
}

async function writeFixture(root, rows, oracle) {
  const input = join(root, 'private.jsonl');
  await writeFile(input, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, {mode: 0o600});
  const oraclePath = join(root, 'oracle.json');
  await writeFile(oraclePath, `${JSON.stringify(oracle)}\n`, {mode: 0o600});
  return {inputPath: input, oraclePath};
}

test('exports only the allowlisted receipt and decision fields', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jev-decision-export-'));
  try {
    const fixtureData = fixture();
    const paths = await writeFixture(root, fixtureData.rows, fixtureData.oracle);
    const summaryPath = join(root, 'summary.json');
    const trialsPath = join(root, 'trials.json');
    const result = await exportDecisionResults({...paths, summaryPath, trialsPath});
    assert.equal(result.summary.plannedAttempts, 2);
    assert.equal(result.summary.finishedAttempts, 2);
    assert.equal(result.summary.arms.baseline.providerDecisionCorrect, 1);
    assert.equal(result.summary.arms.repair.providerDecisionCorrect, 1);
    assert.equal(result.summary.arms.baseline.concreteChoicesDelivered, 0);
    assert.equal(result.summary.arms.repair.concreteChoicesDelivered, 0);
    assert.equal(result.trials[0].providerRequestIdPresent, true);
    assert.equal(result.trials[0].receiptPersisted, true);
    assert.equal(result.trials[0].providerChoice, 'candidate_a');
    const publicText = `${await readFile(summaryPath, 'utf8')}\n${await readFile(trialsPath, 'utf8')}`;
    assert.equal(publicText.includes('local-secret-receipt'), false);
    assert.equal(publicText.includes('/private/'), false);
    assert.equal(publicText.includes('never-export'), false);
    assert.equal(publicText.includes('providerRequestId"'), false);
    await assert.rejects(exportDecisionResults({...paths, summaryPath, trialsPath}), /EEXIST/);
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test('rejects incomplete attempts and missing receipt provenance', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jev-decision-export-invalid-'));
  try {
    const fixtureData = fixture();
    const paths = await writeFixture(root, fixtureData.rows.slice(0, 2), fixtureData.oracle);
    await assert.rejects(exportDecisionResults({...paths, summaryPath: join(root, 'summary.json'), trialsPath: join(root, 'trials.json')}), /attempted count/);
    const complete = fixture();
    complete.rows[4].receipt.receiptId = null;
    const invalid = await writeFixture(root, complete.rows, complete.oracle);
    await assert.rejects(exportDecisionResults({...invalid, summaryPath: join(root, 'summary2.json'), trialsPath: join(root, 'trials2.json')}), /persisted receipt lacks local receipt ID/);
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test('rejects duplicate headers, identity drift, unknown oracle IDs, and unsafe numeric fields', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jev-decision-export-shape-'));
  try {
    const duplicate = fixture();
    duplicate.rows.push(duplicate.rows[0]);
    const duplicatePaths = await writeFixture(root, duplicate.rows, duplicate.oracle);
    await assert.rejects(exportDecisionResults({...duplicatePaths, summaryPath: join(root, 'duplicate-summary.json'), trialsPath: join(root, 'duplicate-trials.json')}), /exactly one header/);

    const drift = fixture();
    drift.rows[2].sourceSha256 = '9'.repeat(64);
    const driftPaths = await writeFixture(root, drift.rows, drift.oracle);
    await assert.rejects(exportDecisionResults({...driftPaths, summaryPath: join(root, 'drift-summary.json'), trialsPath: join(root, 'drift-trials.json')}), /finished source hash mismatch/);

    const unknown = fixture();
    unknown.rows[1].episodeId = 'unknown-episode';
    unknown.rows[2].episodeId = 'unknown-episode';
    const unknownPaths = await writeFixture(root, unknown.rows, unknown.oracle);
    await assert.rejects(exportDecisionResults({...unknownPaths, summaryPath: join(root, 'unknown-summary.json'), trialsPath: join(root, 'unknown-trials.json')}), /unknown oracle episode/);

    const unsafe = fixture();
    unsafe.rows[2].validatedConfidence = 1.1;
    const unsafePaths = await writeFixture(root, unsafe.rows, unsafe.oracle);
    await assert.rejects(exportDecisionResults({...unsafePaths, summaryPath: join(root, 'unsafe-summary.json'), trialsPath: join(root, 'unsafe-trials.json')}), /confidence must be a finite number/);

    const badProbability = fixture();
    badProbability.rows[2].validatedProbabilities = {'candidate/value': 1};
    const probabilityPaths = await writeFixture(root, badProbability.rows, badProbability.oracle);
    await assert.rejects(exportDecisionResults({...probabilityPaths, summaryPath: join(root, 'probability-summary.json'), trialsPath: join(root, 'probability-trials.json')}), /safe candidate ID/);

    const badDigest = fixture();
    badDigest.rows[2].outgoingPayloadDigest = 'short';
    const digestPaths = await writeFixture(root, badDigest.rows, badDigest.oracle);
    await assert.rejects(exportDecisionResults({...digestPaths, summaryPath: join(root, 'digest-summary.json'), trialsPath: join(root, 'digest-trials.json')}), /lowercase SHA-256/);
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test('preserves a completed attempt with an invalid provider response as completed accounting', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jev-decision-export-provider-'));
  try {
    const degraded = fixture();
    degraded.rows[2].receipt.responseStatus = null;
    degraded.rows[2].receipt.validatedResponse = false;
    degraded.rows[2].receiptParity = false;
    const paths = await writeFixture(root, degraded.rows, degraded.oracle);
    const result = await exportDecisionResults({...paths, summaryPath: join(root, 'summary.json'), trialsPath: join(root, 'trials.json')});
    const trial = result.trials.find((row) => row.episodeId === 'e-assessed');
    assert.equal(trial.status, 'completed');
    assert.equal(trial.httpStatus, null);
    assert.equal(trial.validatedResponse, false);
    assert.equal(trial.receiptParity, false);
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test('accepts unavailable provider statuses, charged error rows, and unknown transport counts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jev-decision-export-unavailable-'));
  try {
    const degraded = fixture();
    degraded.rows[2].modelVisibleDecision.status = 'invalid_response';
    degraded.rows[2].receipt.responseStatus = 502;
    degraded.rows[2].receipt.validatedResponse = false;
    degraded.rows[2].receiptParity = false;
    degraded.rows[2].transportAttempts = null;
    degraded.rows[4].status = 'error';
    degraded.rows[4].modelVisibleDecision.status = 'unavailable';
    degraded.rows[4].receipt.responseStatus = 503;
    degraded.rows[4].receipt.validatedResponse = false;
    degraded.rows[4].receipt.usage = {input_tokens: 7, output_tokens: 3};
    degraded.rows[4].transportAttempts = null;
    const paths = await writeFixture(root, degraded.rows, degraded.oracle);
    const result = await exportDecisionResults({...paths, summaryPath: join(root, 'summary.json'), trialsPath: join(root, 'trials.json')});
    const baseline = result.trials.find((row) => row.arm === 'baseline');
    const repair = result.trials.find((row) => row.arm === 'repair');
    assert.equal(baseline.providerStatus, 'invalid_response');
    assert.equal(baseline.transportAttempts, null);
    assert.equal(repair.status, 'error');
    assert.equal(repair.providerStatus, 'unavailable');
    assert.equal(result.summary.arms.baseline.inputTokens, 10);
    assert.equal(result.summary.arms.repair.inputTokens, 7);
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test('requires header first and started rows before finished rows', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jev-decision-export-order-'));
  try {
    const data = fixture();
    const headerLate = {...data, rows: [...data.rows.slice(1), data.rows[0]]};
    const latePaths = await writeFixture(root, headerLate.rows, headerLate.oracle);
    await assert.rejects(exportDecisionResults({...latePaths, summaryPath: join(root, 'late-summary.json'), trialsPath: join(root, 'late-trials.json')}), /header must precede/);
    const finishEarly = fixture();
    finishEarly.rows.splice(1, 0, finishEarly.rows.splice(2, 1)[0]);
    const earlyPaths = await writeFixture(root, finishEarly.rows, finishEarly.oracle);
    await assert.rejects(exportDecisionResults({...earlyPaths, summaryPath: join(root, 'early-summary.json'), trialsPath: join(root, 'early-trials.json')}), /precedes started/);
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});
