import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { DEEPSWE_COMMIT, buildLock, sha256 } from '../cross-agent/freeze-upstream.mjs';
import {
  CATALOG_COUNT, HELDOUT_SEED, assertDisjoint, buildHeldoutReservation,
  parseArgs, validateCatalog, validateReservation, writeNewReservation,
} from './heldout-selection.mjs';

// Synthetic catalog metadata only: these tests contain no benchmark task bodies.
function fixture() {
  const taskIds = Array.from({ length: CATALOG_COUNT }, (_, index) => `task-${String(index).padStart(3, '0')}`);
  const tasks = taskIds.map((taskId) => ({
    taskId,
    taskTree: sha256(`tree:${taskId}`).slice(0, 40),
    taskTomlBlob: sha256(`blob:${taskId}`).slice(0, 40),
    taskTomlSha256: sha256(`metadata:${taskId}`),
    baseCommitHash: 'a'.repeat(40),
    language: 'synthetic',
    repositoryUrl: 'https://example.invalid/metadata-fixture',
  }));
  const repository = {
    head: DEEPSWE_COMMIT,
    rootTree: 'b'.repeat(40),
    taskIds,
    tasks,
    catalogSha256: sha256(tasks.map((task) => `${task.taskId}\0${task.taskTree}\0${task.taskTomlBlob}`).join('\n')),
  };
  return {
    repository,
    original: buildLock(repository),
    options: { developmentRuleSha256: sha256('synthetic development rule'), inspectedTasks: [] },
  };
}

test('holds out 20 disjoint tasks deterministically from all 113 catalog entries', () => {
  const { repository, original, options } = fixture();
  const reservation = buildHeldoutReservation(repository, original, options);
  assert.equal(reservation.tasks.length, 20);
  assert.equal(reservation.selection.catalogTaskCount, 113);
  assert.equal(reservation.selection.availableTaskCount, 93);
  assert.equal(reservation.selection.seed, HELDOUT_SEED);
  assertDisjoint(reservation.selection.orderedTaskIds, original.selection.orderedTaskIds);
  const excluded = new Set(original.selection.orderedTaskIds);
  const expected = repository.taskIds.filter((id) => !excluded.has(id))
    .map((id) => [sha256(HELDOUT_SEED + id), id]).sort()
    .slice(0, 20).map(([, id]) => id);
  assert.deepEqual(reservation.selection.orderedTaskIds, expected);
  assert.deepEqual(reservation.tasks.map((task) => task.id), expected);
  assert.deepEqual(buildHeldoutReservation({ ...repository, taskIds: [...repository.taskIds].reverse(), tasks: [...repository.tasks].reverse() }, original, options), reservation);
  assert.equal(reservation.status, 'metadata-reservation-only');
  assert.equal(reservation.executionReady, false);
  for (const key of ['runtimeAndImageIdentities', 'selectedPluginConfiguration', 'counterbalancedSchedule']) {
    assert.equal(reservation.readiness[key].status, 'pending');
  }
  assert.equal(reservation.readiness.inference.attempts, 0);
  assert.equal(reservation.readiness.taskInstructionsSolutionsAndVerifierBodiesReadForSelection, false);
  const withUnrelatedFields = structuredClone(repository);
  for (const task of withUnrelatedFields.tasks) task.untrustedBody = 'synthetic body must not be emitted';
  assert.ok(!JSON.stringify(buildHeldoutReservation(withUnrelatedFields, original, options)).includes('synthetic body'));
});

test('inspection exposures are excluded with reasons, including exposures already in original cohort', () => {
  const { repository, original, options } = fixture();
  const initial = buildHeldoutReservation(repository, original, options);
  const exposed = initial.tasks[0].id;
  const inspectedTasks = [
    { taskId: original.tasks[0].id, reason: 'Development preflight' },
    { taskId: exposed, reason: 'Problem inspected during development' },
  ];
  const result = buildHeldoutReservation(repository, original, { ...options, inspectedTasks });
  assert.equal(result.selection.excludedTaskCount, 21);
  assert.equal(result.selection.availableTaskCount, 92);
  assert.ok(!result.selection.orderedTaskIds.includes(exposed));
  assert.deepEqual(result.exclusions.find((task) => task.taskId === original.tasks[0].id).reasons, ['Original frozen 20-task cohort.', 'Development preflight']);
  assert.deepEqual(buildHeldoutReservation(repository, original, { ...options, inspectedTasks: [...inspectedTasks].reverse() }), result);
});

test('malformed IDs, duplicates and incomplete or inconsistent catalogs fail closed', () => {
  const { repository, original, options } = fixture();
  for (const id of ['../task', 'task/name', ' task', 'task\n', 'TASK', '', null]) {
    const changed = structuredClone(repository);
    changed.taskIds[0] = id;
    assert.throws(() => buildHeldoutReservation(changed, original, options), /Malformed task ID/);
  }
  assert.throws(() => validateCatalog({ ...repository, taskIds: [...repository.taskIds.slice(1), repository.taskIds[1]] }), /Duplicate/);
  assert.throws(() => validateCatalog({ ...repository, taskIds: repository.taskIds.slice(1) }), /Incomplete catalog/);
  assert.throws(() => validateCatalog({ ...repository, tasks: repository.tasks.slice(1) }), /Incomplete catalog/);
  const duplicate = structuredClone(repository);
  duplicate.tasks[0] = duplicate.tasks[1];
  assert.throws(() => validateCatalog(duplicate), /Duplicate/);
  const mismatched = structuredClone(repository);
  mismatched.tasks[0].taskId = 'foreign-task';
  assert.throws(() => validateCatalog(mismatched), /disagree/);
  assert.throws(() => validateCatalog({ ...repository, catalogSha256: '0'.repeat(64) }), /digest/);
  const missingHash = structuredClone(repository);
  delete missingHash.tasks[0].taskTomlSha256;
  assert.throws(() => validateCatalog(missingHash), /TOML SHA-256/);
  for (const field of ['language', 'repositoryUrl', 'baseCommitHash']) {
    const missingMetadata = structuredClone(repository);
    delete missingMetadata.tasks[0][field];
    assert.throws(() => validateCatalog(missingMetadata), /metadata|base commit/);
  }
});

