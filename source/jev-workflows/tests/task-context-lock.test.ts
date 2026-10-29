import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {once} from 'node:events';
import fs, {lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, utimes, writeFile} from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import {join, resolve} from 'node:path';
import {test} from 'node:test';
import {pathToFileURL} from 'node:url';
import {loadTaskContext, updateTaskContext} from '../src/task-context.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return {promise, resolve};
}

async function fixture() {
  const parent = resolve('../../.agent-work/task-context-tests');
  await mkdir(parent, {recursive: true});
  const directory = await mkdtemp(join(parent, 'lock-'));
  const cwd = await realpath(process.cwd());
  const scope = {cwd, sessionId: 'lock-test'};
  const hash = (value: string) => createHash('sha256').update(value).digest('hex');
  const contextDirectory = join(directory, 'task-context-v1', hash(cwd), hash(scope.sessionId), hash('root'));
  await mkdir(contextDirectory, {recursive: true, mode: 0o700});
  return {directory, scope, contextDirectory, path: join(contextDirectory, 'context.json'), lock: join(contextDirectory, '.context.lock'), env: {JEV_STATE_DIRECTORY: directory}};
}

test('a delayed task-context reclaimer preserves the replacement writer and both updates', {timeout: 10_000}, async () => {
  const target = await fixture();
  const sawReclaimer = deferred();
  const resumeReclaimer = deferred();
  const resumedReclaimer = deferred();
  const sawWriter = deferred();
  const resumeWriter = deferred();
  const originalUnlink = fs.unlink;
  const originalRename = fs.rename;
  let pausedReclaimer = false;
  let pausedWriter = false;
  let replacementPreserved = false;
  const pending: Promise<unknown>[] = [];
  try {
    await writeFile(target.lock, JSON.stringify({pid: 99999999, token: '12345678-1234-4234-8234-123456789abc', createdAt: '2020-01-01T00:00:00.000Z'}));
    const old = new Date(Date.now() - 120_000);
    await utimes(target.lock, old, old);
    fs.unlink = async path => {
      if (String(path) !== target.lock || pausedReclaimer) return originalUnlink(path);
      pausedReclaimer = true;
      sawReclaimer.resolve();
      await resumeReclaimer.promise;
      try { return await originalUnlink(path); }
      finally {
        replacementPreserved = await lstat(target.lock).then(() => true, () => false);
        resumedReclaimer.resolve();
      }
    };
    fs.rename = async (source, destination) => {
      if (String(destination) === target.path && !pausedWriter) {
        pausedWriter = true;
        sawWriter.resolve();
        await resumeWriter.promise;
      }
      return originalRename(source, destination);
    };
    syncBuiltinESMExports();
    const first = updateTaskContext(target.scope, {constraints: ['first constraint']}, {env: target.env});
    pending.push(first);
    await sawReclaimer.promise;
    const second = updateTaskContext(target.scope, {constraints: ['second constraint']}, {env: target.env});
    pending.push(second);
    await sawWriter.promise;
    resumeReclaimer.resolve();
    await resumedReclaimer.promise;
    if (!replacementPreserved) await first;
    resumeWriter.resolve();
    assert.ok((await Promise.all([first, second])).every(Boolean));
    const saved = await loadTaskContext(target.scope, {env: target.env});
    assert.deepEqual(new Set(saved?.constraints.map(item => item.value)), new Set(['first constraint', 'second constraint']));
    assert.equal(replacementPreserved, true);
  } finally {
    resumeReclaimer.resolve();
    resumeWriter.resolve();
    await Promise.allSettled(pending);
    fs.unlink = originalUnlink;
    fs.rename = originalRename;
    syncBuiltinESMExports();
    await rm(target.directory, {recursive: true, force: true});
  }
});

