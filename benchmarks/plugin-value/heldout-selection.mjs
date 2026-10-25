#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import { link, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  DEEPSWE_COMMIT, DEFAULT_SEED, buildLock, collectRepository, sha256,
} from '../cross-agent/freeze-upstream.mjs';

export const HELDOUT_SEED = 'jev-plugin-heldout-v1';
export const CATALOG_COUNT = 113;
export const HELDOUT_COUNT = 20;
export const KNOWN_INSPECTIONS = [{
  taskId: 'ipython-session-bundle-replay',
  reason: 'Task content inspected during development preflight; already in the original cohort.',
}];
const HERE = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_OUTPUT = join(HERE, 'heldout-selection.json');
const ORIGINAL_LOCK = join(HERE, '../cross-agent/deepswe-v1.1.lock.json');
const RULE_PATH = join(HERE, 'development-selection.md');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function validateIds(ids, label) {
  assert(Array.isArray(ids) && ids.length > 0, `${label} must be a non-empty array`);
  assert(ids.every((id) => typeof id === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(id)), `Malformed task ID in ${label}`);
  assert(new Set(ids).size === ids.length, `Duplicate task ID in ${label}`);
}

function validateHash(value, length, label) {
  assert(typeof value === 'string' && new RegExp(`^[0-9a-f]{${length}}$`, 'u').test(value), `Invalid ${label}`);
}

export function validateCatalog(repository) {
  assert(repository?.head === DEEPSWE_COMMIT, `Wrong pinned DeepSWE revision; expected ${DEEPSWE_COMMIT}`);
  validateIds(repository.taskIds, 'catalog IDs');
  assert(repository.taskIds.length === CATALOG_COUNT, `Incomplete catalog: expected ${CATALOG_COUNT} task IDs`);
  assert(Array.isArray(repository.tasks) && repository.tasks.length === CATALOG_COUNT, `Incomplete catalog: expected ${CATALOG_COUNT} task metadata records`);
  validateIds(repository.tasks.map((task) => task.taskId), 'catalog metadata');
  const ids = new Set(repository.taskIds);
  assert(repository.tasks.every((task) => ids.has(task.taskId)), 'Catalog IDs and metadata disagree');
  validateHash(repository.rootTree, 40, 'root tree');
  for (const task of repository.tasks) {
    validateHash(task.taskTree, 40, `task tree for ${task.taskId}`);
    validateHash(task.taskTomlBlob, 40, `task TOML blob for ${task.taskId}`);
    validateHash(task.taskTomlSha256, 64, `task TOML SHA-256 for ${task.taskId}`);
    assert(typeof task.baseCommitHash === 'string' && /^[0-9a-f]{7,40}$/u.test(task.baseCommitHash), `Invalid base commit for ${task.taskId}`);
    assert(task.language === null || typeof task.language === 'string', `Missing language metadata for ${task.taskId}`);
    assert(task.repositoryUrl === null || typeof task.repositoryUrl === 'string', `Missing repository metadata for ${task.taskId}`);
  }
  const ordered = [...repository.tasks].sort((a, b) => a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0);
  const digest = sha256(ordered.map((task) => `${task.taskId}\0${task.taskTree}\0${task.taskTomlBlob}`).join('\n'));
  assert(repository.catalogSha256 === digest, 'Catalog digest does not match task metadata');
}

export function assertDisjoint(selectedIds, excludedIds) {
  validateIds(selectedIds, 'held-out IDs');
  const excluded = new Set(excludedIds);
  for (const id of selectedIds) assert(!excluded.has(id), `Held-out selection overlaps excluded task: ${id}`);
}

