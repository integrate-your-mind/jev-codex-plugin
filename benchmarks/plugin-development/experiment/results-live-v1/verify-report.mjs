#!/usr/bin/env node

import {readFile, readdir} from 'node:fs/promises';
import {join, dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';

const SCHEMA = 'plugin-development-live-report-v1';
const MANIFEST_SHA256 = 'ecb367cbb191aa076321624c149e9a910997db2902dde433300eaa8e94738cc3';
const EXPECTED_MODEL = 'jev-1.13.0';

class VerificationError extends Error {}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function equal(a, b) {
  return isDeepStrictEqual(a, b);
}

function fail(message) {
  throw new VerificationError(message);
}

function completionMatchesFiles(completion, actualFiles) {
  return equal(completion?.files, actualFiles);
}

function assertReceiptProjection(bytes, parsed) {
  if (!equal(JSON.parse(bytes), parsed)) fail('raw receipt and parsed projection differ');
}

function assertMeasurements(result) {
  for (const value of [result.operationElapsedMs, result.stages?.request?.requestElapsedMs]) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) fail('invalid elapsed time');
  }
  for (const value of [result.stages?.request?.requestBytes, result.stages?.validatedResponse?.usage?.input_tokens, result.stages?.validatedResponse?.usage?.output_tokens]) {
    if (!Number.isSafeInteger(value) || value < 0) fail('invalid usage or byte count');
  }
}

function assertScheduleRows(rows, attempts) {
  if (rows.length !== attempts.length || new Set(rows.map(row => row.attemptId)).size !== rows.length || new Set(rows.map(row => row.row)).size !== rows.length) fail('duplicate or missing scheduled row');
  const expected = new Map(attempts.map(row => [row.attemptId, row]));
  for (const row of rows) if (!equal(row, expected.get(row.attemptId))) fail('row differs from frozen schedule');
}

function usage(rows) {
  return {
    inputTokens: rows.reduce((sum, row) => sum + row.usage.input_tokens, 0),
    outputTokens: rows.reduce((sum, row) => sum + row.usage.output_tokens, 0),
  };
}

function timing(rows, field) {
  const values = rows.map(row => row[field]).sort((a, b) => a - b);
  const sum = values.reduce((total, value) => total + value, 0);
  return {
    count: values.length,
    sum: Number(sum.toFixed(3)),
    mean: Number((sum / values.length).toFixed(3)),
    min: values[0],
    max: values.at(-1),
    median: values.length % 2
      ? values[(values.length - 1) / 2]
      : (values[values.length / 2 - 1] + values[values.length / 2]) / 2,
  };
}

function counts(rows, field) {
  const result = {};
  for (const value of new Set(rows.map(row => row[field]))) {
    result[value] = rows.filter(row => row[field] === value).length;
  }
  return result;
}

function eventKindsValid(events, arm) {
  const required = [
    'attempt_started',
    'hook_invocation_started',
    'request_started',
    'response_received',
    'hook_invocation_completed',
    'delivery_evaluated',
    'fixture_cleanup_completed',
    'result_persisted',
  ];
  if (arm === 'candidate-bundled-repair') {
    required.push('action_started', 'action_finished', 'postcondition_checked');
  }
  const kinds = new Set(events.map(event => event.kind));
  return required.every(kind => kinds.has(kind));
}

