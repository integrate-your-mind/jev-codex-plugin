#!/usr/bin/env node
import {readFile, writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';

export const PLAN_SCHEMA_VERSION = 'jev-cross-agent-comparison-plan-v1';
export const TRIAL_SCHEMA_VERSION = 'jev-cross-agent-trial-v1';
export const SUMMARY_SCHEMA_VERSION = 'jev-cross-agent-comparison-summary-v1';

const FACTORS = new Set(['agent', 'treatment']);
const TREATMENT_ARMS = new Set(['control', 'treatment']);
const TIMING_METRICS = new Set(['agent_turn_wall_ms', 'agent_turn_sum_ms']);
const TIME_BUDGET_BASES = new Set(['per_turn', 'per_trial']);
const SAFE_ARM = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;
const ARTIFACT_STATUSES = new Set(['passed', 'failed', 'not_run', 'error']);
const COMPLETION_STATUSES = new Set(['completed', 'failed', 'timeout', 'cancelled', 'not_run', 'error']);

export class ComparisonValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ComparisonValidationError';
  }
}

function fail(message) {
  throw new ComparisonValidationError(message);
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyString(value, name) {
  if (typeof value !== 'string' || value.length === 0) fail(`${name} must be a non-empty string`);
  return value;
}

function integer(value, name, {min = 0} = {}) {
  if (!Number.isSafeInteger(value) || value < min) fail(`${name} must be an integer >= ${min}`);
  return value;
}

function finiteNumber(value, name, {min = 0} = {}) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min) fail(`${name} must be a finite number >= ${min}`);
  return value;
}

