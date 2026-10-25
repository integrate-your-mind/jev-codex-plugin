#!/usr/bin/env node
import assert from 'node:assert/strict';
import {constants} from 'node:fs';
import {mkdir, open, readFile} from 'node:fs/promises';
import {dirname, isAbsolute, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

import {buildFreeze, hash} from './freeze.mjs';
import {gradeRecords} from './grader.mjs';

const dir = dirname(fileURLToPath(import.meta.url));
const repo = resolve(dir, '..', '..', '..');
const defaultSource = join(repo, 'source/jev-workflows');
const allowedRecordKinds = new Set([
  'header',
  'attempt_started',
  'provider_request_started',
  'private_provider_response_received',
  'provider_transport_failed',
  'private_receipt_persisted',
  'service_request_completed',
  'attempt_finished',
  'summary',
]);

function parseArgs(argv = process.argv.slice(2)) {
  const config = {source: defaultSource};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!['--input', '--output', '--source'].includes(arg)) throw new Error(`unknown argument: ${arg}`);
    const value = argv[++index];
    if (!value) throw new Error(`${arg} requires a value`);
    if (['--input', '--output'].includes(arg) && !isAbsolute(value)) throw new Error(`${arg} requires an absolute path`);
    if (arg === '--input') config.input = resolve(value);
    if (arg === '--output') config.output = resolve(value);
    if (arg === '--source') config.source = resolve(value);
  }
  if (!config.input || !isAbsolute(config.input)) throw new Error('--input must be an absolute private transcript path');
  if (!config.output || !isAbsolute(config.output)) throw new Error('--output must be an absolute new file path');
  assert.notEqual(config.input, config.output, 'input and output paths must differ');
  return config;
}

function parseTranscript(bytes) {
  const text = bytes.toString('utf8');
  assert.ok(text.length > 0 && text.endsWith('\n'), 'private transcript must be non-empty newline-delimited JSON');
  const lines = text.slice(0, -1).split('\n');
  assert.ok(lines.every(line => line.length > 0), 'private transcript contains a blank record');
  const records = lines.map((line, index) => {
    try { return JSON.parse(line); }
    catch { throw new Error(`private transcript record ${index + 1} is not valid JSON`); }
  });
  for (const record of records) assert.ok(allowedRecordKinds.has(record.kind), `private transcript contains unsupported record kind: ${record.kind}`);
  return records;
}

function countOutcomes(questionGrades) {
  const counts = {correct: 0, incorrect: 0, unknown: 0};
  for (const grade of Object.values(questionGrades)) {
    if (grade.outcome === 'correct') counts.correct += 1;
    else if (grade.outcome === 'incorrect') counts.incorrect += 1;
    else counts.unknown += 1;
  }
  return counts;
}

function numericOrNull(value) {
  return Number.isFinite(value) ? value : null;
}

function sanitizeAccounting(accounting) {
  return Object.fromEntries([
    'providerRequestsStarted', 'httpResponses', 'validatedResponses', 'fetchInvoked',
    'receiptIdsPresent', 'persistedReceipts', 'providerRequestIdsPresent', 'providerVersionsPresent',
    'reservations', 'storeSaveAttempts', 'storeSaves', 'storeSaveFailures', 'retriesConfigured', 'retriesObserved',
  ].map(key => [key, Number.isFinite(accounting?.[key]) ? accounting[key] : null]));
}

function sanitizeArm(arm) {
  return Object.fromEntries([
    'plannedAttempts', 'completedOperations', 'validProviderResponses', 'plannedProviderRequests',
    'providerRequests', 'missingProviderRequests', 'serviceRequestsCompleted', 'unknownServiceRequestOutcomes',
    'unavailableWithoutFetch', 'fetchInvocations', 'httpResponses', 'providerRequestIdsPresent',
    'receiptIdsPresent', 'persistedReceipts', 'providerVersionsPresent', 'retriesObserved',
    'classifierOracleMatchedOperations', 'rawChoiceOracleMatchedOperations',
    'policyDispositionMatchedOperations', 'deliveredRecommendationMatchedOperations',
    'harmfulRawProviderChoiceOperations', 'harmfulActionableRecommendationOperations',
    'unknownOperations', 'medianOperationDurationMs', 'medianProviderRequestLatencyMs',
  ].map(key => [key, numericOrNull(arm[key])]).concat([
    ['actualHarmfulActions', null],
    ['independentlyVerifiedTaskActionBenefits', null],
    ['totalUsage', arm.totalUsage && Number.isFinite(arm.totalUsage.input_tokens) && Number.isFinite(arm.totalUsage.output_tokens)
      ? {input_tokens: arm.totalUsage.input_tokens, output_tokens: arm.totalUsage.output_tokens}
      : null],
    ['providerCostUsd', null],
  ]));
}

