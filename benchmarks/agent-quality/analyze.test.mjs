import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { analyzeCohorts, analyzeOutputDirs, JEV_INPUT_RATE_USD_PER_MILLION } from './analyze.mjs';

function trial(id, arm, overrides = {}) {
  return {
    id, arm, hostCompleted: true, artifactCorrect: true, totalWallMs: arm === 'off' ? 100 : 130,
    validity: { valid: true },
    receipt: { usage: { inputTokens: 100, cachedInputTokens: 20, cacheCreationTokens: 10, outputTokens: 40 }, cost: {}, jev: { requestIds: arm === 'on' ? [`req-${id}`] : [], deliveryReceiptIds: arm === 'on' ? [`del-${id}`] : [], inputTokens: 50, abstentions: 0 } },
    ...overrides,
  };
}

function cohortRows(host = 'claude') {
  const schedule = [];
  const results = new Map();
  for (const arm of ['off', 'on']) {
    const id = `${host}-task-a-0-${arm}`;
    schedule.push({ id, host, taskId: 'task-a', repetition: 0, arm });
    results.set(id, trial(id, arm));
  }
  return { plan: { phase: 'development', identity: { seed: 'fixed' }, schedule }, rows: schedule.map(scheduled => ({ cohort: 'synthetic', scheduled, result: results.get(scheduled.id), facts: null })) };
}

test('reports paired quality, time, disjoint Claude cache accounting, and Jev estimate', () => {
  const cohort = cohortRows();
  const report = analyzeCohorts([cohort]);
  const host = report.hosts.claude;
  assert.equal(host.off.scheduled, 1);
  assert.equal(host.on.correct, 1);
  assert.equal(host.pairedTimeMs.median, 30);
  assert.equal(host.on.usage.totals.cachedInputTokens, 20);
  assert.equal(host.on.usage.totals.cacheCreationTokens, 10);
  assert.equal(host.on.usage.totals.uncachedInputTokens, 100);
  assert.equal(host.on.usage.totals.totalInputTokens, 130);
  assert.equal(host.on.jev.uniqueProviderRequests, 1);
  assert.equal(host.on.jev.uniqueDeliveries, 1);
  assert.ok(Math.abs(host.on.jev.estimatedInputCost.inputUsd - 0.0000021) < 1e-15);
  assert.equal(host.on.jev.estimatedInputCost.inputRateUsdPerMillion, JEV_INPUT_RATE_USD_PER_MILLION);
});

test('treats Claude numeric deliveryReceipts as counts, never as IDs', () => {
  const cohort = cohortRows('claude');
  for (const row of cohort.rows) {
    row.result.receipt.jev.deliveryReceiptIds = undefined;
    row.result.receipt.jev.deliveryReceipts = row.scheduled.arm === 'on' ? 10 : 0;
  }
  const report = analyzeCohorts([cohort]);
  assert.equal(report.hosts.claude.on.jev.uniqueDeliveries, 0);
  assert.equal(report.hosts.claude.on.jev.reportedDeliveryReceipts, 10);
});

test('reads real Claude nested receipt fields and keeps timeout separate from abort', () => {
  const scheduled = { id: 'real-shape', host: 'claude', taskId: 'task-a', repetition: 0, arm: 'on' };
  const result = {
    id: scheduled.id,
    receipt: {
      requestedModel: 'claude-opus-5-5[1m]',
      resolvedModel: 'claude-opus-5-5[1m]',
      usage: { inputTokens: 12, cachedInputTokens: 102429, cacheCreationTokens: 7018, outputTokens: 3610, reasoningTokens: null },
      jev: { requestIds: ['req-1'], deliveryReceipts: 10, adviceDeliveries: 8, abstentions: 3 },
      timedOut: false,
      interrupted: true,
    },
    hostCompleted: false,
    artifactCorrect: false,
  };
  const report = analyzeCohorts([{ plan: { phase: 'development', schedule: [scheduled] }, rows: [{ cohort: 'synthetic', scheduled, result, facts: null }] }]);
  const group = report.hosts.claude.on;
  assert.equal(report.hosts.claude.models.resolved[0], 'claude-opus-5-5[1m]');
  assert.equal(group.usage.totals.uncachedInputTokens, 12);
  assert.equal(group.usage.totals.totalInputTokens, 109459);
  assert.equal(group.timeout, 0);
  assert.equal(group.aborted, 1);
  assert.equal(group.jev.uniqueDeliveries, 0);
  assert.equal(group.jev.reportedDeliveryReceipts, 10);
});

