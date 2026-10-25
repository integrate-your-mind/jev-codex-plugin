#!/usr/bin/env node
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {dirname, join, relative, resolve, sep} from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {fileURLToPath, pathToFileURL} from 'node:url';

import {
  BASE_COMMIT,
  EXPECTED_PLUGIN_RUNTIME_VERSION,
  EXPECTED_PROVIDER_ENDPOINT,
  EXPECTED_PROVIDER_MODEL,
  PATCH_SHA256,
  hashFile,
  hashTree,
  publicationRoot,
  sha256,
  verifyMaterializedVariants,
} from './source-integrity.mjs';

const dir = dirname(fileURLToPath(import.meta.url));
const caseIds = ['candidate-normal', 'candidate-conflict', 'candidate-stale', 'candidate-adversarial'];
const arms = ['control-released', 'candidate-bundled-repair'];
const fileGroups = Object.freeze({
  inputs: [
    'benchmarks/plugin-development/cases/inputs.json',
    'benchmarks/plugin-development/cases/oracle.json',
    'benchmarks/plugin-development/experiment/schedule.json',
  ],
  runner: [
    'benchmarks/plugin-development/experiment/adapter.mjs',
    'benchmarks/plugin-development/experiment/freeze.mjs',
    'benchmarks/plugin-development/experiment/live-gate.mjs',
    'benchmarks/plugin-development/experiment/live-run.mjs',
    'benchmarks/plugin-development/experiment/run-attempt.mjs',
    'benchmarks/plugin-development/experiment/source-integrity.mjs',
  ],
  fixtureEngine: [
    'benchmarks/plugin-development/cases/action-worker.mjs',
    'benchmarks/plugin-development/cases/fixture-engine.mjs',
  ],
  dependencies: [
    'source/jev-workflows/package.json',
    'source/jev-workflows/package-lock.json',
    'source/jev-workflows/RELEASE.json',
  ],
});

function portable(path) {
  return relative(publicationRoot, path).split(sep).join('/');
}

async function describeFile(path) {
  return {path, ...await hashFile(join(publicationRoot, path))};
}

async function loadSchedule() {
  return JSON.parse(await readFile(join(dir, 'schedule.json'), 'utf8'));
}

export function validateSchedule(schedule) {
  assert.equal(schedule.schemaVersion, 'plugin-development-candidate-delivery-schedule-v1');
  assert.deepEqual(schedule.caseIds, caseIds);
  assert.deepEqual(schedule.arms, arms);
  assert.equal(schedule.repeats, 2);
  assert.equal(schedule.attempts.length, 16);
  assert.equal(new Set(schedule.attempts.map(row => row.attemptId)).size, 16);
  assert.deepEqual(schedule.attempts.map(row => row.row), Array.from({length: 16}, (_, index) => index + 1));
  for (const caseId of caseIds) {
    for (const repeat of [1, 2]) {
      const rows = schedule.attempts.filter(row => row.caseId === caseId && row.repeat === repeat);
      assert.deepEqual(new Set(rows.map(row => row.arm)), new Set(arms));
    }
  }
  for (let caseIndex = 0; caseIndex < caseIds.length; caseIndex += 1) {
    const first = schedule.attempts.filter(row => row.caseId === caseIds[caseIndex] && row.repeat === 1).map(row => row.arm);
    const second = schedule.attempts.filter(row => row.caseId === caseIds[caseIndex] && row.repeat === 2).map(row => row.arm);
    assert.deepEqual(second, [...first].reverse(), `arm order was not reversed for ${caseIds[caseIndex]}`);
  }
  return schedule;
}

async function fixtureTrees() {
  return Promise.all(caseIds.map(async caseId => {
    const root = join(publicationRoot, 'benchmarks/plugin-development/cases/fixtures', caseId);
    return {caseId, path: portable(root), ...await hashTree(root)};
  }));
}

