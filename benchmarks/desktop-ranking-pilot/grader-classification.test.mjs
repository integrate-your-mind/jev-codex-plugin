import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir, mkdtemp, rm, rmdir, writeFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const grader = join(root, 'benchmarks/desktop-ranking-pilot/grade.py');
const candidate = `
class Request:
    def __init__(self, method, url, data=None):
        self.body = data
        self.url = url
    def prepare(self):
        return self
`;
const dependencies = ['certifi', 'chardet', 'charset_normalizer', 'idna', 'mpmath', 'urllib3'];

async function runCandidate(source, options = {}) {
  const parent = join(root, '.agent-work/grader-classification-tests');
  await mkdir(parent, {recursive: true});
  const owned = await mkdtemp(join(parent, 'synthetic-'));
  try {
    const workspace = join(owned, 'candidate');
    const packages = join(owned, 'trusted-dependencies');
    await mkdir(join(workspace, 'requests'), {recursive: true});
    await mkdir(packages);
    await writeFile(join(workspace, 'requests/__init__.py'), source);
    for (const name of dependencies.filter(name => name !== options.missingDependency)) await writeFile(join(packages, `${name}.py`), '');
    if (!options.badRoot) {
      assert.equal(spawnSync('git', ['init', '-q', workspace]).status, 0);
      assert.equal(spawnSync('git', ['-C', workspace, 'remote', 'add', 'origin', 'https://github.com/psf/requests.git']).status, 0);
    }
    const process = spawnSync('python3', ['-B', '-S', grader, options.task ?? 'psf__requests-2931'], {
      cwd: workspace, encoding: 'utf8', env: {...globalThis.process.env, PYTHONPATH: packages}, timeout: 10_000,
    });
    assert.equal(process.error, undefined);
    return {exitCode: process.status, result: JSON.parse(process.stdout.trim().split('\n').at(-1))};
  } finally {
    await rm(owned, {recursive: true, force: true});
    try { await rmdir(parent); } catch (error) { if (error.code !== 'ENOTEMPTY' && error.code !== 'ENOENT') throw error; }
  }
}

test('a normal synthetic candidate still passes the external grader', async () => {
  const observed = await runCandidate(candidate);
  assert.equal(observed.exitCode, 0);
  assert.deepEqual(observed.result, {verdict: 'pass', healthy: true});
});

for (const [name, source, exception] of [
  ['syntax', 'def candidate_edit(:\n', 'SyntaxError'],
  ['import', 'import missing_candidate_internal_module\n', 'ModuleNotFoundError'],
  ['runtime', 'raise RuntimeError("synthetic candidate regression")\n', 'RuntimeError'],
]) {
  test(`a candidate ${name} regression counts as a failed repair`, async () => {
    const observed = await runCandidate(source);
    assert.equal(observed.exitCode, 1);
    assert.equal(observed.result.verdict, 'fail');
    assert.equal(observed.result.healthy, true);
    assert.equal(observed.result.exception, exception);
  });
}

test('a genuinely missing declared environment dependency stays infrastructure-invalid', async () => {
  const observed = await runCandidate(candidate, {missingDependency: 'urllib3'});
  assert.equal(observed.exitCode, 1);
  assert.equal(observed.result.verdict, 'infrastructure-invalid');
  assert.equal(observed.result.healthy, false);
});

test('an unknown task and an unverified source root stay infrastructure-invalid', async () => {
  for (const options of [{task: 'unknown-task'}, {badRoot: true}]) {
    const observed = await runCandidate(candidate, options);
    assert.equal(observed.exitCode, 1);
    assert.equal(observed.result.verdict, 'infrastructure-invalid');
    assert.equal(observed.result.healthy, false);
  }
});