async function verifyRow(privateRoot, resultFile, manifestSha256, scheduledRow) {
  const stem = resultFile.slice(0, -'.result.json'.length);
  const resultBytes = await readFile(join(privateRoot, resultFile));
  const reservationBytes = await readFile(join(privateRoot, `${stem}.reservation.json`));
  const journalBytes = await readFile(join(privateRoot, `${stem}.events.jsonl`));
  const completionBytes = await readFile(join(privateRoot, `${stem}.completion.json`));
  const result = JSON.parse(resultBytes);
  const reservation = JSON.parse(reservationBytes);
  const completion = JSON.parse(completionBytes);
  const events = journalBytes.toString().trim().split('\n').map(line => JSON.parse(line));
  const providerRequest = result.providerRequests?.[0];
  const validated = result.stages?.validatedResponse;
  const serviceReceipt = result.pluginEvidence?.serviceReceipts?.[0];
  const invocationReceipt = result.pluginEvidence?.invocationReceipts?.[0];
  const service = serviceReceipt?.parsed;
  const invocation = invocationReceipt?.parsed;
  const actualFiles = {
    reservation: {sha256: sha256(reservationBytes), bytes: reservationBytes.byteLength},
    result: {sha256: sha256(resultBytes), bytes: resultBytes.byteLength},
    journal: {sha256: sha256(journalBytes), bytes: journalBytes.byteLength},
  };
  const row = result.row;

  if (result.schemaVersion !== 'plugin-development-attempt-result-v1') fail('result schema mismatch');
  if (!equal(row, scheduledRow) || row.attemptId !== stem) fail('result row differs from frozen schedule');
  assertMeasurements(result);
  if (result.manifestSha256 !== manifestSha256) fail('result manifest mismatch');
  if (!providerRequest || result.providerRequests.length !== 1) fail('provider request count mismatch');
  if (validated.actualResponseModel !== EXPECTED_MODEL) fail('provider model mismatch');
  if (!serviceReceipt || !invocationReceipt || !service || !invocation) fail('receipt presence mismatch');
  const receiptPaths = [serviceReceipt.path, invocationReceipt.path];
  if (receiptPaths.some(path => typeof path !== 'string' || path.startsWith('/') || path.split('/').includes('..'))) fail('receipt path validation failed');
  const stateRoot = join(privateRoot, `${result.row.attemptId}.state`);
  const serviceReceiptBytes = await readFile(join(stateRoot, serviceReceipt.path));
  const invocationReceiptBytes = await readFile(join(stateRoot, invocationReceipt.path));
  if (sha256(serviceReceiptBytes) !== serviceReceipt.sha256) fail('service receipt hash mismatch');
  if (sha256(invocationReceiptBytes) !== invocationReceipt.sha256) fail('invocation receipt hash mismatch');
  assertReceiptProjection(serviceReceiptBytes, service);
  assertReceiptProjection(invocationReceiptBytes, invocation);
  if (!completionMatchesFiles(completion, actualFiles)) fail('completion file hash mismatch');
  if (!equal(completion.rowIdentity, row) || !equal(reservation.rowIdentity, row)) fail('row identity mismatch');
  if (completion.manifestSha256 !== manifestSha256 || reservation.manifestSha256 !== manifestSha256) fail('receipt manifest mismatch');
  if (events.some(event => event.attemptId && event.attemptId !== row.attemptId)) fail('journal attempt identity mismatch');
  if (!eventKindsValid(events, row.arm)) fail('journal event-kind mismatch');
  const persisted = events.find(event => event.kind === 'result_persisted');
  if (!persisted || persisted.resultSha256 !== actualFiles.result.sha256) fail('journal result hash mismatch');
  if (
    service.model !== validated.providerModel
    || service.status !== validated.assessmentStatus
    || service.transport?.responseStatus !== providerRequest.responseStatus
    || service.transport?.providerRequestId !== providerRequest.providerRequestId
    || service.receiptId !== validated.receiptId
    || service.usage?.input_tokens !== validated.usage?.input_tokens
    || service.usage?.output_tokens !== validated.usage?.output_tokens
  ) fail('service receipt projection mismatch');
  if (invocation.referenceReceiptId !== service.receiptId) fail('invocation receipt projection mismatch');

  return {
    row: row.row,
    attemptId: row.attemptId,
    caseId: row.caseId,
    repeat: row.repeat,
    arm: row.arm,
    operationElapsedMs: result.operationElapsedMs,
    requestElapsedMs: result.stages.request.requestElapsedMs,
    requestBytes: result.stages.request.requestBytes,
    responseStatus: providerRequest.responseStatus,
    actualResponseModel: validated.actualResponseModel,
    validatedResponse: validated.status === 'validated',
    assessmentStatus: validated.assessmentStatus,
    usage: validated.usage,
    deliveryStatus: result.stages.delivery.status,
    actionStatus: result.stages.action.status,
    postconditionStatus: result.stages.postcondition.status,
    postconditionPass: result.stages.postcondition.pass,
    providerRequestIdPresent: typeof providerRequest.providerRequestId === 'string',
    providerRequestIdSha256: sha256(providerRequest.providerRequestId),
    serviceReceiptPresent: true,
    invocationReceiptPresent: true,
    serviceReceiptSha256: serviceReceipt.sha256,
    invocationReceiptSha256: invocationReceipt.sha256,
    reservationSha256: actualFiles.reservation.sha256,
    resultSha256: actualFiles.result.sha256,
    journalSha256: actualFiles.journal.sha256,
    completionSha256: sha256(completionBytes),
  };
}

