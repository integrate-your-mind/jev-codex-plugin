import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {reduceComparison, ComparisonValidationError} from '../compare.mjs';

const cohort = {
  datasetFingerprint: 'sha256:dataset', harnessFingerprint: 'sha256:harness', imageFingerprint: 'sha256:image',
  resourceBudget: {cpuMs: 60000, memoryBytes: 1024 ** 3, diskBytes: 1024 ** 3},
  environmentMode: 'container', timeBudget: {basis: 'per_turn', valueMs: 120000}, networkPolicy: {mode: 'disabled'},
};

function identity(agent, pluginEnabled = false, pluginVersion = null) {
  return {agent, agentVersion: '1.2.3', model: 'model-x', provider: 'provider-y', effort: 'medium', pluginEnabled, pluginVersion};
}

function planFor(factor = 'treatment') {
  const specs = factor === 'treatment'
    ? [['control', identity('codex', false, null)], ['treatment', identity('codex', true, 'jev-0.4.0')]]
    : [['codex', identity('codex', false, null)], ['qq', identity('qq', false, null)]];
  return {
    schemaVersion: 'jev-cross-agent-comparison-plan-v1',
    comparison: {factor, cohortId: 'cohort-1', armOrder: factor === 'treatment' ? ['control', 'treatment'] : ['codex', 'qq'], timingMetric: 'agent_turn_wall_ms'}, cohort,
    trials: specs.map(([arm, plannedIdentity]) => ({trialId: `task-1.r1.${arm}`, taskId: 'task-1', inputHash: 'sha256:input', repetition: 1, arm, plannedIdentity})),
  };
}

function trial(planRow, overrides = {}) {
  return {
    schemaVersion: 'jev-cross-agent-trial-v1', trialId: planRow.trialId, taskId: planRow.taskId, inputHash: planRow.inputHash,
    repetition: planRow.repetition, arm: planRow.arm, plannedIdentity: planRow.plannedIdentity, observedIdentity: planRow.plannedIdentity,
    cohort, artifactVerifier: {status: 'passed', passed: true}, agentCompletion: {status: 'completed', completed: true},
    timing: {metric: 'agent_turn_wall_ms', valueMs: planRow.arm === 'control' ? 100 : 120},
    tokens: {input: 1000, cachedInput: 200, output: 100}, billing: {actualBilledUsd: null, source: 'unknown'}, infrastructureError: null,
    ...overrides,
  };
}

function completeRows(plan) {
  return plan.trials.map(row => trial(row));
}

test('reduces fixed-model treatment rows with separate outcomes, tokens, billing null, and paired delta', () => {
  const plan = planFor();
  const rows = completeRows(plan);
  rows[1].agentCompletion = {status: 'failed', completed: false};
  rows[1].artifactVerifier = {status: 'not_run', passed: null};
  rows[1].timing.valueMs = null;
  const result = reduceComparison(plan, rows);
  assert.equal(result.claim, 'fixed_model_plugin_delta');
  assert.equal(result.denominators.plannedTrials, 2);
  assert.equal(result.byArm.control.artifact.passRate, 1);
  assert.equal(result.byArm.treatment.artifact.passRate, 0);
  assert.equal(result.byArm.treatment.billing.totalUsd, null);
  assert.equal(result.byArm.treatment.tokens.input.total, 1000);
  assert.equal(result.byArm.treatment.tokens.cachedInput.total, 200);
  assert.equal(result.pairs[0].deltas.timingMs, null);
  assert.equal(result.pairs[0].deltas.artifactPass, null);
  assert.equal(result.pairs[0].deltas.agentCompletion, -1);
});

test('labels Codex versus QQ as observational agent comparison', () => {
  const plan = planFor('agent');
  const result = reduceComparison(plan, completeRows(plan));
  assert.equal(result.claim, 'observational_agent_comparison');
  assert.match(result.interpretation, /observational/);
  assert.doesNotMatch(result.interpretation, /plugin delta/);
});

test('uses declared arm order rather than trial arrival order for paired deltas', () => {
  const plan = planFor();
  const rows = completeRows(plan).reverse();
  const result = reduceComparison(plan, rows);
  assert.deepEqual(result.pairs[0].arms, ['control', 'treatment']);
  assert.equal(result.pairs[0].deltas.timingMs, 20);
});

test('rejects duplicate, missing, and unexpected rows against frozen plan', () => {
  const plan = planFor();
  const rows = completeRows(plan);
  assert.throws(() => reduceComparison(plan, [...rows, rows[0]]), ComparisonValidationError);
  assert.throws(() => reduceComparison(plan, [rows[0]]), /trial count mismatch/);
  assert.throws(() => reduceComparison(plan, [{...rows[0], trialId: 'unexpected'}, rows[1]]), /unexpected trialId/);
});