export async function buildFreezeManifest() {
  const [schedule, sourceIdentity, fixtures] = await Promise.all([
    loadSchedule().then(validateSchedule),
    verifyMaterializedVariants(),
    fixtureTrees(),
  ]);
  const files = {};
  for (const [group, paths] of Object.entries(fileGroups)) {
    files[group] = await Promise.all(paths.map(describeFile));
  }
  const frozen = {
    schemaVersion: 'plugin-development-live-freeze-v1',
    review: {status: 'unreviewed'},
    experiment: {
      component: 'bundled-candidate-delivery-question-context-repair',
      causalBoundary: 'The patch bundles candidate delivery, catalog-aligned questioning, context projection, and validation changes; no individual effect is assigned.',
      caseIds,
      repeats: 2,
      arms,
      scheduledRows: schedule.attempts.length,
      providerCalls: true,
      oraclePassedToProvider: false,
      actionSource: 'only an assessed candidate actually delivered by runDecisionHook and validated against the authored available catalog',
      postconditionSource: 'independent authored fixture-engine oracle after the sandboxed action',
      componentScope: 'All four authored cases are normalized into PreToolUse runDecisionHook events with a supplied catalog. Original native_hook and explicit_mcp labels are retained as provenance; MCP invocation and native catalog discovery are not exercised.',
    },
    providerContract: {
      endpoint: EXPECTED_PROVIDER_ENDPOINT,
      expectedResponseModelVersion: EXPECTED_PROVIDER_MODEL,
      expectedPluginRuntimeVersion: EXPECTED_PLUGIN_RUNTIME_VERSION,
      driftRule: 'Compare the exact response.model string with expectedResponseModelVersion and retain the actual response on mismatch.',
    },
    runtime: {
      node: 'v22.23.2',
      typescriptLoader: 'source/jev-workflows/node_modules/tsx/dist/loader.mjs',
      sourceMaterialization: 'git archive of exact base, followed by the exact verified patch for candidate arm; shared dependencies are linked only inside disposable runtime directories',
    },
    sourceIdentity: {
      baseCommit: BASE_COMMIT,
      patchSha256: PATCH_SHA256,
      verifiedPatch: sourceIdentity.patch,
      trees: sourceIdentity.trees,
    },
    files,
    fixtureTrees: fixtures,
  };
  return {...frozen, frozenContentSha256: sha256(JSON.stringify(frozen))};
}

export async function verifyFrozenContent(manifest) {
  if (!manifest || manifest.schemaVersion !== 'plugin-development-live-freeze-v1') throw new Error('unsupported live manifest');
  if (manifest.sourceIdentity?.baseCommit !== BASE_COMMIT || manifest.sourceIdentity?.patchSha256 !== PATCH_SHA256) {
    throw new Error('manifest source identity mismatch');
  }
  const expected = await buildFreezeManifest();
  const observed = structuredClone(manifest);
  observed.review = {status: 'unreviewed'};
  if (!isDeepStrictEqual(observed, expected)) {
    const mismatchedGroups = [];
    if (!isDeepStrictEqual(observed.sourceIdentity, expected.sourceIdentity)) mismatchedGroups.push('source');
    if (!isDeepStrictEqual(observed.files?.inputs, expected.files.inputs)) mismatchedGroups.push('input-or-schedule');
    if (!isDeepStrictEqual(observed.files?.runner, expected.files.runner)) mismatchedGroups.push('runner');
    if (!isDeepStrictEqual(observed.files?.fixtureEngine, expected.files.fixtureEngine) || !isDeepStrictEqual(observed.fixtureTrees, expected.fixtureTrees)) mismatchedGroups.push('fixture');
    if (!isDeepStrictEqual(observed.files?.dependencies, expected.files.dependencies)) mismatchedGroups.push('dependencies');
    throw new Error(`frozen manifest drift: ${mismatchedGroups.join(',') || 'metadata'}`);
  }
  return {manifest, schedule: await loadSchedule().then(validateSchedule)};
}

async function main() {
  const manifest = await buildFreezeManifest();
  process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
