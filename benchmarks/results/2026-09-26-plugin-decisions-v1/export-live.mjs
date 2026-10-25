#!/usr/bin/env node
import {createHash} from 'node:crypto';
import {open, readFile, rm} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const USAGE_KEYS = ['input_tokens', 'cache_read_input_tokens', 'output_tokens'];
const FORBIDDEN_PUBLIC_KEYS = new Set(['providerRequestId', 'receiptId', 'sourceRoot', 'execPath', 'headers', 'modelVisibleInput', 'modelVisibleDecision', 'outgoingPayload', 'payload']);
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const digestJson = (value) => sha256(Buffer.from(JSON.stringify(value), 'utf8'));
const fail = (message) => { throw new Error(message); };
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const string = (value, label) => { if (typeof value !== 'string' || !value) fail(`${label} must be a non-empty string`); return value; };
const nullableString = (value, label) => { if (value !== null && value !== undefined && typeof value !== 'string') fail(`${label} must be a string or null`); return value ?? null; };
const nonNegativeInteger = (value, label) => { if (!Number.isInteger(value) || value < 0) fail(`${label} must be a non-negative integer`); return value; };
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const HASH64 = /^[0-9a-f]{64}$/u;
const RESERVED_CANDIDATE = 'insufficient_evidence';
const PROVIDER_STATUSES = new Set(['assessed', 'abstained', 'unavailable', 'skipped', 'preview', 'invalid_response']);
const candidate = (value, label, {allowNull = true} = {}) => {
  if (value === null && allowNull) return null;
  if (typeof value !== 'string' || (value !== RESERVED_CANDIDATE && !SAFE_ID.test(value))) fail(`${label} must be a safe candidate ID`);
  return value;
};
const hash64 = (value, label, {allowNull = false} = {}) => {
  if (value === null && allowNull) return null;
  if (typeof value !== 'string' || !HASH64.test(value)) fail(`${label} must be a lowercase SHA-256 hex digest`);
  return value;
};
const finite01 = (value, label, {allowNull = true} = {}) => {
  if (value === null && allowNull) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) fail(`${label} must be a finite number in [0,1]`);
  return value;
};
const nullableFinite = (value, label) => {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) fail(`${label} must be a non-negative finite number or null`);
  return value;
};

function safeProbabilities(value, label) {
  if (value === null || value === undefined) return null;
  if (!isObject(value)) fail(`${label} probabilities must be an object or null`);
  const result = {};
  for (const [key, probability] of Object.entries(value)) {
    candidate(key, `${label} probability key`, {allowNull: false});
    finite01(probability, `${label}.probabilities.${key}`, {allowNull: false});
    result[key] = probability;
  }
  return result;
}

function parseJsonl(bytes) {
  const lines = bytes.toString('utf8').split(/\r?\n/u).filter(Boolean);
  if (!lines.length) fail('input transcript is empty');
  return lines.map((line, index) => { try { return JSON.parse(line); } catch (error) { fail(`invalid JSONL at line ${index + 1}: ${error.message}`); } });
}

function validateOracle(oracle, expectedHash) {
  if (!isObject(oracle) || !Array.isArray(oracle.episodes)) fail('oracle must contain episodes');
  if (expectedHash && digestJson(oracle) !== expectedHash) fail(`oracle hash mismatch: expected ${expectedHash}`);
  const byId = new Map();
  for (const row of oracle.episodes) {
    const id = string(row?.episodeId, 'oracle episodeId');
    if (byId.has(id)) fail(`duplicate oracle episode: ${id}`);
    if (row.expectedDisposition !== 'assessed' && row.expectedDisposition !== 'abstained') fail(`invalid oracle disposition: ${id}`);
    if (row.expectedDisposition === 'abstained' && row.expectedChoice !== null) fail(`abstained oracle must have null choice: ${id}`);
    if (row.expectedDisposition === 'assessed') string(row.expectedChoice, `oracle expectedChoice for ${id}`);
    byId.set(id, {expectedDisposition: row.expectedDisposition, expectedChoice: row.expectedChoice ?? null});
  }
  return byId;
}