test('keeps missing, timeout, invalid, and null costs visible', () => {
  const cohort = cohortRows('codex');
  const on = cohort.rows.find(row => row.scheduled.arm === 'on');
  on.result = { ...on.result, hostCompleted: false, artifactCorrect: false, timeout: true, validity: { valid: false }, receipt: { ...on.result.receipt, usage: {} } };
  const report = analyzeCohorts([cohort]);
  const host = report.hosts.codex;
  assert.equal(host.on.completed, 0);
  assert.equal(host.on.correct, 0);
  assert.equal(host.on.invalid, 1);
  assert.equal(host.on.timeout, 1);
  assert.equal(host.on.cost.reportedUsd.value, null);
  assert.equal(host.on.usage.coverage.inputTokens.known, 0);
});

test('missing result rows count as missing and do not become failures', () => {
  const cohort = cohortRows('qq');
  cohort.rows[1].result = null;
  const report = analyzeCohorts([cohort]);
  assert.equal(report.hosts.qq.on.scheduled, 1);
  assert.equal(report.hosts.qq.on.resultRows, 0);
  assert.equal(report.hosts.qq.on.missing, 1);
  assert.equal(report.hosts.qq.on.invalid, 0);
});

test('rejects duplicate schedule IDs and coordinates', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'jev-analyze-'));
  const plan = { phase: 'development', schedule: [{ id: 'same', host: 'codex', taskId: 'a', repetition: 0, arm: 'off' }, { id: 'same', host: 'codex', taskId: 'a', repetition: 0, arm: 'on' }] };
  try {
    await fs.writeFile(path.join(root, 'plan.json'), JSON.stringify(plan));
    await assert.rejects(() => analyzeOutputDirs([root]), /duplicate scheduled id/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('rejects duplicate result identities even when schedule IDs differ', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'jev-analyze-'));
  const schedule = [
    { id: 'one', host: 'codex', taskId: 'a', repetition: 0, arm: 'off' },
    { id: 'two', host: 'codex', taskId: 'a', repetition: 0, arm: 'on' },
  ];
  try {
    await fs.writeFile(path.join(root, 'plan.json'), JSON.stringify({ phase: 'development', schedule }));
    for (const row of schedule) {
      const trialDir = path.join(root, 'trials', row.id);
      await fs.mkdir(trialDir, { recursive: true });
      await fs.writeFile(path.join(trialDir, 'result.json'), JSON.stringify({ id: row.id, runId: 'same-result', hostCompleted: true }));
    }
    await assert.rejects(() => analyzeOutputDirs([root]), /duplicate result id/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('does not pool different cohort phases or host configurations', async () => {
  const first = await fs.mkdtemp(path.join(os.tmpdir(), 'jev-analyze-'));
  const second = await fs.mkdtemp(path.join(os.tmpdir(), 'jev-analyze-'));
  const plan = host => ({ phase: host === 'one' ? 'development' : 'confirmation', hostConfigurations: { claude: { model: host } }, schedule: [{ id: `${host}-row`, host: 'claude', taskId: 'a', repetition: 0, arm: 'off' }] });
  try {
    await fs.writeFile(path.join(first, 'plan.json'), JSON.stringify(plan('one')));
    await fs.writeFile(path.join(second, 'plan.json'), JSON.stringify(plan('two')));
    await assert.rejects(() => analyzeOutputDirs([first, second]), /incompatible cohort configuration/);
  } finally {
    await fs.rm(first, { recursive: true, force: true });
    await fs.rm(second, { recursive: true, force: true });
  }
});