test('task context recovers abandoned legacy and directory locks without losing prior data', async () => {
  for (const kind of ['empty legacy', 'owned legacy', 'owned directory']) {
    const target = await fixture();
    try {
      await updateTaskContext(target.scope, {rootObjective: 'Keep this objective', constraints: ['prior constraint']}, {env: target.env});
      const token = '12345678-1234-4234-8234-123456789abc';
      const owner = JSON.stringify({pid: 99999999, token, createdAt: '2020-01-01T00:00:00.000Z'});
      if (kind === 'owned directory') {
        await mkdir(target.lock, {mode: 0o700});
        await writeFile(join(target.lock, `owner-${token}.json`), owner);
      } else await writeFile(target.lock, kind === 'empty legacy' ? '' : owner);
      const old = new Date(Date.now() - 120_000);
      await utimes(target.lock, old, old);
      assert.ok(await updateTaskContext(target.scope, {constraints: ['recovered constraint']}, {env: target.env}), kind);
      const saved = await loadTaskContext(target.scope, {env: target.env});
      assert.equal(saved?.rootObjective?.value, 'Keep this objective', kind);
      assert.deepEqual(saved?.constraints.map(item => item.value), ['prior constraint', 'recovered constraint'], kind);
      assert.deepEqual(await readdir(target.contextDirectory), ['context.json'], kind);
      assert.equal((await stat(target.path)).mode & 0o777, 0o600, kind);
    } finally { await rm(target.directory, {recursive: true, force: true}); }
  }
});

test('unknown task-context lock contents fail closed and remain untouched', async () => {
  const target = await fixture();
  try {
    await mkdir(target.lock);
    await writeFile(join(target.lock, 'unknown'), 'preserve');
    const old = new Date(Date.now() - 120_000);
    await utimes(target.lock, old, old);
    assert.equal(await updateTaskContext(target.scope, {rootObjective: 'Do not publish'}, {env: target.env}), undefined);
    assert.equal(await readFile(join(target.lock, 'unknown'), 'utf8'), 'preserve');
    await assert.rejects(() => stat(target.path), {code: 'ENOENT'});
  } finally { await rm(target.directory, {recursive: true, force: true}); }
});

test('a context publication error preserves prior data and releases its private lock', async () => {
  const target = await fixture();
  const originalRename = fs.rename;
  try {
    await updateTaskContext(target.scope, {rootObjective: 'Retained objective'}, {env: target.env});
    fs.rename = async (source, destination) => {
      if (String(destination) === target.path) {
        const entries = await readdir(target.lock);
        assert.equal((await stat(target.lock)).mode & 0o777, 0o700);
        assert.equal((await stat(join(target.lock, entries[0]!))).mode & 0o777, 0o600);
        throw new Error('simulated_context_publication_failure');
      }
      return originalRename(source, destination);
    };
    syncBuiltinESMExports();
    await assert.rejects(() => updateTaskContext(target.scope, {constraints: ['unpublished']}, {env: target.env}), /simulated_context_publication_failure/);
    assert.deepEqual(await readdir(target.contextDirectory), ['context.json']);
    const saved = await loadTaskContext(target.scope, {env: target.env});
    assert.equal(saved?.rootObjective?.value, 'Retained objective');
    assert.deepEqual(saved?.constraints, []);
    fs.rename = originalRename;
    syncBuiltinESMExports();
    const recovered = await updateTaskContext(target.scope, {constraints: ['retried']}, {env: target.env});
    assert.deepEqual(recovered?.constraints.map(item => item.value), ['retried']);
  } finally {
    fs.rename = originalRename;
    syncBuiltinESMExports();
    await rm(target.directory, {recursive: true, force: true});
  }
});

test('context loads still reject malformed, wrong-version, wrong-scope, and symlinked records', async () => {
  const target = await fixture();
  try {
    const initial = await updateTaskContext(target.scope, {rootObjective: 'Never inherit this outside its scope'}, {env: target.env});
    assert.ok(initial);
    const serialized = JSON.stringify(initial);
    for (const contents of [
      '{',
      JSON.stringify({...initial, version: 2}),
      JSON.stringify({...initial, scope: {...initial.scope, sessionHash: '0'.repeat(64)}}),
    ]) {
      await writeFile(target.path, contents);
      assert.equal(await loadTaskContext(target.scope, {env: target.env}), undefined);
    }
    const outside = join(target.directory, 'outside.json');
    await writeFile(outside, serialized);
    await rm(target.path);
    await symlink(outside, target.path);
    assert.equal(await loadTaskContext(target.scope, {env: target.env}), undefined);
    const updated = await updateTaskContext(target.scope, {rootObjective: 'New scoped objective'}, {env: target.env});
    assert.equal(updated?.rootObjective?.value, 'New scoped objective');
    assert.equal(await readFile(outside, 'utf8'), serialized);
  } finally { await rm(target.directory, {recursive: true, force: true}); }
});