function safeUsage(usage, label) {
  if (usage == null) return null;
  if (!isObject(usage)) fail(`${label} usage must be an object or null`);
  const result = {};
  for (const key of USAGE_KEYS) if (usage[key] !== undefined) result[key] = nonNegativeInteger(usage[key], `${label}.usage.${key}`);
  return result;
}

function validateReceipt(row, label) {
  const receipt = row.receipt;
  if (!isObject(receipt)) fail(`${label} is missing receipt provenance`);
  if (typeof receipt.persisted !== 'boolean') fail(`${label}.receipt.persisted must be boolean`);
  if (receipt.persisted && (typeof receipt.receiptId !== 'string' || !receipt.receiptId)) fail(`${label} persisted receipt lacks local receipt ID`);
  if (!receipt.persisted && receipt.receiptId != null) fail(`${label} non-persisted receipt must not carry an ID`);
  if (receipt.responseStatus !== null && (!Number.isInteger(receipt.responseStatus) || receipt.responseStatus < 100 || receipt.responseStatus > 599)) fail(`${label} has invalid HTTP status`);
  if (receipt.validatedResponse !== null && typeof receipt.validatedResponse !== 'boolean') fail(`${label} validatedResponse must be boolean or null`);
  if (typeof receipt.providerRequestIdPresent !== 'boolean') fail(`${label} provider ID presence must be boolean`);
  if (row.receiptParity !== null && typeof row.receiptParity !== 'boolean') fail(`${label} receiptParity must be boolean or null`);
  safeUsage(receipt.usage, label);
  return receipt;
}

