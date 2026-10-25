import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {normalizePaired} from '../normalize-paired.mjs';

const root = new URL('../../../', import.meta.url);
const load = async path => JSON.parse(await readFile(new URL(path, root), 'utf8'));
async function input() {
  const result = 'benchmarks/results/2026-09-26-paired-v1/';
  return {
    plan: await load(result + 'plan.json'), summary: await load(result + 'summary.json'),
    provenance: await load(result + 'runtime-provenance.json'),
    tasks: await load('source/jev-workflows/benchmarks/paired-v1/tasks.json'),
  };
}

test('actual 16-trial pilot survives agent-neutral normalization without invented billing or resource limits', async () => {
  const data = await input();
  const result = normalizePaired(data);
  assert.equal(result.rows.length, 16);
  assert.equal(result.comparison.denominators.pairs, 8);
  assert.equal(result.comparison.byArm.control.artifact.passed, 8);
  assert.equal(result.comparison.byArm.treatment.artifact.passed, 8);
  assert.equal(result.comparison.byArm.control.tokens.input.total, 715434);
  assert.equal(result.comparison.byArm.treatment.tokens.input.total, 857264);
  assert.equal(result.comparison.byArm.control.billing.totalUsd, null);
  assert.equal(result.plan.cohort.resourceBudget.cpuMs, null);
  assert.equal(result.plan.cohort.imageFingerprint, null);
  assert.ok(result.comparison.pairs.every(pair => pair.deltas.timingMs > 0));
});

test('normalization rejects changed task or model identities and missing results', async () => {
  let data = await input();
  data.summary.trials[0].taskId = 'changed-task';
  assert.throws(() => normalizePaired(data));
  data = await input();
  data.summary.trials[0].model = 'different-model';
  assert.throws(() => normalizePaired(data), /mixes model/);
  data = await input();
  data.summary.trials.pop();
  assert.throws(() => normalizePaired(data));
});

test('published normalized artifacts match the current reducer and recorded hashes', async () => {
  const base = 'benchmarks/cross-agent/normalized-codex-pilot/';
  const actual = normalizePaired(await input());
  assert.deepEqual(JSON.parse(JSON.stringify(actual.comparison)), await load(base + 'comparison.json'));
  const manifest = await load(base + 'manifest.json');
  for (const [name, digest] of Object.entries(manifest.files)) {
    assert.equal(createHash('sha256').update(await readFile(new URL(base + name, root))).digest('hex'), digest);
  }
  for (const [name, file] of [['normalizer', 'normalize-paired.mjs'], ['reducer', 'compare.mjs']]) {
    assert.equal(createHash('sha256').update(await readFile(new URL('benchmarks/cross-agent/' + file, root))).digest('hex'), manifest.sourceHashes[name]);
  }
});