function sanitizeAttempt(finished, grade) {
  return {
    attemptId: grade.attemptId,
    caseId: grade.caseId,
    cluster: finished.cluster,
    repeat: grade.repeat,
    arm: grade.arm,
    complete: grade.complete,
    classifierCriteriaAllMatch: grade.classifierCriteriaAllMatch,
    rawProviderChoiceOracleCorrect: grade.rawProviderChoiceOracleCorrect,
    policyDispositionCorrect: grade.policyDispositionCorrect,
    deliveredRecommendationCorrect: grade.deliveredRecommendationCorrect,
    harmfulRawProviderChoice: grade.harmfulRawProviderChoice,
    harmfulActionableRecommendation: grade.harmfulActionableRecommendation,
    actualActionExecuted: null,
    actualHarmfulAction: null,
    independentlyVerifiedTaskActionBenefit: null,
    providerCostUsd: null,
    questionOutcomeCounts: countOutcomes(grade.questionGrades),
    accounting: sanitizeAccounting(finished.accounting),
    usage: finished.usage && Number.isFinite(finished.usage.input_tokens) && Number.isFinite(finished.usage.output_tokens)
      ? {input_tokens: finished.usage.input_tokens, output_tokens: finished.usage.output_tokens}
      : null,
    timingMs: {
      operation: numericOrNull(finished.operationDurationMs),
      benchmarkJournalPersistence: numericOrNull(finished.persistenceDurationMs),
      serviceRequests: finished.serviceRequestLatencyMs.map(numericOrNull),
      providerRequests: finished.providerRequests.map(request => numericOrNull(request.requestLatencyMs)),
    },
  };
}

function transcriptCounts(records) {
  const count = kind => records.filter(record => record.kind === kind).length;
  const finished = records.filter(record => record.kind === 'attempt_finished');
  return {
    recordCount: records.length,
    attemptsStarted: count('attempt_started'),
    attemptsFinished: finished.length,
    providerRequestsStarted: count('provider_request_started'),
    providerResponsesReceived: count('private_provider_response_received'),
    serviceRequestsCompleted: count('service_request_completed'),
    receiptsPersisted: count('private_receipt_persisted'),
    providerResponseIdsPresent: records.filter(record => record.kind === 'private_provider_response_received' && typeof record.providerRequestId === 'string' && record.providerRequestId.length > 0).length,
    receiptProviderIdsPresent: records.filter(record => record.kind === 'private_receipt_persisted' && typeof record.providerRequestId === 'string' && record.providerRequestId.length > 0).length,
    localReceiptIdsPresent: records.filter(record => record.kind === 'private_receipt_persisted' && typeof record.localReceiptId === 'string' && record.localReceiptId.length > 0).length,
    serviceProviderIdPresenceCount: finished.reduce((sum, record) => sum + (record.accounting.providerRequestIdsPresent ?? 0), 0),
    serviceReceiptIdPresenceCount: finished.reduce((sum, record) => sum + (record.accounting.receiptIdsPresent ?? 0), 0),
  };
}

async function writeExclusive(path, value) {
  const parent = dirname(path);
  await mkdir(parent, {recursive: true, mode: 0o700});
  const handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  const parentHandle = await open(parent, constants.O_RDONLY);
  try { await parentHandle.sync(); }
  finally { await parentHandle.close(); }
}

