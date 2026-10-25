#!/usr/bin/env node
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile, writeFile} from 'node:fs/promises';
import {dirname, join, relative, resolve, sep} from 'node:path';
import {fileURLToPath} from 'node:url';

const dir = dirname(fileURLToPath(import.meta.url));
const repo = resolve(dir, '..', '..', '..');
const defaultSource = join(repo, 'source/jev-workflows');
const requiredNodeVersion = 'v22.23.2';
const selectionRulePath = join(repo, 'benchmarks/plugin-value/development-selection.md');
const selectionRuleSha256 = '7e6c99fe0d28eaf4d50cd4d94578ea32d65ecb4e630742e672f41efee47a7681';
const clusters = ['normal', 'conflicting-or-insufficient', 'stale-invalid', 'adversarial'];
const sourcePaths = [
  'package.json',
  'src/service.ts',
  'src/batch.ts',
  'src/provider.ts',
  'src/contracts.ts',
  'src/redact.ts',
  'src/store.ts',
  'src/policy.ts',
  'src/credential.ts',
];
const harnessPaths = ['freeze.mjs', 'grader.mjs', 'run.mjs'];

export function hash(value) {
  return createHash('sha256').update(Buffer.isBuffer(value) ? value : typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
}

function forbiddenTruthKey(value, path = []) {
  if (!value || typeof value !== 'object') return null;
  for (const [key, child] of Object.entries(value)) {
    if (/expected|oracle|truth|answer.?key|correct.?choice/i.test(key)) return [...path, key].join('.');
    const nested = forbiddenTruthKey(child, [...path, key]);
    if (nested) return nested;
  }
  return null;
}

export function validateTruthBoundary(inputs, oracle) {
  assert.equal(inputs.schemaVersion, 'jev-batch-component-inputs-v1');
  assert.equal(oracle.schemaVersion, 'jev-batch-component-oracle-v1');
  assert.equal(inputs.cases.length, 4, 'exactly four cases required');
  assert.equal(oracle.cases.length, 4, 'exactly four oracle rows required');
  assert.equal(forbiddenTruthKey(inputs), null, 'truth-shaped key leaked into provider fixtures');
  assert.ok(typeof oracle.oracleMarker === 'string' && oracle.oracleMarker.length > 12, 'oracle marker required');
  assert.equal(JSON.stringify(inputs).includes(oracle.oracleMarker), false, 'oracle marker leaked into provider fixtures');
  const oracleByCase = new Map(oracle.cases.map(entry => [entry.caseId, entry]));
  const seen = new Set();
  for (const [index, fixture] of inputs.cases.entries()) {
    assert.equal(fixture.cluster, clusters[index], `${fixture.id}: cluster/order mismatch`);
    assert.ok(/^[a-z0-9][a-z0-9-]{2,79}$/.test(fixture.id) && !seen.has(fixture.id), `${fixture.id}: invalid or duplicate id`);
    seen.add(fixture.id);
    assert.deepEqual(fixture.policy, {mode: 'conservative', minConfidence: 0.6, minProbability: 0.6}, `${fixture.id}: fixed policy mismatch`);
    const entries = Object.entries(fixture.questions);
    assert.equal(entries.length, 3, `${fixture.id}: exactly three independent questions required`);
    assert.deepEqual(entries.map(([, question]) => question.type).sort(), ['choice', 'noul', 'score']);
    const choice = entries.find(([, question]) => question.type === 'choice')?.[1];
    assert.ok(choice.candidates.some(candidate => candidate.id === 'no_fit'), `${fixture.id}: no_fit candidate missing`);
    assert.ok(choice.candidates.every(candidate => candidate.id !== 'insufficient_evidence'), `${fixture.id}: reserved provider abstention used as caller candidate`);
    const truth = oracleByCase.get(fixture.id);
    assert.ok(truth, `${fixture.id}: missing oracle row`);
    assert.deepEqual(Object.keys(truth.questions).sort(), Object.keys(fixture.questions).sort(), `${fixture.id}: oracle question mismatch`);
    const actionTruth = truth.questions.action;
    const candidateIds = new Set(choice.candidates.filter(candidate => candidate.available !== false).map(candidate => candidate.id));
    assert.ok(actionTruth.expectedProviderChoice === 'insufficient_evidence' || candidateIds.has(actionTruth.expectedProviderChoice), `${fixture.id}: oracle choice not in provider domain`);
    assert.ok(['recommendation', 'abstained'].includes(actionTruth.expectedDisposition), `${fixture.id}: invalid expected disposition`);
    if (actionTruth.expectedDisposition === 'abstained') assert.equal(actionTruth.expectedRecommendation, null, `${fixture.id}: abstention cannot deliver a recommendation`);
    else assert.ok(candidateIds.has(actionTruth.expectedRecommendation), `${fixture.id}: expected recommendation not in caller candidates`);
    for (const expected of Object.values(truth.questions)) {
      if (expected.type === 'choice') continue;
      assert.equal(expected.rangeKind, 'authored_not_calibrated', `${fixture.id}: numeric range must be labeled authored and uncalibrated`);
      assert.ok(Number.isFinite(expected.min) && Number.isFinite(expected.max) && expected.min <= expected.max, `${fixture.id}: invalid authored numeric range`);
    }
  }
  assert.deepEqual([...oracleByCase.keys()].sort(), [...seen].sort(), 'oracle contains unknown case');
}

export function buildSchedule(inputs) {
  const attempts = [];
  for (let repeat = 1; repeat <= 2; repeat += 1) {
    inputs.cases.forEach((fixture, index) => {
      const serialFirst = ((index + repeat) % 2) === 1;
      const order = serialFirst ? ['serial', 'batch'] : ['batch', 'serial'];
      for (const arm of order) attempts.push({
        attemptId: `${fixture.id}.r${repeat}.${arm}`,
        caseId: fixture.id,
        cluster: fixture.cluster,
        repeat,
        arm,
        expectedProviderRequests: arm === 'serial' ? Object.keys(fixture.questions).length : 1,
      });
    });
  }
  return {
    schemaVersion: 'jev-batch-component-schedule-v1',
    repeats: 2,
    arms: ['serial', 'batch'],
    attempts,
  };
}

async function fileRecords(root, paths) {
  return Promise.all(paths.map(async path => {
    const bytes = await readFile(join(root, path));
    return {path: path.split(sep).join('/'), bytes: bytes.length, sha256: hash(bytes)};
  }));
}

export async function buildFreeze({sourceRoot = defaultSource, write = false, enforceRuntime = true} = {}) {
  if (enforceRuntime && process.version !== requiredNodeVersion) throw new Error(`freeze requires Node ${requiredNodeVersion}; found ${process.version}`);
  sourceRoot = resolve(sourceRoot);
  const [inputsBytes, oracleBytes] = await Promise.all([
    readFile(join(dir, 'inputs.json')),
    readFile(join(dir, 'oracle/oracle.json')),
  ]);
  const inputs = JSON.parse(inputsBytes);
  const oracle = JSON.parse(oracleBytes);
  validateTruthBoundary(inputs, oracle);
  const schedule = buildSchedule(inputs);
  const scheduleText = `${JSON.stringify(schedule, null, 2)}\n`;
  if (write) await writeFile(join(dir, 'schedule.json'), scheduleText);
  else assert.deepEqual(JSON.parse(await readFile(join(dir, 'schedule.json'), 'utf8')), schedule, 'schedule freeze mismatch');
  const [sourceFiles, harnessFiles, packageJson, contractsText, selectionRuleBytes] = await Promise.all([
    fileRecords(sourceRoot, sourcePaths),
    fileRecords(dir, harnessPaths),
    readFile(join(sourceRoot, 'package.json'), 'utf8').then(JSON.parse),
    readFile(join(sourceRoot, 'src/contracts.ts'), 'utf8'),
    readFile(selectionRulePath),
  ]);
  assert.equal(hash(selectionRuleBytes), selectionRuleSha256, 'accepted development selection rule changed');
  const model = contractsText.match(/export const MODEL = '([^']+)'/)?.[1];
  assert.ok(model, 'provider model constant unavailable');
  const questionCount = inputs.cases.reduce((sum, fixture) => sum + Object.keys(fixture.questions).length, 0);
  const serialRequests = questionCount * schedule.repeats;
  const batchRequests = inputs.cases.length * schedule.repeats;
  const providerProjection = inputs.cases.map(fixture => ({state: fixture.state, questions: fixture.questions, policy: fixture.policy}));
  const freeze = {
    schemaVersion: 'jev-batch-component-freeze-v1',
    cohort: 'batch-component-authored-v1',
    reviewStatus: 'pending_root_review',
    liveGate: 'Pass --live, set JEV_RUN_LIVE_BATCH_BENCHMARK=1, and pass --reviewed-freeze-sha equal to this freeze file SHA-256.',
    caseCount: inputs.cases.length,
    questionCount,
    repeats: schedule.repeats,
    plannedAttempts: schedule.attempts.length,
    plannedProviderRequests: {serial: serialRequests, batch: batchRequests, total: serialRequests + batchRequests},
    inputSha256: hash(inputsBytes),
    oracleSha256: hash(oracleBytes),
    scheduleSha256: hash(Buffer.from(scheduleText)),
    providerProjectionSha256: hash(providerProjection),
    pluginVersion: packageJson.version,
    providerModel: model,
    requiredNodeVersion,
    selectionRule: {
      path: 'benchmarks/plugin-value/development-selection.md',
      sha256: selectionRuleSha256,
    },
    sourceRoot: 'source/jev-workflows',
    sourceFiles,
    sourceCombinedSha256: hash(sourceFiles),
    harnessFiles,
    harnessCombinedSha256: hash(harnessFiles),
    truthBoundary: 'Oracle content is used only for freeze validation and post-operation code grading. It is never included in service input or provider transport.',
    claimBoundary: 'This classifier-only component ablation executes no action and measures no independently verified task/action benefit. It does not test native automatic Codex behavior and cannot by itself support a positive task-quality claim.',
  };
  if (write) await writeFile(join(dir, 'freeze.json'), `${JSON.stringify(freeze, null, 2)}\n`);
  return freeze;
}

async function main() {
  const args = process.argv.slice(2);
  const write = args.includes('--write');
  const sourceAt = args.indexOf('--source');
  const sourceRoot = sourceAt >= 0 ? args[sourceAt + 1] : defaultSource;
  if (sourceAt >= 0 && !sourceRoot) throw new Error('--source requires a path');
  const freeze = await buildFreeze({sourceRoot, write});
  process.stdout.write(`${JSON.stringify({ok: true, write, ...freeze})}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { process.stderr.write(`${error?.message ?? error}\n`); process.exitCode = 1; });
}