function contextProcess(script: string) {
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script], {stdio: ['pipe', 'pipe', 'pipe', 'ipc']});
  let output = '';
  let errors = '';
  assert.ok(child.stdout);
  assert.ok(child.stderr);
  child.stdout.on('data', data => { output += data; });
  child.stderr.on('data', data => { errors += data; });
  const finished = once(child, 'exit').then(([code, signal]) => ({code, signal, output, errors}));
  return {child, finished};
}

const contextModule = pathToFileURL(resolve('src/task-context.ts')).href;

test('separate context writers recover an abandoned lock and preserve every update', {timeout: 10_000}, async () => {
  const target = await fixture();
  const children: ReturnType<typeof contextProcess>[] = [];
  try {
    await writeFile(target.lock, '');
    const old = new Date(Date.now() - 120_000);
    await utimes(target.lock, old, old);
    for (let index = 0; index < 8; index++) children.push(contextProcess(`
      import {updateTaskContext} from ${JSON.stringify(contextModule)};
      await new Promise(resolve => { process.once('message', resolve); process.send('ready'); });
      const result = await updateTaskContext(${JSON.stringify(target.scope)}, {constraints: ['constraint-${index}']}, {env: ${JSON.stringify(target.env)}});
      process.stdout.write(JSON.stringify(Boolean(result)));
      process.disconnect();
    `));
    await Promise.all(children.map(({child}) => once(child, 'message')));
    for (const {child} of children) child.send('go');
    const results = await Promise.all(children.map(({finished}) => finished));
    for (const result of results) {
      assert.equal(result.code, 0, result.errors);
      assert.equal(JSON.parse(result.output), true);
    }
    const saved = await loadTaskContext(target.scope, {env: target.env});
    assert.deepEqual(new Set(saved?.constraints.map(item => item.value)), new Set(Array.from({length: 8}, (_, index) => `constraint-${index}`)));
    assert.deepEqual(await readdir(target.contextDirectory), ['context.json']);
  } finally {
    for (const {child} of children) child.kill('SIGKILL');
    await Promise.allSettled(children.map(({finished}) => finished));
    await rm(target.directory, {recursive: true, force: true});
  }
});

test('an interrupted context writer remains protected while live and recovers after a crash', {timeout: 10_000}, async () => {
  const target = await fixture();
  await updateTaskContext(target.scope, {rootObjective: 'Retain the prior objective'}, {env: target.env});
  const {child, finished} = contextProcess(`
    import fs from 'node:fs/promises';
    import {syncBuiltinESMExports} from 'node:module';
    const original = fs.rename;
    fs.rename = async (source, destination) => {
      if (String(destination) === ${JSON.stringify(target.path)}) {
        process.send('held');
        setInterval(() => {}, 1000);
        await new Promise(() => {});
      }
      return original(source, destination);
    };
    syncBuiltinESMExports();
    const {updateTaskContext} = await import(${JSON.stringify(contextModule)});
    await updateTaskContext(${JSON.stringify(target.scope)}, {constraints: ['interrupted']}, {env: ${JSON.stringify(target.env)}});
  `);
  try {
    await once(child, 'message');
    const old = new Date(Date.now() - 120_000);
    await utimes(target.lock, old, old);
    assert.equal(await updateTaskContext(target.scope, {constraints: ['while live']}, {env: target.env}), undefined);
    child.kill('SIGKILL');
    assert.equal((await finished).signal, 'SIGKILL');
    const recovered = await updateTaskContext(target.scope, {constraints: ['after crash']}, {env: target.env});
    assert.equal(recovered?.rootObjective?.value, 'Retain the prior objective');
    assert.deepEqual(recovered?.constraints.map(item => item.value), ['after crash']);
    await assert.rejects(() => stat(target.lock), {code: 'ENOENT'});
  } finally {
    child.kill('SIGKILL');
    await finished;
    await rm(target.directory, {recursive: true, force: true});
  }
});