export function buildHeldoutReservation(repository, originalLock, {
  originalLockSha256 = sha256(`${JSON.stringify(originalLock, null, 2)}\n`),
  developmentRuleSha256,
  inspectedTasks = KNOWN_INSPECTIONS,
} = {}) {
  validateCatalog(repository);
  assert(originalLock?.upstream?.commit === DEEPSWE_COMMIT, 'Original lock has the wrong pinned revision');
  validateIds(originalLock?.selection?.orderedTaskIds, 'original lock IDs');
  const expectedOriginal = buildLock(repository, { seed: DEFAULT_SEED, count: 20, attempts: 1 });
  assert(JSON.stringify(originalLock) === JSON.stringify(expectedOriginal), 'Original lock does not match the complete pinned catalog and original selection');
  validateHash(originalLockSha256, 64, 'original lock SHA-256');
  validateHash(developmentRuleSha256, 64, 'development rule SHA-256');
  assert(Array.isArray(inspectedTasks), 'Inspected tasks must be an array');
  if (inspectedTasks.length) validateIds(inspectedTasks.map((task) => task.taskId), 'inspected tasks');

  const catalogIds = new Set(repository.taskIds);
  const exclusions = new Map(originalLock.selection.orderedTaskIds.map((id) => [id, ['Original frozen 20-task cohort.']]));
  for (const task of inspectedTasks) {
    assert(catalogIds.has(task.taskId), `Inspected task is absent from pinned catalog: ${task.taskId}`);
    assert(typeof task.reason === 'string' && task.reason.trim().length > 0, `Missing inspection reason: ${task.taskId}`);
    exclusions.set(task.taskId, [...(exclusions.get(task.taskId) ?? []), task.reason.trim()]);
  }
  const eligible = repository.taskIds.filter((id) => !exclusions.has(id));
  assert(eligible.length >= HELDOUT_COUNT, 'Not enough uninspected tasks for the held-out cohort');
  // Only the candidate ID list changes; source hashes remain those of the full catalog.
  const selected = buildLock({ ...repository, taskIds: eligible }, { seed: HELDOUT_SEED, count: HELDOUT_COUNT, attempts: 1 });
  assertDisjoint(selected.selection.orderedTaskIds, [...exclusions.keys()]);
  return {
    schemaVersion: 'jev-plugin-heldout-metadata-reservation-v1',
    immutable: true,
    status: 'metadata-reservation-only',
    executionReady: false,
    benchmark: selected.benchmark,
    developmentRule: { path: 'benchmarks/plugin-value/development-selection.md', sha256: developmentRuleSha256 },
    originalCohort: {
      path: 'benchmarks/cross-agent/deepswe-v1.1.lock.json',
      sha256: originalLockSha256,
      seed: originalLock.selection.seed,
      orderedTaskIds: originalLock.selection.orderedTaskIds,
    },
    selection: { ...selected.selection, catalogTaskCount: CATALOG_COUNT, excludedTaskCount: exclusions.size },
    exclusions: [...exclusions].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([taskId, reasons]) => ({ taskId, reasons })),
    upstream: selected.upstream,
    tasks: selected.tasks,
    readiness: {
      taskInstructionsSolutionsAndVerifierBodiesReadForSelection: false,
      inspectionInventory: 'Known development inspections only; reconcile any additional exposure before inference.',
      runtimeAndImageIdentities: { status: 'pending', value: null },
      selectedPluginConfiguration: { status: 'pending', contentHashes: null },
      counterbalancedSchedule: { status: 'pending', plannedRows: 40, value: null },
      inference: { status: 'not-started', attempts: 0 },
      limitation: 'This reserves metadata and IDs only. It is not an execution-ready freeze or evidence of benchmark performance.',
    },
  };
}

export function validateReservation(actual, repository, originalLock, options) {
  const expected = buildHeldoutReservation(repository, originalLock, options);
  assertDisjoint(actual?.selection?.orderedTaskIds, expected.exclusions.map((task) => task.taskId));
  assert(JSON.stringify(actual) === JSON.stringify(expected), 'Held-out reservation does not match deterministic metadata selection');
  return expected;
}

export async function writeNewReservation(output, reservation) {
  await mkdir(dirname(output), { recursive: true });
  const staging = `${output}.tmp-${randomUUID()}`;
  try {
    await writeFile(staging, `${JSON.stringify(reservation, null, 2)}\n`, { flag: 'wx', mode: 0o644 });
    // Atomic publication without replacement, including concurrent writers and symlinks.
    await link(staging, output);
  } catch (error) {
    if (error?.code === 'EEXIST') throw new Error(`Refusing to overwrite existing lock: ${output}`);
    throw error;
  } finally {
    await rm(staging, { force: true });
  }
}

export function parseArgs(argv) {
  const options = { repo: null, output: DEFAULT_OUTPUT, originalLock: ORIGINAL_LOCK, validate: false, inspectedTasks: [...KNOWN_INSPECTIONS] };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--validate') { options.validate = true; continue; }
    assert(['--repo', '--output', '--original-lock', '--exclude'].includes(flag), `Unknown argument: ${flag}`);
    const value = argv[++index];
    assert(typeof value === 'string' && value.length > 0 && !value.startsWith('--'), `Missing value for ${flag}`);
    if (flag === '--repo') options.repo = resolve(value);
    if (flag === '--output') options.output = resolve(value);
    if (flag === '--original-lock') options.originalLock = resolve(value);
    if (flag === '--exclude') {
      const separator = value.indexOf('=');
      assert(separator > 0 && separator < value.length - 1, '--exclude requires task-id=inspection reason');
      options.inspectedTasks.push({ taskId: value.slice(0, separator), reason: value.slice(separator + 1) });
    }
  }
  assert(options.repo, '--repo is required');
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const originalBytes = await readFile(options.originalLock);
  const originalLock = JSON.parse(originalBytes);
  const sourceOptions = {
    originalLockSha256: sha256(originalBytes),
    developmentRuleSha256: sha256(await readFile(RULE_PATH)),
    inspectedTasks: options.inspectedTasks,
  };
  // The reused collector reads only Git tree metadata and task.toml blobs at HEAD.
  // It rejects any revision other than DEEPSWE_COMMIT and any dirty checkout.
  const repository = collectRepository(options.repo);
  const reservation = options.validate
    ? validateReservation(JSON.parse(await readFile(options.output)), repository, originalLock, sourceOptions)
    : buildHeldoutReservation(repository, originalLock, sourceOptions);
  if (!options.validate) await writeNewReservation(options.output, reservation);
  process.stdout.write(`${JSON.stringify({ status: options.validate ? 'validated-metadata-reservation' : reservation.status, executionReady: false, output: options.output, taskCount: reservation.tasks.length, overlapWithOriginal: 0 })}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
