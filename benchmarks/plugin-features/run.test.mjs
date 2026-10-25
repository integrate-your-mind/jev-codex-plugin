import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {access} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';

const execFileAsync = promisify(execFile);
const benchmarkRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const runner = resolve(benchmarkRoot, 'benchmarks/plugin-features/run.mjs');
const baselineRoot = resolve(benchmarkRoot, 'source/jev-workflows');
const repairedRoot = process.env.JEV_REPAIRED_SOURCE_ROOT;
const tsxLoader = resolve(baselineRoot, 'node_modules/tsx/dist/loader.mjs');
const dependencyLoader = resolve(benchmarkRoot, 'benchmarks/plugin-features/resolve-deps-loader.mjs');

async function exists(path) {
  try { await access(path); return true; } catch { return false; }
}

async function execute(sourceRoot) {
  const result = await execFileAsync(process.execPath, ['--import', tsxLoader, '--experimental-loader', dependencyLoader, runner, '--source-root', sourceRoot], {
    cwd: benchmarkRoot,
    env: {...process.env, JEV_BENCHMARK_NODE_MODULES: resolve(baselineRoot, 'node_modules')},
    maxBuffer: 4 * 1024 * 1024,
  });
  return JSON.parse(result.stdout);
}

test('runner distinguishes baseline defects from repaired behavior without real provider calls', async t => {
  if (!repairedRoot) {
    t.skip('set JEV_REPAIRED_SOURCE_ROOT to run the optional repaired-source comparison');
    return;
  }
  if (!await exists(repairedRoot)) {
    throw new Error(`JEV_REPAIRED_SOURCE_ROOT does not exist: ${repairedRoot}`);
  }
  const [baseline, repaired] = await Promise.all([execute(baselineRoot), execute(repairedRoot)]);
  assert.equal(baseline.providerCalls, false);
  assert.equal(repaired.providerCalls, false);
  assert.equal(baseline.sourceRoot.startsWith('/'), false);
  assert.equal(repaired.sourceRoot.startsWith('/'), false);
  assert.notEqual(baseline.sourceContentSha256, repaired.sourceContentSha256);
  assert.match(baseline.generatedAt, /^20\d\d-\d\d-\d\dT/);
  assert.match(repaired.generatedAt, /^20\d\d-\d\d-\d\dT/);
  assert.equal(baseline.externalFixtures.every(fixture => fixture.observed === false), true);
  assert.equal(repaired.externalFixtures.every(fixture => fixture.observed === false), true);
  assert.equal(baseline.scenarios.every(scenario => scenario.executionPassed), true);
  assert.equal(repaired.scenarios.every(scenario => scenario.executionPassed), true);
  const baselineFailures = baseline.scenarios.filter(scenario => scenario.requirementStatus === 'failed');
  const repairedFailures = repaired.scenarios.filter(scenario => scenario.requirementStatus === 'failed');
  assert.equal(baseline.scenarios.some(scenario => scenario.requirementStatus === 'unknown'), false);
  assert.equal(repaired.scenarios.some(scenario => scenario.requirementStatus === 'unknown'), false);
  assert.ok(repairedFailures.length < baselineFailures.length,
    `repaired source should improve observed feature checks (baseline=${baselineFailures.length}, repaired=${repairedFailures.length})`);
  const baselineById = new Map(baseline.scenarios.map(scenario => [scenario.id, scenario]));
  const repairedById = new Map(repaired.scenarios.map(scenario => [scenario.id, scenario]));
  for (const id of ['candidate-propagation', 'objective-replacement', 'provider-invalid-choice', 'concrete-candidate-advice']) {
    assert.equal(baselineById.get(id)?.requirementSatisfied, false, `${id} should expose the baseline behavior`);
    assert.equal(repairedById.get(id)?.requirementSatisfied, true, `${id} should pass after the source repair`);
  }
  assert.ok(repaired.mockProviderCalls >= 1, 'repaired large-context case must cross the synthetic fetch boundary');
  assert.equal(baseline.mockProviderCalls, 0);
  assert.ok(repaired.serviceInvocations >= repaired.mockProviderCalls);
  const large = repaired.scenarios.find(scenario => scenario.id === 'large-context-schema');
  assert.equal(large?.checks.provider_reached, true);
  assert.equal(large?.checks.hook_context_bounded, true);
  assert.equal(large?.checks.no_secret_egress, true);
});