test('rejects wrong identities, mixed cohort budgets, and treatment leakage', () => {
  const plan = planFor();
  const rows = completeRows(plan);
  assert.throws(() => reduceComparison(plan, [{...rows[0], observedIdentity: identity('qq')}, rows[1]]), /observedIdentity/);
  assert.throws(() => reduceComparison(plan, [{...rows[0], cohort: {...cohort, timeBudget: {basis: 'per_turn', valueMs: 999}}}, rows[1]]), /cohort/);
  assert.throws(() => reduceComparison(plan, [{...rows[0], observedIdentity: identity('codex', true, 'jev-0.4.0')}, rows[1]]), /observedIdentity/);
});

test('rejects mixed fixed agent/model identity and accepts explicitly uncontrolled native resources', () => {
  const plan = planFor();
  const mixed = structuredClone(plan);
  mixed.trials[1].plannedIdentity.model = 'other-model';
  assert.throws(() => reduceComparison(mixed, completeRows(mixed)), /mixes model identities/);
  const native = structuredClone(plan);
  native.cohort = {
    ...cohort,
    imageFingerprint: null,
    environmentMode: 'native_shared',
    resourceBudget: {cpuMs: null, memoryBytes: null, diskBytes: null},
    timeBudget: {basis: 'per_trial', valueMs: 180000},
  };
  const nativeRows = native.trials.map(row => ({...trial(row), cohort: native.cohort}));
  const result = reduceComparison(native, nativeRows);
  assert.equal(result.denominators.plannedTrials, 2);
  assert.equal(result.byArm.control.timing.unknown, 0);
});

test('rejects invalid token accounting and unknown billing represented as zero', () => {
  const plan = planFor();
  const rows = completeRows(plan);
  assert.throws(() => reduceComparison(plan, [{...rows[0], tokens: {input: 1, cachedInput: 2, output: 0}}, rows[1]]), /cachedInput/);
  assert.throws(() => reduceComparison(plan, [{...rows[0], billing: {actualBilledUsd: 0, source: 'unknown'}}, rows[1]]), /unknown billing/);
});

test('retains infrastructure failures in denominators and allows null timing', () => {
  const plan = planFor();
  const rows = completeRows(plan);
  rows[0].infrastructureError = {stage: 'startup', code: 'IMAGE_UNAVAILABLE', message: 'image was unavailable'};
  rows[0].timing.valueMs = null;
  const result = reduceComparison(plan, rows);
  assert.equal(result.denominators.infrastructureErrors, 1);
  assert.equal(result.byArm.control.infrastructureErrors, 1);
  assert.equal(result.byArm.control.timing.measured, 0);
  assert.equal(result.byArm.control.timing.unknown, 1);
  assert.equal(result.byArm.control.timing.observedSubtotalMs, null);
  assert.equal(result.byArm.control.timing.totalMs, null);
  assert.equal(result.pairs[0].deltas.timingMs, null);
});

test('rejects unsafe arm identifiers before using them as summary keys', () => {
  const plan = planFor('agent');
  plan.comparison.armOrder = ['__proto__', 'qq'];
  plan.trials[0].arm = '__proto__';
  plan.trials[0].trialId = 'task-1.r1.__proto__';
  assert.throws(() => reduceComparison(plan, completeRows(plan)), /safe arm identifier/);
});

test('CLI refuses to overwrite an existing summary output', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'jev-cross-agent-'));
  try {
    const plan = planFor();
    const planPath = join(directory, 'plan.json');
    const trialsPath = join(directory, 'trials.jsonl');
    const outputPath = join(directory, 'summary.json');
    await writeFile(planPath, JSON.stringify(plan));
    await writeFile(trialsPath, completeRows(plan).map(row => JSON.stringify(row)).join('\n') + '\n');
    await writeFile(outputPath, '{"sentinel":true}\n');
    const script = fileURLToPath(new URL('../compare.mjs', import.meta.url));
    const result = spawnSync(process.execPath, [script, '--plan', planPath, '--trials', trialsPath, '--out', outputPath], {encoding: 'utf8'});
    assert.notEqual(result.status, 0);
    assert.match(`${result.stderr}${result.stdout}`, /EEXIST|already exists|file exists/i);
    assert.equal(await readFile(outputPath, 'utf8'), '{"sentinel":true}\n');
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});
