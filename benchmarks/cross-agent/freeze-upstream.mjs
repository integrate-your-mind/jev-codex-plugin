#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const DEEPSWE_COMMIT = '0b9fabbb63b9104d678fe965e1632f2dd9eaa2ea';
export const PIER_COMMIT = '4f3441fb3e7c21ce8a4ed0b6155a8d9a176a645a';
export const DEFAULT_SEED = 'jev-cross-agent-v1';
export const DEFAULT_COUNT = 20;
export const DEFAULT_ATTEMPTS = 1;
export const DEEPSWE_URL = 'https://github.com/datacurve-ai/deep-swe';
export const DEEPSWE_COMMIT_URL = `${DEEPSWE_URL}/tree/${DEEPSWE_COMMIT}`;

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_OUTPUT = join(SCRIPT_DIR, 'deepswe-v1.1.lock.json');

function fail(message) {
  throw new Error(message);
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * Rank IDs using sha256(seed + task ID). The ID is a tie-breaker so the
 * ordering remains total even if a future hash implementation is truncated.
 */
export function rankTaskIds(taskIds, seed = DEFAULT_SEED) {
  if (typeof seed !== 'string' || seed.length === 0) fail('Seed must be a non-empty string');
  if (!Array.isArray(taskIds) || taskIds.length === 0) fail('Task IDs must be a non-empty array');
  const unique = new Set(taskIds);
  if (unique.size !== taskIds.length || [...unique].some((id) => typeof id !== 'string' || id.length === 0)) {
    fail('Task IDs must be unique non-empty strings');
  }
  return taskIds
    .map((id) => ({ id, selectionHash: sha256(`${seed}${id}`) }))
    .sort((a, b) => a.selectionHash.localeCompare(b.selectionHash) || a.id.localeCompare(b.id));
}

export function selectTaskIds(taskIds, { seed = DEFAULT_SEED, count = DEFAULT_COUNT } = {}) {
  if (!Number.isInteger(count) || count < 1) fail('Selection count must be a positive integer');
  const ranked = rankTaskIds(taskIds, seed);
  if (count > ranked.length) fail(`Selection count ${count} exceeds available task count ${ranked.length}`);
  return ranked.slice(0, count);
}

function git(repo, args) {
  try {
    return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (error) {
    const detail = error?.stderr?.toString().trim();
    throw new Error(`git ${args.join(' ')} failed${detail ? `: ${detail}` : ''}`);
  }
}

function gitShow(repo, ref) {
  try {
    return execFileSync('git', ['-C', repo, 'show', ref], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    const detail = error?.stderr?.toString().trim();
    throw new Error(`git show ${ref} failed${detail ? `: ${detail}` : ''}`);
  }
}

function assertHex(value, name, minLength = 7, maxLength = 40) {
  if (!new RegExp(`^[0-9a-f]{${minLength},${maxLength}}$`, 'u').test(value)) fail(`Invalid ${name}: ${value}`);
}

function tomlValue(source, key) {
  const [section, field] = key.includes('.') ? key.split('.', 2) : [null, key];
  let activeSection = null;
  const wantedField = field ?? key;
  for (const line of source.split(/\r?\n/u)) {
    const header = line.match(/^\[\[([^\]]+)\]\]$|^\[([^\]]+)\]$/u);
    if (header) {
      activeSection = header[1] ?? header[2];
      continue;
    }
    if (section && activeSection !== section) continue;
    const match = line.match(new RegExp(`^${wantedField.replaceAll('.', '\\.') }\\s*=\\s*"([^"]*)"\\s*$`));
    if (match) return match[1];
  }
  return undefined;
}

function hasSection(source, section) {
  return new RegExp(`^\\[\\[?${section.replaceAll('.', '\\.') }\\]?\\]$`, 'mu').test(source);
}

export function validateTaskToml(taskId, source) {
  if (typeof source !== 'string' || source.length === 0) fail(`Missing task.toml contents: ${taskId}`);
  if (tomlValue(source, 'schema_version') !== '1.3') fail(`Unsupported schema_version for ${taskId}`);
  if (tomlValue(source, 'metadata.task_id') !== taskId) fail(`metadata.task_id does not match directory for ${taskId}`);
  const baseCommit = tomlValue(source, 'base_commit_hash');
  assertHex(baseCommit, `base_commit_hash for ${taskId}`);
  for (const section of ['task', 'metadata', 'verifier', 'agent', 'environment']) {
    if (!hasSection(source, section)) fail(`Missing [${section}] section for ${taskId}`);
  }
  if (!source.includes('[[verifier.collect]]')) fail(`Missing verifier collect entry for ${taskId}`);
  if (tomlValue(source, 'verifier.network_mode') !== 'no-network') fail(`Verifier network must be no-network for ${taskId}`);
  if (tomlValue(source, 'verifier.environment_mode') !== 'separate') fail(`Verifier environment must be separate for ${taskId}`);
  if (!tomlValue(source, 'docker_image')) fail(`Missing environment docker_image for ${taskId}`);
  if (!source.includes('/logs/artifacts/model.patch')) fail(`Missing model.patch artifact collection for ${taskId}`);
  return {
    taskId,
    baseCommitHash: baseCommit,
    language: tomlValue(source, 'language') ?? null,
    repositoryUrl: tomlValue(source, 'repository_url') ?? null,
    taskTomlSha256: sha256(source),
  };
}

export function collectRepository(repoPath) {
  const repo = resolve(repoPath);
  const head = git(repo, ['rev-parse', '--verify', 'HEAD^{commit}']);
  if (head !== DEEPSWE_COMMIT) fail(`DeepSWE checkout must be pinned to ${DEEPSWE_COMMIT}; found ${head}`);
  const status = git(repo, ['status', '--porcelain=v1', '--untracked-files=all']);
  if (status) fail(`DeepSWE checkout is not clean:\n${status}`);
  const rootTree = git(repo, ['rev-parse', 'HEAD^{tree}']);
  const taskIds = git(repo, ['ls-tree', '-d', '--name-only', 'HEAD:tasks']).split('\n').filter(Boolean);
  if (taskIds.length === 0) fail('Pinned checkout has no tasks/* directories');
  const tasks = taskIds.map((taskId) => {
    const taskToml = gitShow(repo, `HEAD:tasks/${taskId}/task.toml`);
    const metadata = validateTaskToml(taskId, taskToml);
    const taskTree = git(repo, ['rev-parse', `HEAD:tasks/${taskId}`]);
    const taskTomlBlob = git(repo, ['rev-parse', `HEAD:tasks/${taskId}/task.toml`]);
    return { ...metadata, taskTree, taskTomlBlob };
  }).sort((a, b) => a.taskId.localeCompare(b.taskId));
  const catalogSha256 = sha256(tasks.map((task) => `${task.taskId}\0${task.taskTree}\0${task.taskTomlBlob}`).join('\n'));
  return { repo, head, rootTree, taskIds: tasks.map((task) => task.taskId), tasks, catalogSha256 };
}

export function buildLock(repository, { seed = DEFAULT_SEED, count = DEFAULT_COUNT, attempts = DEFAULT_ATTEMPTS } = {}) {
  if (attempts !== 1) fail('This lock format permits exactly one attempt per task');
  const selected = selectTaskIds(repository.taskIds, { seed, count });
  const byId = new Map(repository.tasks.map((task) => [task.taskId, task]));
  return {
    schemaVersion: 'deepswe-v1.1-lock-v1',
    immutable: true,
    benchmark: 'DeepSWE v1.1',
    selection: {
      seed,
      algorithm: 'sha256(seed + taskId), ascending hash, taskId tie-breaker',
      availableTaskCount: repository.taskIds.length,
      count,
      attemptsPerTask: attempts,
      orderedTaskIds: selected.map(({ id }) => id),
      orderedSelectionHashes: selected.map(({ id, selectionHash }) => ({ taskId: id, sha256: selectionHash })),
    },
    upstream: {
      provider: 'local-git-checkout',
      repository: DEEPSWE_URL,
      commit: repository.head,
      commitUrl: DEEPSWE_COMMIT_URL,
      rootTree: repository.rootTree,
      tasksPath: 'tasks/*',
      catalogSha256: repository.catalogSha256,
      pierCommit: PIER_COMMIT,
    },
    tasks: selected.map(({ id, selectionHash }) => {
      const task = byId.get(id);
      return {
        id,
        selectionSha256: selectionHash,
        source: {
          gitTree: task.taskTree,
          taskTomlBlob: task.taskTomlBlob,
          taskTomlSha256: task.taskTomlSha256,
        },
        metadata: {
          language: task.language,
          repositoryUrl: task.repositoryUrl,
          baseCommitHash: task.baseCommitHash,
        },
      };
    }),
  };
}

async function pathExists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

export function parseArgs(argv) {
  const result = { repo: null, output: DEFAULT_OUTPUT, seed: DEFAULT_SEED, count: DEFAULT_COUNT, attempts: DEFAULT_ATTEMPTS, force: false, validateLock: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--force') {
      result.force = true;
      continue;
    }
    if (arg === '--validate-lock') {
      result.validateLock = true;
      continue;
    }
    const value = argv[++i];
    if (!value || !['--repo', '--output', '--seed', '--count', '--attempts'].includes(arg)) fail(`Unknown or incomplete argument: ${arg}`);
    if (arg === '--repo') result.repo = resolve(value);
    if (arg === '--output') result.output = resolve(value);
    if (arg === '--seed') result.seed = value;
    if (arg === '--count') result.count = Number(value);
    if (arg === '--attempts') result.attempts = Number(value);
  }
  if (!result.repo) fail('--repo is required');
  if (!Number.isInteger(result.count) || result.count < 1) fail('--count must be a positive integer');
  if (result.attempts !== 1) fail('--attempts must be exactly 1');
  return result;
}