function assertReportRow(reportRow, row) {
  const fields = [
    'row', 'attemptId', 'caseId', 'repeat', 'arm', 'operationElapsedMs',
    'requestElapsedMs', 'requestBytes', 'responseStatus', 'actualResponseModel',
    'validatedResponse', 'assessmentStatus', 'deliveryStatus', 'actionStatus',
    'postconditionStatus', 'postconditionPass', 'providerRequestIdSha256',
    'serviceReceiptSha256', 'invocationReceiptSha256', 'reservationSha256',
    'resultSha256', 'journalSha256', 'completionSha256',
  ];
  for (const field of fields) {
    if (reportRow[field] !== row[field]) fail(`published row mismatch: ${field}`);
  }
  if (!equal(reportRow.usage, row.usage)) fail('published usage mismatch');
}

async function verifyCohort({privateRoot, manifestPath, reportPath}) {
  const manifestBytes = await readFile(manifestPath);
  const manifest = JSON.parse(manifestBytes);
  const manifestSha256 = sha256(manifestBytes);
  if (manifestSha256 !== MANIFEST_SHA256) fail('frozen manifest SHA mismatch');
  const report = JSON.parse(await readFile(reportPath, 'utf8'));
  if (report.schemaVersion !== SCHEMA) fail('published report schema mismatch');
  if (report.source?.frozenManifest?.sha256 !== manifestSha256) fail('published manifest binding mismatch');
  if (report.source?.frozenManifest?.contentSha256 !== manifest.frozenContentSha256) fail('published manifest content binding mismatch');

  const scheduleBinding = manifest.files.inputs.find(entry => entry.path.endsWith('/experiment/schedule.json'));
  if (!scheduleBinding) fail('frozen schedule binding missing');
  const scheduleBytes = await readFile(join(dirname(manifestPath), 'schedule.json'));
  if (sha256(scheduleBytes) !== scheduleBinding.sha256 || scheduleBytes.length !== scheduleBinding.bytes) fail('frozen schedule hash mismatch');
  const schedule = JSON.parse(scheduleBytes);
  if (schedule.attempts.length !== manifest.experiment.scheduledRows) fail('schedule row count mismatch');
  assertScheduleRows(schedule.attempts, schedule.attempts);
  const directoryNames = (await readdir(privateRoot)).sort();
  const expectedNames = schedule.attempts.flatMap(row => ['.result.json', '.reservation.json', '.completion.json', '.events.jsonl', '.state'].map(suffix => row.attemptId + suffix)).sort();
  if (!equal(directoryNames, expectedNames)) fail('missing or orphan attempt artifacts');
  const resultFiles = directoryNames.filter(name => name.endsWith('.result.json'));
  const rows = [];
  const scheduled = new Map(schedule.attempts.map(row => [row.attemptId + '.result.json', row]));
  for (const resultFile of resultFiles) rows.push(await verifyRow(privateRoot, resultFile, manifestSha256, scheduled.get(resultFile)));
  rows.sort((a, b) => a.row - b.row);

  const control = rows.filter(row => row.arm === 'control-released');
  const candidate = rows.filter(row => row.arm === 'candidate-bundled-repair');
  const summary = {
    rows: rows.length,
    independentCases: new Set(rows.map(row => row.caseId)).size,
    repeats: new Set(rows.map(row => row.repeat)).size,
    arms: {controlReleased: control.length, candidateBundledRepair: candidate.length},
    httpStatuses: counts(rows, 'responseStatus'),
    responseModels: counts(rows, 'actualResponseModel'),
    validatedResponses: rows.filter(row => row.validatedResponse).length,
    abstentions: rows.filter(row => row.deliveryStatus === 'abstained').length,
    delivered: rows.filter(row => row.deliveryStatus === 'delivered').length,
    notDelivered: rows.filter(row => row.deliveryStatus === 'not_delivered').length,
    actionsCompleted: rows.filter(row => row.actionStatus === 'completed').length,
    postconditionPassed: rows.filter(row => row.postconditionPass === true).length,
    postconditionUnknown: rows.filter(row => row.postconditionStatus === 'unknown').length,
    providerRequestIdsRetainedPrivately: rows.filter(row => row.providerRequestIdPresent).length,
    serviceReceipts: rows.filter(row => row.serviceReceiptPresent).length,
    invocationReceipts: rows.filter(row => row.invocationReceiptPresent).length,
    tokenUsage: usage(rows),
    timingMs: {operation: timing(rows, 'operationElapsedMs'), request: timing(rows, 'requestElapsedMs')},
  };
  if (!equal(report.summary.rows, summary.rows)) fail('published summary row count mismatch');
  if (!equal(report.summary.independentCases, summary.independentCases)) fail('published independent-case count mismatch');
  if (!equal(report.summary.repeats, summary.repeats)) fail('published repeat count mismatch');
  if (!equal(report.summary.arms, summary.arms)) fail('published arm count mismatch');
  for (const field of ['httpStatuses', 'responseModels', 'validatedResponses', 'abstentions', 'delivered', 'notDelivered', 'actionsCompleted', 'postconditionPassed', 'postconditionUnknown', 'providerRequestIdsRetainedPrivately', 'serviceReceipts', 'invocationReceipts', 'tokenUsage', 'timingMs']) {
    if (!equal(report.summary[field], summary[field])) fail(`published summary mismatch: ${field}`);
  }
  if (report.rows.length !== rows.length) fail('published row array count mismatch');
  for (let index = 0; index < rows.length; index += 1) assertReportRow(report.rows[index], rows[index]);

  return {
    status: 'ok',
    rows: summary.rows,
    independentCases: summary.independentCases,
    repeats: summary.repeats,
    arms: summary.arms,
    http200: summary.httpStatuses['200'] ?? 0,
    validatedResponses: summary.validatedResponses,
    abstentions: summary.abstentions,
    delivered: summary.delivered,
    actionsCompleted: summary.actionsCompleted,
    postconditionPassed: summary.postconditionPassed,
    tokenUsage: summary.tokenUsage,
    hashConsistency: 'pass',
    publishedReport: 'match',
  };
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--self-test') args.selfTest = true;
    else if (arg === '--private-root' || arg === '--manifest' || arg === '--report') args[arg.slice(2)] = argv[++index];
    else fail('unknown argument');
  }
  return args;
}