function validateTranscript(rows, oracleById) {
  const headers = rows.filter((row) => row?.kind === 'header');
  if (headers.length !== 1) fail(`expected exactly one header, found ${headers.length}`);
  if (rows.findIndex((row) => row?.kind === 'header') !== 0) fail('header must precede all attempts');
  const header = headers[0];
  if (!isObject(header) || header.schemaVersion !== 'plugin-live-eval-run-v2') fail('expected plugin-live-eval-run-v2 header');
  if (!Number.isInteger(header.plannedAttempts) || header.plannedAttempts < 1) fail('header plannedAttempts must be positive');
  if (!Array.isArray(header.sourceRecords) || header.sourceRecords.length !== 2) fail('header must contain two source records');
  const sourceRecords = header.sourceRecords.map((source) => ({
    arm: string(source.arm, 'source arm'), entrypoint: string(source.entrypoint, 'source entrypoint'),
    gitCommit: nullableString(source.gitCommit, 'source gitCommit'), sourceSha256: hash64(source.sourceSha256, 'source SHA'),
    entrypointSha256: hash64(source.entrypointSha256, 'entrypoint SHA', {allowNull: true}), fileCount: nonNegativeInteger(source.fileCount, 'source fileCount'),
  }));
  const sourceByArm = new Map();
  const sourceHashes = new Set();
  for (const source of sourceRecords) {
    if (sourceByArm.has(source.arm)) fail(`duplicate source arm: ${source.arm}`);
    if (sourceHashes.has(source.sourceSha256)) fail(`duplicate source hash: ${source.sourceSha256}`);
    sourceByArm.set(source.arm, source);
    sourceHashes.add(source.sourceSha256);
  }
  const started = rows.filter((row) => row?.kind === 'attempt_started');
  const finished = rows.filter((row) => row?.kind === 'attempt_finished');
  if (started.length !== header.plannedAttempts) fail(`attempted count ${started.length} does not match planned ${header.plannedAttempts}`);
  const startedIds = new Set();
  const startedKeys = new Set();
  const startedById = new Map();
  const seenStartedInOrder = new Set();
  for (const row of rows) {
    if (row?.kind === 'attempt_started') seenStartedInOrder.add(row.attemptId);
    if (row?.kind === 'attempt_finished' && !seenStartedInOrder.has(row.attemptId)) fail(`finished attempt precedes started row: ${row.attemptId}`);
  }
  for (const row of started) {
    const id = string(row.attemptId, 'attempt ID');
    if (startedIds.has(id)) fail(`duplicate attempt_started: ${id}`);
    const source = sourceByArm.get(row.arm);
    if (!source) fail(`unknown started arm: ${row.arm}`);
    if (row.sourceSha256 !== source.sourceSha256) fail(`started source hash mismatch: ${id}`);
    const key = `${string(row.episodeId, `${id} episodeId`)}|${row.arm}|${nonNegativeInteger(row.repeat, `${id} repeat`)}`;
    if (startedKeys.has(key)) fail(`duplicate episode-arm-repeat: ${key}`);
    startedIds.add(id); startedKeys.add(key); startedById.set(id, row);
  }
  const finishedIds = new Set();
  const finishedKeys = new Set();
  for (const row of finished) {
    const id = string(row.attemptId, 'finished attempt ID');
    if (finishedIds.has(id)) fail(`duplicate attempt_finished: ${id}`);
    const startedRow = startedById.get(id);
    if (!startedRow) fail(`finished attempt has no started row: ${id}`);
    const source = sourceByArm.get(row.arm);
    if (!source) fail(`unknown finished arm: ${row.arm}`);
    if (row.sourceSha256 !== source.sourceSha256) fail(`finished source hash mismatch: ${id}`);
    for (const field of ['episodeId', 'family', 'repeat', 'arm', 'sourceSha256']) if (row[field] !== startedRow[field]) fail(`started/finished ${field} mismatch: ${id}`);
    const key = `${string(row.episodeId, `${id} episodeId`)}|${row.arm}|${nonNegativeInteger(row.repeat, `${id} repeat`)}`;
    if (finishedKeys.has(key)) fail(`duplicate finished episode-arm-repeat: ${key}`);
    finishedIds.add(id); finishedKeys.add(key);
  }
  for (const id of startedIds) if (!finishedIds.has(id)) fail(`started attempt has no terminal row: ${id}`);
  const trials = finished.map((row) => {
    const label = `attempt ${row.attemptId}`;
    const receipt = validateReceipt(row, label);
    const completed = row.status === 'completed';
    if (!completed && row.status !== 'error') fail(`${label} has invalid status`);
    if (row.transportAttempts !== null && row.transportAttempts !== undefined) nonNegativeInteger(row.transportAttempts, `${label} transportAttempts`);
    const episodeId = string(row.episodeId, `${label} episodeId`);
    if (oracleById && !oracleById.has(episodeId)) fail(`unknown oracle episode: ${episodeId}`);
    const oracle = oracleById?.get(episodeId) ?? null;
    const modelDecision = row.modelVisibleDecision ?? null;
    const delivered = row.delivered ?? null;
    if (modelDecision !== null && !isObject(modelDecision)) fail(`${label} model decision must be an object or null`);
    if (delivered !== null && !isObject(delivered)) fail(`${label} delivered result must be an object or null`);
    const providerStatus = modelDecision?.status ?? null;
    if (providerStatus !== null && !PROVIDER_STATUSES.has(providerStatus)) fail(`${label} has invalid provider status`);
    const providerChoice = candidate(row.validatedProviderChoice ?? null, `${label} provider choice`);
    const deliveredChoice = candidate(delivered?.decision ?? null, `${label} delivered choice`);
    const confidence = finite01(row.validatedConfidence ?? null, `${label} confidence`);
    const probabilities = safeProbabilities(row.validatedProbabilities ?? null, label);
    const expectedDisposition = oracle?.expectedDisposition ?? null;
    const expectedChoice = candidate(oracle?.expectedChoice ?? null, `${label} expected choice`);
    // The provider transport uses `insufficient_evidence` for an abstention;
    // the hook's neutral delivered output is scored separately.
    const providerDecisionCorrect = oracle ? providerStatus === expectedDisposition && (expectedDisposition === 'abstained' || providerChoice === expectedChoice) : null;
    return {
      episodeId, family: string(row.family, `${label} family`), repeat: nonNegativeInteger(row.repeat, `${label} repeat`), arm: string(row.arm, `${label} arm`),
      status: row.status, providerStatus, providerChoice, confidence, probabilities,
      expectedDisposition, expectedChoice, providerDecisionCorrect, deliveredChoice,
      transportAttempts: row.transportAttempts === null || row.transportAttempts === undefined ? null : nonNegativeInteger(row.transportAttempts, `${label} transportAttempts`), httpStatus: receipt.responseStatus, validatedResponse: receipt.validatedResponse ?? null,
      receiptPersisted: receipt.persisted, receiptParity: row.receiptParity ?? null, providerRequestIdPresent: receipt.providerRequestIdPresent,
      usage: safeUsage(receipt.usage, label), providerLatencyMs: nullableFinite(modelDecision?.latencyMs, `${label} provider latency`), hookInvocationMs: nullableFinite(row.latencyMs, `${label} hook latency`),
      payloadBytes: row.outgoingPayloadBytes === null || row.outgoingPayloadBytes === undefined ? null : nonNegativeInteger(row.outgoingPayloadBytes, `${label} payload bytes`), payloadSha256: hash64(row.outgoingPayloadDigest, `${label} payload digest`, {allowNull: true}),
    };
  });
  return {header, sourceRecords, trials};
}

