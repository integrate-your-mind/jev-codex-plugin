#!/usr/bin/env node
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {reduceComparison, stableStringify} from './compare.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const resultRoot = join(root, 'benchmarks/results/2026-09-26-paired-v1');
const hash = value => createHash('sha256').update(value).digest('hex');

// Normalize only public, whitelisted fields. This does not change the original
// frozen plan or pretend the generic format existed before this pilot ran.
export function normalizePaired({plan, summary, tasks, provenance}) {
  assert.equal(plan.schemaVersion, 'paired-codex-v1');
  assert.equal(summary.schemaVersion, 'paired-codex-summary-v1');
  assert.equal(tasks.schemaVersion, 'paired-codex-v1');
  assert.equal(plan.plan.length, summary.trials.length);
  assert.equal(new Set(summary.trials.map(row => row.trialId)).size, summary.trials.length);
  assert.ok(provenance.codexVersion && provenance.installedVersion);
  const taskMap = new Map(tasks.tasks.map(task => [task.id, task]));
  const sourceRows = new Map(summary.trials.map(row => [row.trialId, row]));
  const cohort = {
    datasetFingerprint: `sha256:${plan.artifacts.tasksSha256}`,
    harnessFingerprint: `sha256:${plan.artifacts.runnerSha256}`,
    imageFingerprint: null,
    environmentMode: 'native_shared',
    timeBudget: {basis: 'per_turn', valueMs: plan.timeoutMs},
    resourceBudget: {cpuMs: null, memoryBytes: null, diskBytes: null},
    networkPolicy: {mode: 'workspace-write-network-enabled-both-arms'},
  };
  const planned = plan.plan.map(entry => {
    const row = sourceRows.get(entry.trialId);
    assert.ok(row, `Missing public row: ${entry.trialId}`);
    for (const field of ['taskId', 'repeat', 'arm']) assert.equal(row[field], entry[field]);
    assert.ok(['baseline', 'treatment'].includes(entry.arm));
    const task = taskMap.get(entry.taskId);
    assert.ok(task, `Unknown source task: ${entry.taskId}`);
    const enabled = entry.arm === 'treatment';
    return {
      trialId: entry.trialId,
      taskId: entry.taskId,
      inputHash: `sha256:${hash(stableStringify({task, graderSha256: plan.artifacts.graderSha256}))}`,
      repetition: entry.repeat,
      arm: enabled ? 'treatment' : 'control',
      plannedIdentity: {
        agent: 'codex-app-server', agentVersion: provenance.codexVersion,
        model: row.model, effort: row.effort,
        provider: 'codex-default-unresolved',
        pluginEnabled: enabled, pluginVersion: enabled ? provenance.installedVersion : null,
      },
    };
  });
  const normalizedPlan = {
    schemaVersion: 'jev-cross-agent-comparison-plan-v1',
    comparison: {factor: 'treatment', cohortId: '2026-09-26-paired-v1', armOrder: ['control', 'treatment'], timingMetric: 'agent_turn_sum_ms'},
    cohort,
    trials: planned,
  };
  const rows = planned.map(entry => {
    const source = sourceRows.get(entry.trialId);
    assert.equal(source.failure, null, 'This adapter currently accepts the completed pilot only');
    assert.equal(typeof source.artifactPassed, 'boolean');
    assert.equal(typeof source.agentTurnSuccess, 'boolean');
    return {
      schemaVersion: 'jev-cross-agent-trial-v1', ...entry,
      observedIdentity: {...entry.plannedIdentity},
      cohort,
      artifactVerifier: {status: source.artifactPassed ? 'passed' : 'failed', passed: source.artifactPassed},
      agentCompletion: {status: source.agentTurnSuccess ? 'completed' : 'failed', completed: source.agentTurnSuccess},
      timing: {metric: 'agent_turn_sum_ms', valueMs: source.turnMs},
      tokens: {input: source.usage?.inputTokens ?? null, cachedInput: source.usage?.cachedInputTokens ?? null, output: source.usage?.outputTokens ?? null},
      billing: {actualBilledUsd: null, source: 'unknown'},
      infrastructureError: null,
    };
  });
  const comparison = reduceComparison(normalizedPlan, rows);
  for (const pair of comparison.pairs) {
    const original = summary.pairs.find(item => item.taskId === pair.taskId && item.repeat === pair.repetition);
    assert.ok(original);
    assert.ok(Math.abs(pair.deltas.timingMs - original.deltaMs) < 1e-6);
  }
  return {plan: normalizedPlan, rows, comparison};
}

export async function exportNormalized(output) {
  const paths = {
    plan: join(resultRoot, 'plan.json'), summary: join(resultRoot, 'summary.json'),
    provenance: join(resultRoot, 'runtime-provenance.json'),
    tasks: join(root, 'source/jev-workflows/benchmarks/paired-v1/tasks.json'),
    grader: join(root, 'source/jev-workflows/benchmarks/paired-v1/grade.mjs'),
    normalizer: fileURLToPath(import.meta.url),
    reducer: fileURLToPath(new URL('./compare.mjs', import.meta.url)),
  };
  const bytes = Object.fromEntries(await Promise.all(Object.entries(paths).map(async ([name, path]) => [name, await readFile(path)])));
  const input = Object.fromEntries(['plan', 'summary', 'provenance', 'tasks'].map(name => [name, JSON.parse(bytes[name])]));
  assert.equal(hash(bytes.tasks), input.plan.artifacts.tasksSha256, 'Source tasks drifted');
  assert.equal(hash(bytes.grader), input.plan.artifacts.graderSha256, 'Grader drifted');
  const normalized = normalizePaired(input);
  const files = {
    'plan.json': JSON.stringify(normalized.plan, null, 2) + '\n',
    'trials.jsonl': normalized.rows.map(row => JSON.stringify(row)).join('\n') + '\n',
    'comparison.json': JSON.stringify(normalized.comparison, null, 2) + '\n',
  };
  const manifest = {
    schemaVersion: 'paired-normalization-v1',
    status: 'posthoc-format-translation-of-original-prefrozen-plan',
    sourceHashes: Object.fromEntries(Object.entries(bytes).map(([name, value]) => [name, hash(value)])),
    files: Object.fromEntries(Object.entries(files).map(([name, value]) => [name, hash(value)])),
    limitations: [
      'Provider route is unresolved; codex-default-unresolved is an explicit unknown label, not a verified provider ID.',
      'The source run used a shared native host without enforced CPU, memory, or disk budgets and no container image.',
      'This generic format was produced after the run. The original source plan and its timestamp are retained separately.',
      'Observed model/effort and hook isolation were checked by the source runner; normalization does not rerun those checks.',
      'No new inference, billing reconciliation, or causal estimate is performed.',
    ],
  };
  await mkdir(output, {recursive: false});
  for (const [name, contents] of Object.entries(files)) await writeFile(join(output, name), contents, {flag: 'wx', mode: 0o644});
  await writeFile(join(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', {flag: 'wx', mode: 0o644});
  return normalized.comparison;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    assert.equal(process.argv.length, 3, 'Usage: node normalize-paired.mjs /absolute/new/output');
    const summary = await exportNormalized(resolve(process.argv[2]));
    console.log(JSON.stringify({plannedTrials: summary.denominators.plannedTrials, pairs: summary.denominators.pairs}));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