// Stable serialization makes cohort and identity comparisons independent of
// property insertion order while retaining array order.
export function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (isObject(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function equal(a, b) {
  return stableStringify(a) === stableStringify(b);
}

function requireObject(value, name) {
  if (!isObject(value)) fail(`${name} must be an object`);
  return value;
}

function validateFingerprint(value, name) {
  nonEmptyString(value, name);
  if (value.length > 300) fail(`${name} is too long`);
}

function validateNetworkPolicy(value, name) {
  requireObject(value, name);
  nonEmptyString(value.mode, `${name}.mode`);
  if (value.allowlistFingerprint !== undefined) validateFingerprint(value.allowlistFingerprint, `${name}.allowlistFingerprint`);
}

function validateCohort(value, name = 'cohort') {
  requireObject(value, name);
  validateFingerprint(value.datasetFingerprint, `${name}.datasetFingerprint`);
  validateFingerprint(value.harnessFingerprint, `${name}.harnessFingerprint`);
  if (value.imageFingerprint !== null) validateFingerprint(value.imageFingerprint, `${name}.imageFingerprint`);
  if (!new Set(['native_shared', 'container']).has(value.environmentMode)) fail(`${name}.environmentMode must be native_shared or container`);
  if (!isObject(value.timeBudget) || !TIME_BUDGET_BASES.has(value.timeBudget.basis)) fail(`${name}.timeBudget must declare per_turn or per_trial basis`);
  if (value.timeBudget.valueMs !== null) integer(value.timeBudget.valueMs, `${name}.timeBudget.valueMs`, {min: 1});
  const resources = requireObject(value.resourceBudget, `${name}.resourceBudget`);
  for (const field of ['cpuMs', 'memoryBytes', 'diskBytes']) if (resources[field] !== null) integer(resources[field], `${name}.resourceBudget.${field}`, {min: 1});
  validateNetworkPolicy(value.networkPolicy, `${name}.networkPolicy`);
  return value;
}

function validateModelIdentity(value, name) {
  const identity = requireObject(value, name);
  nonEmptyString(identity.agent, `${name}.agent`);
  nonEmptyString(identity.agentVersion, `${name}.agentVersion`);
  nonEmptyString(identity.model, `${name}.model`);
  nonEmptyString(identity.provider, `${name}.provider`);
  nonEmptyString(identity.effort, `${name}.effort`);
  if (identity.pluginEnabled !== undefined && typeof identity.pluginEnabled !== 'boolean') fail(`${name}.pluginEnabled must be boolean`);
  if (identity.pluginVersion !== undefined && identity.pluginVersion !== null) nonEmptyString(identity.pluginVersion, `${name}.pluginVersion`);
  return identity;
}

function validatePlanTrial(value, index, factor) {
  const name = `plan.trials[${index}]`;
  const trial = requireObject(value, name);
  nonEmptyString(trial.trialId, `${name}.trialId`);
  nonEmptyString(trial.taskId, `${name}.taskId`);
  nonEmptyString(trial.inputHash, `${name}.inputHash`);
  integer(trial.repetition, `${name}.repetition`, {min: 1});
  nonEmptyString(trial.arm, `${name}.arm`);
  if (!SAFE_ARM.test(trial.arm)) fail(`${name}.arm is not a safe arm identifier`);
  validateModelIdentity(trial.plannedIdentity, `${name}.plannedIdentity`);
  if (trial.plannedIdentity.pluginEnabled === undefined) fail(`${name}.plannedIdentity.pluginEnabled is required`);
  if (factor === 'treatment') {
    if (!TREATMENT_ARMS.has(trial.arm)) fail(`${name}.arm must be control or treatment for a treatment comparison`);
    const expectedEnabled = trial.arm === 'treatment';
    if (trial.plannedIdentity.pluginEnabled !== expectedEnabled) fail(`${name} treatment state leaks across arm`);
    if (expectedEnabled && !trial.plannedIdentity.pluginVersion) fail(`${name}.plannedIdentity.pluginVersion is required for treatment`);
    if (!expectedEnabled && trial.plannedIdentity.pluginVersion !== null) fail(`${name}.control must not carry a plugin version`);
  }
  return trial;
}

export function validatePlan(plan) {
  requireObject(plan, 'plan');
  if (plan.schemaVersion !== PLAN_SCHEMA_VERSION) fail(`plan.schemaVersion must be ${PLAN_SCHEMA_VERSION}`);
  const comparison = requireObject(plan.comparison, 'plan.comparison');
  if (!FACTORS.has(comparison.factor)) fail('plan.comparison.factor must be agent or treatment');
  if (typeof comparison.cohortId !== 'string' || comparison.cohortId.length === 0) fail('plan.comparison.cohortId must be a non-empty string');
  if (!Array.isArray(comparison.armOrder) || comparison.armOrder.length !== 2 || new Set(comparison.armOrder).size !== 2 || comparison.armOrder.some(value => typeof value !== 'string' || !SAFE_ARM.test(value))) fail('plan.comparison.armOrder must list exactly two safe arm identifiers');
  if (!TIMING_METRICS.has(comparison.timingMetric)) fail('plan.comparison.timingMetric is invalid');
  if (comparison.factor === 'treatment' && stableStringify(comparison.armOrder) !== stableStringify(['control', 'treatment'])) fail('treatment comparisons require armOrder [control,treatment]');
  if (!Array.isArray(plan.trials) || plan.trials.length === 0) fail('plan.trials must be a non-empty array');
  validateCohort(plan.cohort, 'plan.cohort');
  const ids = new Set();
  const taskRepeats = new Map();
  for (let index = 0; index < plan.trials.length; index += 1) {
    const trial = validatePlanTrial(plan.trials[index], index, comparison.factor);
    if (ids.has(trial.trialId)) fail(`duplicate planned trialId: ${trial.trialId}`);
    ids.add(trial.trialId);
    const key = `${trial.taskId}\0${trial.inputHash}\0${trial.repetition}`;
    const arms = taskRepeats.get(key) ?? new Set();
    if (arms.has(trial.arm)) fail(`duplicate planned arm for ${key}: ${trial.arm}`);
    arms.add(trial.arm);
    taskRepeats.set(key, arms);
    if (!comparison.armOrder.includes(trial.arm)) fail(`trial arm is absent from comparison.armOrder: ${trial.arm}`);
  }
  for (const [key, arms] of taskRepeats) {
    if (arms.size !== 2) fail(`each task/repetition must have exactly two arms: ${key}`);
  }
  if (comparison.factor === 'treatment') {
    const fixedIdentity = plan.trials[0].plannedIdentity;
    for (const trial of plan.trials) {
      for (const field of ['agent', 'agentVersion', 'model', 'provider', 'effort']) {
        if (trial.plannedIdentity[field] !== fixedIdentity[field]) fail(`treatment cohort mixes ${field} identities`);
      }
    }
  }
  return plan;
}

function validateOutcome(value, name) {
  const outcome = requireObject(value, name);
  if (!ARTIFACT_STATUSES.has(outcome.status)) fail(`${name}.status is invalid`);
  if (typeof outcome.passed !== 'boolean' && outcome.passed !== null) fail(`${name}.passed must be boolean or null`);
  if (outcome.status === 'passed' && outcome.passed !== true) fail(`${name}.passed must be true when status is passed`);
  if (outcome.status === 'failed' && outcome.passed !== false) fail(`${name}.passed must be false when status is failed`);
  if ((outcome.status === 'not_run' || outcome.status === 'error') && outcome.passed !== null) fail(`${name}.passed must be null when status is ${outcome.status}`);
}

function validateCompletion(value, name) {
  const completion = requireObject(value, name);
  if (!COMPLETION_STATUSES.has(completion.status)) fail(`${name}.status is invalid`);
  if (typeof completion.completed !== 'boolean') fail(`${name}.completed must be boolean`);
  if (completion.completed !== (completion.status === 'completed')) fail(`${name}.completed disagrees with status`);
}

function validateTrial(value, index, plan) {
  const name = `trial[${index}]`;
  const trial = requireObject(value, name);
  if (trial.schemaVersion !== TRIAL_SCHEMA_VERSION) fail(`${name}.schemaVersion must be ${TRIAL_SCHEMA_VERSION}`);
  for (const field of ['trialId', 'taskId', 'inputHash', 'arm']) nonEmptyString(trial[field], `${name}.${field}`);
  integer(trial.repetition, `${name}.repetition`, {min: 1});
  validateModelIdentity(trial.plannedIdentity, `${name}.plannedIdentity`);
  validateModelIdentity(trial.observedIdentity, `${name}.observedIdentity`);
  validateCohort(trial.cohort, `${name}.cohort`);
  validateOutcome(trial.artifactVerifier, `${name}.artifactVerifier`);
  validateCompletion(trial.agentCompletion, `${name}.agentCompletion`);
  const timing = requireObject(trial.timing, `${name}.timing`);
  if (!TIMING_METRICS.has(timing.metric)) fail(`${name}.timing.metric is invalid`);
  if (timing.valueMs !== null) finiteNumber(timing.valueMs, `${name}.timing.valueMs`);
  const tokens = requireObject(trial.tokens, `${name}.tokens`);
  for (const field of ['input', 'cachedInput', 'output']) if (tokens[field] !== null) integer(tokens[field], `${name}.tokens.${field}`);
  if (tokens.input !== null && tokens.cachedInput !== null && tokens.cachedInput > tokens.input) fail(`${name}.tokens.cachedInput cannot exceed input`);
  const billing = requireObject(trial.billing, `${name}.billing`);
  if (billing.actualBilledUsd !== null) finiteNumber(billing.actualBilledUsd, `${name}.billing.actualBilledUsd`);
  nonEmptyString(billing.source, `${name}.billing.source`);
  if (billing.source === 'unknown' && billing.actualBilledUsd !== null) fail(`${name}.unknown billing must use null actualBilledUsd`);
  if (trial.infrastructureError !== null) {
    const error = requireObject(trial.infrastructureError, `${name}.infrastructureError`);
    nonEmptyString(error.stage, `${name}.infrastructureError.stage`);
    nonEmptyString(error.code, `${name}.infrastructureError.code`);
    nonEmptyString(error.message, `${name}.infrastructureError.message`);
  }
  if (trial.timing.metric !== plan.comparison.timingMetric) fail(`${name}.timing.metric does not match frozen plan`);
  const planned = plan.trials.find(entry => entry.trialId === trial.trialId);
  if (!planned) fail(`unexpected trialId: ${trial.trialId}`);
  for (const field of ['taskId', 'inputHash', 'repetition', 'arm']) if (trial[field] !== planned[field]) fail(`${name}.${field} does not match frozen plan`);
  if (!equal(trial.plannedIdentity, planned.plannedIdentity)) fail(`${name}.plannedIdentity does not match frozen plan`);
  if (!equal(trial.cohort, plan.cohort)) fail(`${name}.cohort does not match frozen cohort`);
  if (!equal(trial.observedIdentity, trial.plannedIdentity)) fail(`${name}.observedIdentity does not match planned identity`);
  if (plan.comparison.factor === 'treatment') {
    const expected = trial.arm === 'treatment';
    if (trial.observedIdentity.pluginEnabled !== expected) fail(`${name} treatment leaked across control/treatment arm`);
  }
  return trial;
}

function rate(numerator, denominator) {
  return denominator === 0 ? null : numerator / denominator;
}

function median(values) {
  const sorted = values.filter(value => value !== null).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function numericDelta(left, right) {
  return left === null || right === null ? null : right - left;
}

function summarizeArm(rows, plannedCount, timingMetric) {
  const timing = rows.map(row => row.timing.valueMs).filter(value => value !== null);
  const tokenRows = rows.filter(row => row.tokens.input !== null || row.tokens.cachedInput !== null || row.tokens.output !== null);
  const billingRows = rows.filter(row => row.billing.actualBilledUsd !== null);
  return {
    plannedTrials: plannedCount,
    observedTrials: rows.length,
    infrastructureErrors: rows.filter(row => row.infrastructureError !== null).length,
    artifact: {
      denominator: plannedCount,
      passed: rows.filter(row => row.artifactVerifier.passed === true).length,
      failed: rows.filter(row => row.artifactVerifier.status === 'failed').length,
      notRun: rows.filter(row => row.artifactVerifier.status === 'not_run').length,
      errors: rows.filter(row => row.artifactVerifier.status === 'error').length,
      passRate: rate(rows.filter(row => row.artifactVerifier.passed === true).length, plannedCount),
    },
    agentCompletion: {
      denominator: plannedCount,
      completed: rows.filter(row => row.agentCompletion.completed).length,
      incomplete: rows.filter(row => !row.agentCompletion.completed).length,
      completionRate: rate(rows.filter(row => row.agentCompletion.completed).length, plannedCount),
    },
    timing: {
      metric: timingMetric,
      denominator: plannedCount,
      measured: timing.length,
      unknown: plannedCount - timing.length,
      observedSubtotalMs: timing.length ? timing.reduce((sum, value) => sum + value, 0) : null,
      totalMs: timing.length === plannedCount ? timing.reduce((sum, value) => sum + value, 0) : null,
      medianMs: median(timing),
    },
    tokens: {
      denominator: plannedCount,
      observed: tokenRows.length,
      input: tokenSummary(rows, 'input'),
      cachedInput: tokenSummary(rows, 'cachedInput'),
      output: tokenSummary(rows, 'output'),
      definition: 'cachedInput is a subset of input; it is reported separately and never added to input.',
    },
    billing: {
      denominator: plannedCount,
      known: billingRows.length,
      unknown: plannedCount - billingRows.length,
      observedSubtotalUsd: billingRows.length ? billingRows.reduce((sum, row) => sum + row.billing.actualBilledUsd, 0) : null,
      totalUsd: billingRows.length === plannedCount ? billingRows.reduce((sum, row) => sum + row.billing.actualBilledUsd, 0) : null,
      source: billingRows.length ? 'sum of supplied billed sources' : 'unknown',
    },
  };
}

function tokenSummary(rows, field) {
  const known = rows.filter(row => row.tokens[field] !== null);
  return {
    known: known.length,
    unknown: rows.length - known.length,
    observedSubtotal: known.length ? known.reduce((sum, row) => sum + row.tokens[field], 0) : null,
    total: known.length === rows.length ? known.reduce((sum, row) => sum + row.tokens[field], 0) : null,
  };
}

export function reduceComparison(plan, rows) {
  validatePlan(plan);
  if (!Array.isArray(rows)) fail('trials must be an array');
  const expectedIds = new Set(plan.trials.map(trial => trial.trialId));
  const seen = new Set();
  for (const row of rows) {
    if (!isObject(row)) fail('each trial row must be an object');
    if (seen.has(row.trialId)) fail(`duplicate trialId: ${row.trialId}`);
    seen.add(row.trialId);
  }
  if (rows.length !== plan.trials.length) fail(`trial count mismatch: expected ${plan.trials.length}, received ${rows.length}`);
  for (const id of seen) if (!expectedIds.has(id)) fail(`unexpected trialId: ${id}`);
  for (const id of expectedIds) if (!seen.has(id)) fail(`missing trialId: ${id}`);
  for (let index = 0; index < rows.length; index += 1) validateTrial(rows[index], index, plan);

  const byArm = Object.create(null);
  const planByArm = new Map();
  for (const trial of plan.trials) planByArm.set(trial.arm, (planByArm.get(trial.arm) ?? 0) + 1);
  for (const [arm, plannedCount] of planByArm) byArm[arm] = summarizeArm(rows.filter(row => row.arm === arm), plannedCount, plan.comparison.timingMetric);

  const grouped = new Map();
  for (const row of rows) {
    const key = `${row.taskId}\0${row.inputHash}\0${row.repetition}`;
    const group = grouped.get(key) ?? [];
    group.push(row);
    grouped.set(key, group);
  }
  const pairs = [];
  for (const [key, group] of grouped) {
    if (group.length !== 2) fail(`pair must contain exactly two rows: ${key}`);
    const [left, right] = [...group].sort((a, b) => plan.comparison.armOrder.indexOf(a.arm) - plan.comparison.armOrder.indexOf(b.arm));
    pairs.push({
      taskId: left.taskId,
      inputHash: left.inputHash,
      repetition: left.repetition,
      arms: [left.arm, right.arm],
      observations: {
        [left.arm]: {artifactPassed: left.artifactVerifier.passed, agentCompleted: left.agentCompletion.completed, timingMs: left.timing.valueMs},
        [right.arm]: {artifactPassed: right.artifactVerifier.passed, agentCompleted: right.agentCompletion.completed, timingMs: right.timing.valueMs},
      },
      deltas: {
        timingMs: numericDelta(left.timing.valueMs, right.timing.valueMs),
        artifactPass: left.artifactVerifier.passed === null || right.artifactVerifier.passed === null ? null : Number(right.artifactVerifier.passed) - Number(left.artifactVerifier.passed),
        agentCompletion: Number(right.agentCompletion.completed) - Number(left.agentCompletion.completed),
        inputTokens: numericDelta(left.tokens.input, right.tokens.input),
        cachedInputTokens: numericDelta(left.tokens.cachedInput, right.tokens.cachedInput),
        outputTokens: numericDelta(left.tokens.output, right.tokens.output),
        actualBilledUsd: numericDelta(left.billing.actualBilledUsd, right.billing.actualBilledUsd),
      },
      limitations: [
        'Pair order follows comparison.armOrder; deltas are second arm minus first arm.',
        ...(left.infrastructureError || right.infrastructureError ? ['Infrastructure errors are retained and may make timing or billing deltas null.'] : []),
      ],
    });
  }

  const claim = plan.comparison.factor === 'agent'
    ? 'observational_agent_comparison'
    : 'fixed_model_plugin_delta';
  return {
    schemaVersion: SUMMARY_SCHEMA_VERSION,
    comparedFactor: plan.comparison.factor,
    claim,
    cohortId: plan.comparison.cohortId,
    timingMetric: `${plan.comparison.timingMetric}: ${plan.comparison.timingMetric === 'agent_turn_sum_ms' ? 'sum of per-turn wall-clock durations from dispatch to completion' : 'wall-clock duration from agent turn dispatch to turn completion'}; startup, verifier, and cleanup are excluded.`,
    denominators: {
      plannedTrials: plan.trials.length,
      observedTrials: rows.length,
      pairs: pairs.length,
      infrastructureErrors: rows.filter(row => row.infrastructureError !== null).length,
      artifactOutcomes: Object.fromEntries([...ARTIFACT_STATUSES].map(status => [status, rows.filter(row => row.artifactVerifier.status === status).length])),
      agentCompletionOutcomes: Object.fromEntries([...COMPLETION_STATUSES].map(status => [status, rows.filter(row => row.agentCompletion.status === status).length])),
    },
    byArm,
    pairs,
    interpretation: plan.comparison.factor === 'agent'
      ? 'Descriptive observational comparison of the named agents under this frozen cohort. It does not establish a causal plugin effect or model superiority.'
      : 'Descriptive fixed-agent/model treatment comparison. The treatment claim is limited to the plugin delta under this frozen cohort; it does not establish general productivity or model superiority.',
    inference: 'No significance test, confidence interval, causal estimate, or fabricated cost is produced by this reducer.',
  };
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function readJsonl(path) {
  const text = await readFile(path, 'utf8');
  return text.split(/\r?\n/).map(line => line.trim()).filter(Boolean).map((line, index) => {
    try { return JSON.parse(line); } catch { fail(`invalid JSON at ${path}:${index + 1}`); }
  });
}

function cliArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!['--plan', '--trials', '--out'].includes(key) || !argv[index + 1]) fail('usage: node benchmarks/cross-agent/compare.mjs --plan plan.json --trials trials.jsonl --out summary.json');
    args[key.slice(2)] = resolve(argv[++index]);
  }
  if (!args.plan || !args.trials || !args.out) fail('usage: node benchmarks/cross-agent/compare.mjs --plan plan.json --trials trials.jsonl --out summary.json');
  return args;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  try {
    const args = cliArgs(process.argv.slice(2));
    const summary = reduceComparison(await readJson(args.plan), await readJsonl(args.trials));
    await writeFile(args.out, JSON.stringify(summary, null, 2) + '\n', {mode: 0o600, flag: 'wx'});
    process.stdout.write(JSON.stringify({ok: true, output: args.out, plannedTrials: summary.denominators.plannedTrials, pairs: summary.denominators.pairs}) + '\n');
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