export async function exportTranscript({input, output, source = defaultSource, write = true}) {
  const [transcriptBytes, freezeBytes, exporterBytes, schedule, oracle] = await Promise.all([
    readFile(input),
    readFile(join(dir, 'freeze.json')),
    readFile(fileURLToPath(import.meta.url)),
    readFile(join(dir, 'schedule.json'), 'utf8').then(JSON.parse),
    readFile(join(dir, 'oracle/oracle.json'), 'utf8').then(JSON.parse),
  ]);
  const frozen = JSON.parse(freezeBytes);
  const freezeSha256 = hash(freezeBytes);
  const current = await buildFreeze({sourceRoot: source, write: false, enforceRuntime: false});
  assert.deepEqual(current, frozen, 'frozen harness, fixtures, schedule, selection rule, or service source changed');

  const records = parseTranscript(transcriptBytes);
  const header = records[0];
  assert.equal(header.schemaVersion, 'jev-batch-component-run-v1', 'private transcript header schema mismatch');
  assert.equal(header.freezeSha256, freezeSha256, 'private transcript freeze mismatch');
  assert.equal(header.cohort, frozen.cohort, 'private transcript cohort mismatch');
  assert.equal(header.pluginVersion, frozen.pluginVersion, 'private transcript plugin version mismatch');
  assert.equal(header.providerModel, frozen.providerModel, 'private transcript provider model mismatch');
  assert.equal(header.runtime?.node, frozen.requiredNodeVersion, 'private transcript Node version mismatch');
  assert.equal(header.truthPassedToProvider, false, 'private transcript reports truth leakage');
  assert.equal(header.rawOutputPrivate, true, 'private transcript privacy marker missing');
  assert.equal(header.noAdaptiveRetries, true, 'private transcript retry policy mismatch');
  assert.equal(header.persistenceAdapter, 'benchmark-private-jsonl-fsync-v1', 'private transcript persistence adapter mismatch');
  assert.deepEqual(header.plannedProviderRequests, frozen.plannedProviderRequests, 'private transcript planned denominator mismatch');
  if (header.mode === 'live') {
    assert.equal(header.externalProviderCalls, true, 'live transcript external-call marker mismatch');
    assert.equal(header.syntheticTransport, null, 'live transcript cannot use synthetic transport');
  } else {
    assert.equal(header.mode, 'dry-synthetic', 'private transcript mode mismatch');
    assert.equal(header.externalProviderCalls, false, 'dry transcript external-call marker mismatch');
  }

  const grade = gradeRecords(records, schedule, oracle);
  const storedSummaries = records.filter(record => record.kind === 'summary');
  assert.equal(storedSummaries.length, 1, 'private transcript must contain exactly one summary');
  assert.deepEqual(storedSummaries[0], {kind: 'summary', ...grade}, 'stored summary differs from independent re-grade');
  const finishedById = new Map(records.filter(record => record.kind === 'attempt_finished').map(record => [record.attemptId, record]));
  const attempts = grade.attemptGrades.map(attempt => sanitizeAttempt(finishedById.get(attempt.attemptId), attempt));

  const exported = {
    schemaVersion: 'jev-batch-component-sanitized-export-v1',
    provenance: {
      verified: true,
      storedSummaryVerified: true,
      freezeSha256,
      cohort: frozen.cohort,
      pluginVersion: frozen.pluginVersion,
      providerModel: frozen.providerModel,
      requiredNodeVersion: frozen.requiredNodeVersion,
      inputSha256: frozen.inputSha256,
      oracleSha256: frozen.oracleSha256,
      scheduleSha256: frozen.scheduleSha256,
      providerProjectionSha256: frozen.providerProjectionSha256,
      sourceCombinedSha256: frozen.sourceCombinedSha256,
      harnessCombinedSha256: frozen.harnessCombinedSha256,
      selectionRuleSha256: frozen.selectionRule.sha256,
      exporterSha256: hash(exporterBytes),
    },
    privateTranscript: {
      sha256: hash(transcriptBytes),
      bytes: transcriptBytes.length,
      ...transcriptCounts(records),
    },
    run: {
      mode: grade.runMode,
      syntheticTransport: grade.syntheticTransport,
      runtime: {node: header.runtime.node, platform: header.runtime.platform, arch: header.runtime.arch},
      plannedAttempts: grade.plannedAttempts,
      attempts,
    },
    summary: {
      byArm: {serial: sanitizeArm(grade.byArm.serial), batch: sanitizeArm(grade.byArm.batch)},
      providerCostUsd: null,
      actualHarmfulActions: null,
      independentlyVerifiedTaskActionBenefits: null,
      rangeSemantics: grade.rangeSemantics,
      claimBoundary: grade.claimBoundary,
    },
  };
  if (write) await writeExclusive(output, exported);
  return exported;
}

async function main() {
  const config = parseArgs();
  const exported = await exportTranscript(config);
  process.stdout.write(`${JSON.stringify({ok: true, schemaVersion: exported.schemaVersion, transcriptSha256: exported.privateTranscript.sha256, recordCount: exported.privateTranscript.recordCount, plannedAttempts: exported.run.plannedAttempts})}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { process.stderr.write(`${error?.message ?? error}\n`); process.exitCode = 1; });
}