function median(values) { const sorted = values.filter((value) => typeof value === 'number' && Number.isFinite(value)).sort((a, b) => a - b); if (!sorted.length) return null; const middle = Math.floor(sorted.length / 2); return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2; }
function sumUsage(trials, key) { const values = trials.map((trial) => trial.usage?.[key]).filter(Number.isInteger); return values.length === trials.length ? values.reduce((sum, value) => sum + value, 0) : null; }

function buildSummary(header, sourceRecords, trials, rawBytes, oracle) {
  const arms = {};
  for (const arm of [...new Set(trials.map((trial) => trial.arm))].sort()) {
    const rows = trials.filter((trial) => trial.arm === arm); const completed = rows.filter((trial) => trial.status === 'completed');
    const statuses = Object.fromEntries([...new Set(rows.map((row) => row.providerStatus).filter(Boolean))].sort().map((status) => [status, rows.filter((row) => row.providerStatus === status).length]));
    arms[arm] = {scheduled: rows.length, completed: completed.length, providerDecisionCorrect: completed.every((row) => row.providerDecisionCorrect === null) ? null : completed.filter((row) => row.providerDecisionCorrect === true).length, providerStatuses: statuses, concreteChoicesDelivered: completed.filter((row) => row.deliveredChoice !== null).length, correctConcreteChoicesDelivered: completed.filter((row) => row.deliveredChoice !== null && row.expectedChoice !== null && row.deliveredChoice === row.expectedChoice).length, inputTokens: sumUsage(rows, 'input_tokens'), outputTokens: sumUsage(rows, 'output_tokens'), medianProviderLatencyMs: median(rows.map((row) => row.providerLatencyMs)), medianHookInvocationMs: median(rows.map((row) => row.hookInvocationMs)), medianPayloadBytes: median(rows.map((row) => row.payloadBytes)), actualBilledUsd: null};
  }
  const episodeCount = new Set(trials.map((trial) => trial.episodeId)).size;
  const repeatCount = new Set(trials.map((trial) => trial.repeat)).size;
  const limits = [
    `Decision-level transcript with ${episodeCount} unique episodes and ${repeatCount} observed repetitions.`,
    'Provider correctness is descriptive against the supplied oracle; downstream task outcomes are unmeasured.',
  ];
  if (oracle && Object.values(arms).every((arm) => arm.providerDecisionCorrect === arm.completed)) limits.push('Every completed provider disposition matched the supplied oracle; this cohort cannot separate raw-choice quality beyond that ceiling.');
  if (Object.values(arms).some((arm) => arm.actualBilledUsd === null)) limits.push('Actual billed dollars are unknown.');
  if (header.note) limits.push('Transcript note: decision-level diagnostics only; no task-quality, deployment, or provider-superiority claim is produced.');
  return {schemaVersion: 'plugin-decision-results-v1', plannedAttempts: header.plannedAttempts, finishedAttempts: trials.length, uniqueAuthoredEpisodes: episodeCount, sourceRecords, runtime: {node: header.runtime?.node ?? null, platform: header.runtime?.platform ?? null, arch: header.runtime?.arch ?? null}, fixtureSha256: header.fixtureSha256 ?? null, oracleSha256: oracle ? digestJson(oracle) : header.oracleSha256 ?? null, privateRawEvidence: {bytes: rawBytes.byteLength, sha256: sha256(rawBytes)}, arms, limits};
}

