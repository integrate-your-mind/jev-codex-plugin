#!/usr/bin/env node

import {readFile} from 'node:fs/promises';
import {isAbsolute, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function finiteNonNegative(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function addCount(map, key) {
  map[key] = (map[key] ?? 0) + 1;
}

function numberFrom(value, keys) {
  for (const key of keys) if (finiteNonNegative(value?.[key])) return value[key];
  return null;
}

function receiptIdsForTrial(trial) {
  const ids = new Set();
  const add = value => {
    if (value === undefined || value === null) return;
    if (typeof value !== 'string' || !UUID.test(value)) throw new Error('Invalid receipt identifier in trial telemetry');
    ids.add(value);
  };
  if (Array.isArray(trial?.hookSummary?.receiptIds)) for (const id of trial.hookSummary.receiptIds) add(id);
  if (Array.isArray(trial?.localReceipts?.receipts)) {
    for (const receipt of trial.localReceipts.receipts) add(receipt?.referenceReceiptId);
  }
  return [...ids].sort();
}

function mcpCallCount(trial) {
  const counts = object(trial?.toolCounts) ? trial.toolCounts : {};
  return Object.entries(counts).reduce((total, [key, count]) => {
    if (!key.startsWith('mcpToolCall')) return total;
    return total + (Number.isSafeInteger(count) && count >= 0 ? count : 0);
  }, 0);
}

function latencyFromReceipt(receipt) {
  if (finiteNonNegative(receipt?.latencyMs)) return receipt.latencyMs;
  const started = Date.parse(receipt?.transport?.requestStartedAt ?? '');
  const received = Date.parse(receipt?.transport?.responseReceivedAt ?? '');
  if (!Number.isFinite(started) || !Number.isFinite(received) || received < started) return null;
  return received - started;
}

function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)];
}

function latencyStats(values) {
  if (values.length === 0) return {observed: 0, min: null, median: null, p95: null, max: null, mean: null};
  const sorted = [...values].sort((a, b) => a - b);
  return {
    observed: values.length,
    min: Math.min(...values),
    median: (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) / 2,
    p95: percentile(values, 0.95),
    max: Math.max(...values),
    mean: values.reduce((sum, value) => sum + value, 0) / values.length,
  };
}

async function readTrials(runDirectory) {
  let raw;
  try {
    raw = await readFile(join(runDirectory, 'trials.jsonl'), 'utf8');
  } catch {
    throw new Error('Unable to read trials.jsonl from the run directory');
  }
  const rows = [];
  const trialIds = new Set();
  for (const [index, line] of raw.split('\n').entries()) {
    if (!line.trim()) continue;
    let trial;
    try {
      trial = JSON.parse(line);
    } catch {
      throw new Error(`Invalid trial JSON at line ${index + 1}`);
    }
    if (!object(trial) || typeof trial.trialId !== 'string' || trial.trialId.length === 0) {
      throw new Error(`Trial at line ${index + 1} has no usable trialId`);
    }
    if (trialIds.has(trial.trialId)) throw new Error('Duplicate trial identifier in run telemetry');
    trialIds.add(trial.trialId);
    rows.push(trial);
  }
  return rows;
}