test('wrong revision, altered original lock, malformed exclusions and insufficient candidates are rejected', () => {
  const { repository, original, options } = fixture();
  assert.throws(() => buildHeldoutReservation({ ...repository, head: '0'.repeat(40) }, original, options), /Wrong pinned/);
  const wrongOriginal = structuredClone(original);
  wrongOriginal.upstream.commit = '0'.repeat(40);
  assert.throws(() => buildHeldoutReservation(repository, wrongOriginal, options), /wrong pinned/);
  const changedOriginal = structuredClone(original);
  changedOriginal.tasks[0].source.taskTomlSha256 = '0'.repeat(64);
  assert.throws(() => buildHeldoutReservation(repository, changedOriginal, options), /Original lock does not match/);
  assert.throws(() => buildHeldoutReservation({ ...repository, rootTree: 'c'.repeat(40) }, original, options), /Original lock does not match/);
  for (const field of ['immutable', 'schemaVersion']) {
    const invalidOriginal = structuredClone(original);
    invalidOriginal[field] = null;
    assert.throws(() => buildHeldoutReservation(repository, invalidOriginal, options), /Original lock does not match/);
  }
  const wrongPier = structuredClone(original);
  wrongPier.upstream.pierCommit = '0'.repeat(40);
  assert.throws(() => buildHeldoutReservation(repository, wrongPier, options), /Original lock does not match/);
  const inspected = { taskId: repository.taskIds[0], reason: 'Inspected' };
  assert.throws(() => buildHeldoutReservation(repository, original, { ...options, inspectedTasks: [inspected, inspected] }), /Duplicate/);
  assert.throws(() => buildHeldoutReservation(repository, original, { ...options, inspectedTasks: [{ taskId: 'foreign-task', reason: 'Inspected' }] }), /absent/);
  assert.throws(() => buildHeldoutReservation(repository, original, { ...options, inspectedTasks: [{ taskId: repository.taskIds[0], reason: ' ' }] }), /Missing inspection reason/);
  assert.throws(() => buildHeldoutReservation(repository, original, { ...options, inspectedTasks: repository.taskIds.map((taskId) => ({ taskId, reason: 'Inspected' })) }), /Not enough/);
});

test('validation rejects overlap, reordered selection, source drift and false readiness', () => {
  const { repository, original, options } = fixture();
  const reservation = buildHeldoutReservation(repository, original, options);
  assert.deepEqual(validateReservation(reservation, repository, original, options), reservation);
  const overlapping = structuredClone(reservation);
  overlapping.selection.orderedTaskIds[0] = original.tasks[0].id;
  assert.throws(() => validateReservation(overlapping, repository, original, options), /overlaps excluded/);
  const changed = structuredClone(reservation);
  changed.selection.orderedTaskIds.reverse();
  assert.throws(() => validateReservation(changed, repository, original, options), /does not match/);
  assert.throws(() => validateReservation({ ...reservation, executionReady: true }, repository, original, options), /does not match/);
  assert.throws(() => validateReservation(reservation, repository, original, { ...options, developmentRuleSha256: sha256('changed rule') }), /does not match/);
});

test('lock publication refuses existing files and symlinks; concurrent writers cannot replace a lock', async (t) => {
  // Owned disposable output: this exact temporary directory, removed by t.after.
  const directory = await mkdtemp(join(tmpdir(), 'jev-heldout-selector-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { repository, original, options } = fixture();
  const reservation = buildHeldoutReservation(repository, original, options);
  const output = join(directory, 'holdout.json');
  await writeNewReservation(output, reservation);
  const before = await readFile(output);
  await assert.rejects(writeNewReservation(output, { corrupted: true }), /Refusing to overwrite/);
  assert.deepEqual(await readFile(output), before);
  const originalPath = join(directory, 'original.json');
  await writeFile(originalPath, 'preserve original');
  const alias = join(directory, 'alias.json');
  await symlink(originalPath, alias);
  await assert.rejects(writeNewReservation(alias, reservation), /Refusing to overwrite/);
  assert.equal(await readFile(originalPath, 'utf8'), 'preserve original');
  const concurrent = join(directory, 'concurrent.json');
  const results = await Promise.allSettled([writeNewReservation(concurrent, reservation), writeNewReservation(concurrent, { corrupted: true })]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
  assert.ok((await readdir(directory)).every((name) => !name.includes('.tmp-')));
});

test('CLI requires pinned checkout location and never offers overwrite or seed changes', () => {
  assert.throws(() => parseArgs([]), /--repo is required/);
  assert.throws(() => parseArgs(['--repo']), /Missing value/);
  assert.throws(() => parseArgs(['--repo', '/metadata', '--force']), /Unknown argument/);
  assert.throws(() => parseArgs(['--repo', '/metadata', '--seed', 'post-hoc']), /Unknown argument/);
  assert.throws(() => parseArgs(['--repo', '/metadata', '--exclude', 'task-no-reason']), /requires/);
  const parsed = parseArgs(['--repo', '/metadata', '--validate', '--exclude', 'task-extra=Problem read']);
  assert.equal(parsed.validate, true);
  assert.equal(parsed.inspectedTasks.at(-1).taskId, 'task-extra');
});