function assertPublicSafe(value, path = '$') {
  if (Array.isArray(value)) return value.forEach((child, index) => assertPublicSafe(child, `${path}[${index}]`));
  if (!isObject(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_PUBLIC_KEYS.has(key) || /secret|credential/iu.test(key)) fail(`forbidden public field at ${path}.${key}`);
    if (typeof child === 'string' && (child.startsWith('/') || child.includes('-----BEGIN ') || /api[_-]?key|bearer\s/iu.test(child))) fail(`unsafe public value at ${path}.${key}`);
    assertPublicSafe(child, `${path}.${key}`);
  }
}

async function writeExclusive(path, value) { const handle = await open(path, 'wx', 0o644); try { await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8'); await handle.sync(); } finally { await handle.close(); } }

export async function exportDecisionResults(options) {
  const rawBytes = await readFile(resolve(options.inputPath)); const rows = parseJsonl(rawBytes); const header = rows.find((row) => row?.kind === 'header'); if (!header) fail('transcript has no header');
  let oracle = null; let oracleById = null;
  if (options.oraclePath) { oracle = JSON.parse((await readFile(resolve(options.oraclePath))).toString('utf8')); oracleById = validateOracle(oracle, header.oracleSha256); }
  const {sourceRecords, trials} = validateTranscript(rows, oracleById); const summary = buildSummary(header, sourceRecords, trials, rawBytes, oracle); assertPublicSafe(summary); assertPublicSafe(trials);
  await writeExclusive(resolve(options.summaryPath), summary);
  try { await writeExclusive(resolve(options.trialsPath), trials); } catch (error) { await rm(resolve(options.summaryPath), {force: true}); throw error; }
  return {summary, trials};
}

function parseArgs(argv) { const result = {}; const names = new Map([['--input', 'inputPath'], ['--oracle', 'oraclePath'], ['--summary-out', 'summaryPath'], ['--trials-out', 'trialsPath']]); for (let index = 0; index < argv.length; index += 1) { const key = names.get(argv[index]); if (!key || !argv[index + 1] || argv[index + 1].startsWith('--')) fail('usage: export-live.mjs --input JSONL --oracle ORACLE --summary-out SUMMARY --trials-out TRIALS'); result[key] = argv[++index]; } if (!result.inputPath || !result.summaryPath || !result.trialsPath) fail('input, summary-out, and trials-out are required'); return result; }
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) exportDecisionResults(parseArgs(process.argv.slice(2))).then(({summary, trials}) => console.log(JSON.stringify({ok: true, plannedAttempts: summary.plannedAttempts, finishedAttempts: summary.finishedAttempts, trials: trials.length}))).catch((error) => { console.error(error.message); process.exitCode = 1; });