async function readReceipt(stateDirectory, id) {
  let raw;
  try {
    raw = await readFile(join(stateDirectory, 'receipts', `${id}.json`), 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return {kind: 'missing'};
    return {kind: 'unreadable'};
  }
  let receipt;
  try {
    receipt = JSON.parse(raw);
  } catch {
    return {kind: 'unreadable'};
  }
  if (!object(receipt) || receipt.receiptId !== id) return {kind: 'unreadable'};
  return {kind: 'found', receipt};
}

function claimReceiptIds(rows) {
  const owners = new Map();
  return rows.map((trial, index) => {
    const ids = receiptIdsForTrial(trial);
    for (const id of ids) {
      if (owners.has(id) && owners.get(id) !== index) throw new Error('Receipt identifier reused across trials');
      owners.set(id, index);
    }
    return ids;
  });
}

export async function collectReceiptMetrics(runDirectoryInput, stateDirectoryInput) {
  if (typeof runDirectoryInput !== 'string' || !isAbsolute(runDirectoryInput)) throw new Error('RUN_DIRECTORY must be absolute');
  if (typeof stateDirectoryInput !== 'string' || !isAbsolute(stateDirectoryInput)) throw new Error('STATE_DIRECTORY must be absolute');
  const runDirectory = resolve(runDirectoryInput);
  const stateDirectory = resolve(stateDirectoryInput);
  const rows = await readTrials(runDirectory);
  const idsByTrial = claimReceiptIds(rows);
  const statuses = {assessed: 0, abstained: 0, unavailable: 0, other: 0};
  const fetchInvoked = {true: 0, false: 0, unknown: 0};
  const validated = {true: 0, false: 0, unknown: 0};
  const providerRequestId = {present: 0, absent: 0, unknown: 0};
  const httpStatus = {};
  const latencies = [];
  let found = 0;
  let missing = 0;
  let unreadable = 0;
  let responsesWithoutHttpStatus = 0;
  let inputTokenReceipts = 0;
  let outputTokenReceipts = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  const byTrial = [];

  for (let index = 0; index < rows.length; index += 1) {
    const trial = rows[index];
    const ids = idsByTrial[index];
    let trialFound = 0;
    let trialMissing = 0;
    let trialUnreadable = 0;
    for (const id of ids) {
      const loaded = await readReceipt(stateDirectory, id);
      if (loaded.kind === 'missing') {
        missing += 1;
        trialMissing += 1;
        continue;
      }
      if (loaded.kind !== 'found') {
        unreadable += 1;
        trialUnreadable += 1;
        continue;
      }
      found += 1;
      trialFound += 1;
      const receipt = loaded.receipt;
      const status = receipt.status;
      if (status === 'assessed' || status === 'abstained' || status === 'unavailable') addCount(statuses, status);
      else addCount(statuses, 'other');
      const transport = object(receipt.transport) ? receipt.transport : {};
      if (transport.fetchInvoked === true) fetchInvoked.true += 1;
      else if (transport.fetchInvoked === false) fetchInvoked.false += 1;
      else fetchInvoked.unknown += 1;
      if (transport.validatedResponse === true) validated.true += 1;
      else if (transport.validatedResponse === false) validated.false += 1;
      else validated.unknown += 1;
      if (typeof transport.providerRequestId === 'string' && transport.providerRequestId.length > 0) providerRequestId.present += 1;
      else if (transport.providerRequestId === null || transport.providerRequestId === undefined || transport.providerRequestId === '') providerRequestId.absent += 1;
      else providerRequestId.unknown += 1;
      if (Number.isSafeInteger(transport.responseStatus) && transport.responseStatus >= 100 && transport.responseStatus <= 599) addCount(httpStatus, String(transport.responseStatus));
      else responsesWithoutHttpStatus += 1;
      const latency = latencyFromReceipt(receipt);
      if (latency !== null) latencies.push(latency);
      const usage = object(receipt.usage) ? receipt.usage : {};
      const input = numberFrom(usage, ['input_tokens', 'inputTokens']);
      const output = numberFrom(usage, ['output_tokens', 'outputTokens']);
      if (input !== null) { inputTokenReceipts += 1; inputTokens += input; }
      if (output !== null) { outputTokenReceipts += 1; outputTokens += output; }
    }
    byTrial.push({
      trialId: trial.trialId,
      taskId: typeof trial.taskId === 'string' ? trial.taskId : null,
      arm: typeof trial.arm === 'string' ? trial.arm : null,
      derivedReceiptCount: ids.length,
      foundReceiptCount: trialFound,
      missingReceiptCount: trialMissing,
      unreadableReceiptCount: trialUnreadable,
      mcpCallCount: mcpCallCount(trial),
    });
  }

  const mcpTrials = byTrial.filter(trial => trial.mcpCallCount > 0);
  const mcpCoverage = mcpTrials.length === 0
    ? {complete: true, trialsWithMcpCalls: 0, mcpCallCount: 0, trialsWithUnlinkedCalls: 0, limitation: null}
    : {
      complete: false,
      trialsWithMcpCalls: mcpTrials.length,
      mcpCallCount: mcpTrials.reduce((sum, trial) => sum + trial.mcpCallCount, 0),
      trialsWithUnlinkedCalls: mcpTrials.length,
      limitation: 'MCP call telemetry has no per-call result-receipt association. Receipt-derived metrics are a lower bound and cannot establish coverage or attribution for those calls.',
    };

  return {
    schemaVersion: 'paired-receipt-metrics-v1',
    trialCount: rows.length,
    receiptIds: {derived: idsByTrial.reduce((sum, ids) => sum + ids.length, 0), found, missing, unreadable},
    attempts: {fetchInvoked, observedReceiptFiles: found},
    responses: {observed: Object.values(httpStatus).reduce((sum, count) => sum + count, 0), withoutHttpStatus: responsesWithoutHttpStatus, byHttpStatus: httpStatus},
    validated,
    statuses,
    latencyMs: latencyStats(latencies),
    usage: {inputTokenReceipts, outputTokenReceipts, inputTokens, outputTokens},
    providerRequestIdPresence: providerRequestId,
    missingIds: {count: missing, trials: byTrial.filter(trial => trial.missingReceiptCount > 0).length},
    mcpCoverage,
    byTrial,
    sanitization: {credentialFingerprint: 'omitted', requestIds: 'presence-only', bodies: 'omitted', filesystemPaths: 'omitted'},
  };
}

async function main(argv = process.argv.slice(2)) {
  if (argv.length !== 2) throw new Error('Usage: receipt-metrics.mjs RUN_DIRECTORY STATE_DIRECTORY');
  const result = await collectReceiptMetrics(argv[0], argv[1]);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    process.stderr.write(`receipt metrics failed: ${String(error?.message ?? error)}\n`);
    process.exitCode = 1;
  });
}
