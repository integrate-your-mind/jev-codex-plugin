import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_SEED,
  PIER_COMMIT,
  buildLock,
  rankTaskIds,
  selectTaskIds,
  sha256,
  validateTaskToml,
} from '../freeze-upstream.mjs';

const TASK_TOML = `schema_version = "1.3"
artifacts = ["/logs/artifacts/model.patch"]
[task]
name = "datacurve/example"
[metadata]
task_id = "example"
language = "typescript"
repository_url = "https://github.com/example/project"
base_commit_hash = "0123456789abcdef0123456789abcdef01234567"
[verifier]
network_mode = "no-network"
environment_mode = "separate"
[[verifier.collect]]
command = "git diff > /logs/artifacts/model.patch"
[agent]
network_mode = "no-network"
[environment]
docker_image = "example/image:v1.1"
`;

test('selection is deterministic, sorted by sha256(seed + taskId), and bounded', () => {
  const ids = ['zeta', 'alpha', 'gamma', 'beta'];
  const ranked = rankTaskIds(ids, DEFAULT_SEED);
  assert.deepEqual(ranked, [...ids]
    .map((id) => ({ id, selectionHash: sha256(`${DEFAULT_SEED}${id}`) }))
    .sort((a, b) => a.selectionHash.localeCompare(b.selectionHash) || a.id.localeCompare(b.id)));
  assert.deepEqual(selectTaskIds(ids, { seed: DEFAULT_SEED, count: 2 }), selectTaskIds([...ids].reverse(), { seed: DEFAULT_SEED, count: 2 }));
  assert.throws(() => selectTaskIds(ids, { count: 5 }), /exceeds available/);
  assert.throws(() => rankTaskIds(['alpha', 'alpha']), /unique/);
});

test('task format validation accepts v1.1 metadata and rejects drift', () => {
  const metadata = validateTaskToml('example', TASK_TOML);
  assert.equal(metadata.baseCommitHash, '0123456789abcdef0123456789abcdef01234567');
  assert.equal(metadata.taskTomlSha256, sha256(TASK_TOML));
  assert.throws(() => validateTaskToml('wrong-id', TASK_TOML), /does not match directory/);
  assert.throws(() => validateTaskToml('example', TASK_TOML.replace('environment_mode = "separate"', 'environment_mode = "shared"')), /separate/);
  assert.throws(() => validateTaskToml('example', TASK_TOML.replaceAll('model.patch', 'other.patch')), /model.patch/);
});

test('lock carries ordered source hashes and the pinned Pier commit', () => {
  const repository = {
    head: '0b9fabbb63b9104d678fe965e1632f2dd9eaa2ea',
    rootTree: 'root-tree',
    catalogSha256: 'catalog-a',
    taskIds: ['example', 'second'],
    tasks: [
      {
        taskId: 'example',
        taskTree: 'tree-example',
        taskTomlBlob: 'blob-example',
        taskTomlSha256: 'toml-example',
        baseCommitHash: 'base-example',
        language: 'typescript',
        repositoryUrl: 'https://github.com/example/project',
      },
      {
        taskId: 'second',
        taskTree: 'tree-second',
        taskTomlBlob: 'blob-second',
        taskTomlSha256: 'toml-second',
        baseCommitHash: 'base-second',
        language: 'python',
        repositoryUrl: 'https://github.com/example/second',
      },
    ],
  };
  const lock = buildLock(repository, { seed: 'test-seed', count: 2, attempts: 1 });
  assert.equal(lock.immutable, true);
  assert.equal(lock.upstream.pierCommit, PIER_COMMIT);
  assert.deepEqual(lock.selection.orderedTaskIds, lock.tasks.map((task) => task.id));
  assert.deepEqual(lock.tasks.map((task) => task.source.gitTree).sort(), ['tree-example', 'tree-second']);
  assert.throws(() => buildLock(repository, { attempts: 2 }), /exactly one attempt/);

  const changed = buildLock({ ...repository, catalogSha256: 'catalog-b' }, { seed: 'test-seed', count: 2 });
  assert.notEqual(changed.upstream.catalogSha256, lock.upstream.catalogSha256);
});