export async function validateExistingLock({ repo, lockPath }) {
  const actualBytes = await readFile(lockPath);
  let actual;
  try {
    actual = JSON.parse(actualBytes.toString('utf8'));
  } catch (error) {
    throw new Error(`Lock is not valid JSON: ${lockPath}`);
  }
  if (!actual?.selection || actual.immutable !== true) fail(`Lock is missing immutable selection metadata: ${lockPath}`);
  const repository = collectRepository(repo);
  const expected = buildLock(repository, {
    seed: actual.selection.seed,
    count: actual.selection.count,
    attempts: actual.selection.attemptsPerTask,
  });
  const expectedBytes = Buffer.from(`${JSON.stringify(expected, null, 2)}\n`, 'utf8');
  if (!actualBytes.equals(expectedBytes)) fail(`Lock bytes do not match the clean pinned checkout: ${lockPath}`);
  return expected;
}

export async function freezeUpstream(options) {
  const repository = collectRepository(options.repo);
  const lock = buildLock(repository, options);
  if (await pathExists(options.output) && !options.force) fail(`Refusing to replace immutable lock: ${options.output}`);
  const staging = `${options.output}.tmp-${process.pid}`;
  if (await pathExists(staging)) fail(`Staging path already exists: ${staging}`);
  await mkdir(dirname(options.output), { recursive: true });
  await writeFile(staging, `${JSON.stringify(lock, null, 2)}\n`, { mode: 0o644, flag: 'wx' });
  await rename(staging, options.output);
  return lock;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.validateLock) {
    const lock = await validateExistingLock({ repo: options.repo, lockPath: options.output });
    process.stdout.write(`${JSON.stringify({ status: 'valid', output: options.output, taskCount: lock.tasks.length })}\n`);
    return;
  }
  const lock = await freezeUpstream(options);
  process.stdout.write(`${JSON.stringify({ status: 'frozen', output: options.output, taskCount: lock.tasks.length, orderedTaskIds: lock.selection.orderedTaskIds })}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