function selfTest() {
  const actual = {reservation: {sha256: 'a', bytes: 1}, result: {sha256: 'b', bytes: 2}, journal: {sha256: 'c', bytes: 3}};
  const valid = {files: structuredClone(actual)};
  const malformed = {files: {...structuredClone(actual), result: {sha256: 'tampered', bytes: 2}}};
  if (!completionMatchesFiles(valid, actual)) fail('self-test valid completion rejected');
  if (completionMatchesFiles(malformed, actual)) fail('self-test malformed hash accepted');
  function rejects(callback) {
    try { callback(); } catch (error) { if (error instanceof VerificationError) return; throw error; }
    fail('self-test invalid evidence accepted');
  }
  assertReceiptProjection(Buffer.from('{"status":"assessed"}'), {status: 'assessed'});
  rejects(() => assertReceiptProjection(Buffer.from('{"status":"abstained"}'), {status: 'assessed'}));
  const row = {row: 1, attemptId: 'case.r1.control', caseId: 'case', repeat: 1, arm: 'control'};
  assertScheduleRows([row], [row]);
  rejects(() => assertScheduleRows([row, row], [row, {...row, row: 2, attemptId: 'case.r2.control'}]));
  rejects(() => assertScheduleRows([{...row, arm: 'candidate'}], [row]));
  const measurements = {operationElapsedMs: 1, stages: {request: {requestElapsedMs: 1, requestBytes: 1}, validatedResponse: {usage: {input_tokens: 1, output_tokens: 1}}}};
  assertMeasurements(measurements);
  for (const value of [NaN, Infinity, -1, null, '1']) rejects(() => assertMeasurements({...measurements, operationElapsedMs: value}));
  for (const value of [-1, NaN, Infinity, 1.5, null, '1']) rejects(() => assertMeasurements({...measurements, stages: {...measurements.stages, validatedResponse: {usage: {input_tokens: value, output_tokens: 1}}}}));
  return {status: 'ok', malformedHashRejected: true, rawProjectionChecked: true, scheduleBindingChecked: true, invalidMeasurementsRejected: true};
}

try {
  const args = parseArgs(process.argv.slice(2));
  const output = args.selfTest
    ? selfTest()
    : await verifyCohort({privateRoot: args['private-root'], manifestPath: args.manifest, reportPath: args.report});
  console.log(JSON.stringify(output, null, 2));
} catch (error) {
  const reason = error instanceof VerificationError ? error.message : 'read_or_parse_failure';
  console.error(JSON.stringify({status: 'failed', reason}, null, 2));
  process.exitCode = 1;
}

export {completionMatchesFiles, selfTest, verifyCohort};
