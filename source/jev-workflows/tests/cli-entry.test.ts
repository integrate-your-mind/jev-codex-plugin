import {execFile} from 'node:child_process';
import {mkdtemp, rm, symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {promisify} from 'node:util';
import {test} from 'node:test';
import assert from 'node:assert/strict';
const exec = promisify(execFile);

test('bundled CLI launches directly through a symlink and imports without executing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jev-cli-entry-'));
  try {
    const entry = join(root, 'jev.mjs');
    await symlink(resolve('dist/cli.mjs'), entry);
    const env = {PATH: process.env.PATH, TYPESAFE_API_KEY: '', JEV_STATE_DIRECTORY: join(root, 'state')};
    const result = await exec(process.execPath, [entry, 'status'], {env, timeout: 5000});
    assert.equal(result.stderr, '');
    assert.equal(JSON.parse(result.stdout).version, '0.3.0');
    const imported = await exec(process.execPath, ['--input-type=module', '--eval', `await import(${JSON.stringify(entry)});`], {env, timeout: 5000});
    assert.equal(imported.stdout, '');
    assert.equal(imported.stderr, '');
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});
