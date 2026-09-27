import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
// @ts-expect-error The focused CLI is a directly executable JavaScript module.
import {collectReceiptMetrics} from '../benchmarks/paired-v1/receipt-metrics.mjs';

const receiptA = '11111111-1111-4111-8111-111111111111';
const receiptB = '22222222-2222-4222-8222-222222222222';
const missing = '33333333-3333-4333-8333-333333333333';

function receipt(id: string, fields: Record<string, unknown> = {}) {
  return {
    receiptId: id,
    status: 'assessed',
    usage: {input_tokens: 10, output_tokens: 2},
    transport: {
      fetchInvoked: true,
      responseStatus: 200,
      validatedResponse: true,
      providerRequestId: 'req_must_not_appear',
      credentialFingerprint: 'fingerprint_must_not_appear',
      requestStartedAt: '2026-09-26T12:00:00.000Z',
      responseReceivedAt: '2026-09-26T12:00:00.005Z',
    },
    body: 'private response must not appear',
    ...fields,
  };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'jev-receipt-metrics-'));
  const run = join(root, 'run');
  const state = join(root, 'state');
  await mkdir(join(state, 'receipts'), {recursive: true});
  const rows = [
    {
      trialId: 'task.r1.treatment', taskId: 'task', repeat: 1, arm: 'treatment',
      hookSummary: {receiptIds: [receiptA, receiptA]},
      localReceipts: {receipts: [{referenceReceiptId: receiptA}, {referenceReceiptId: receiptB}]},
      toolCounts: {'mcpToolCall:jev-workflows:classify_decision': 1, commandExecution: 2},
    },
    {
      trialId: 'task.r1.baseline', taskId: 'task', repeat: 1, arm: 'baseline',
      hookSummary: {receiptIds: [missing]}, toolCounts: {commandExecution: 1},
    },
  ];
  await mkdir(run, {recursive: true});
  await writeFile(join(run, 'trials.jsonl'), rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  await writeFile(join(state, 'receipts', `${receiptA}.json`), JSON.stringify(receipt(receiptA)));
  await writeFile(join(state, 'receipts', `${receiptB}.json`), JSON.stringify(receipt(receiptB, {
    status: 'abstained',
    usage: {input_tokens: 3, output_tokens: 4},
    transport: {fetchInvoked: false, responseStatus: 503, validatedResponse: false, providerRequestId: null,
      requestStartedAt: '2026-09-26T12:00:01.000Z', responseReceivedAt: '2026-09-26T12:00:01.015Z'},
    body: 'another private body',
  })));
  return {root, run, state};
}

test('receipt metrics deduplicate per trial, aggregate exact files, and expose MCP coverage limits', async () => {
  const paths = await fixture();
  try {
    const result = await collectReceiptMetrics(paths.run, paths.state);
    assert.deepEqual(result.receiptIds, {derived: 3, found: 2, missing: 1, unreadable: 0});
    assert.deepEqual(result.attempts, {fetchInvoked: {true: 1, false: 1, unknown: 0}, observedReceiptFiles: 2});
    assert.deepEqual(result.responses, {observed: 2, withoutHttpStatus: 0, byHttpStatus: {'200': 1, '503': 1}});
    assert.deepEqual(result.validated, {true: 1, false: 1, unknown: 0});
    assert.deepEqual(result.statuses, {assessed: 1, abstained: 1, unavailable: 0, other: 0});
    assert.deepEqual(result.latencyMs, {observed: 2, min: 5, median: 10, p95: 15, max: 15, mean: 10});
    assert.deepEqual(result.usage, {inputTokenReceipts: 2, outputTokenReceipts: 2, inputTokens: 13, outputTokens: 6});
    assert.deepEqual(result.providerRequestIdPresence, {present: 1, absent: 1, unknown: 0});
    assert.deepEqual(result.missingIds, {count: 1, trials: 1});
    assert.equal(result.mcpCoverage.complete, false);
    assert.equal(result.mcpCoverage.mcpCallCount, 1);
    assert.match(result.mcpCoverage.limitation, /per-call result-receipt association/);
    assert.deepEqual(result.byTrial[0], {
      trialId: 'task.r1.treatment', taskId: 'task', arm: 'treatment', derivedReceiptCount: 2,
      foundReceiptCount: 2, missingReceiptCount: 0, unreadableReceiptCount: 0, mcpCallCount: 1,
    });
    const serialized = JSON.stringify(result);
    assert.equal(serialized.includes('req_must_not_appear'), false);
    assert.equal(serialized.includes('fingerprint_must_not_appear'), false);
    assert.equal(serialized.includes('private response'), false);
    assert.equal(serialized.includes(paths.state), false);
  } finally {
    await rm(paths.root, {recursive: true, force: true});
  }
});

test('receipt identifiers cannot be reused across trials', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jev-receipt-metrics-'));
  try {
    const run = join(root, 'run');
    const state = join(root, 'state');
    await mkdir(join(state, 'receipts'), {recursive: true});
    await mkdir(run, {recursive: true});
    const rows = [1, 2].map(repeat => ({trialId: `task.r${repeat}.treatment`, hookSummary: {receiptIds: [receiptA]}}));
    await writeFile(join(run, 'trials.jsonl'), rows.map(row => JSON.stringify(row)).join('\n') + '\n');
    await assert.rejects(collectReceiptMetrics(run, state), /reused across trials/);
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test('receipt metrics reject malformed identifiers before reading state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jev-receipt-metrics-'));
  try {
    const run = join(root, 'run');
    const state = join(root, 'state');
    await mkdir(run, {recursive: true});
    await mkdir(join(state, 'receipts'), {recursive: true});
    await writeFile(join(run, 'trials.jsonl'), JSON.stringify({trialId: 'task.r1.treatment', hookSummary: {receiptIds: ['../secret']}}) + '\n');
    await assert.rejects(collectReceiptMetrics(run, state), /Invalid receipt identifier/);
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});
