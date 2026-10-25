import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {mkdtemp, writeFile, rm, readFile, symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {promisify} from 'node:util';
import test from 'node:test';
const exec = promisify(execFile);
const script = new URL('./sync-jev-contract.mjs', import.meta.url).pathname;
test('sync detects drift, repairs only named contracts and rejects unrelated targets', async () => {
  const target = await mkdtemp(join(tmpdir(), 'jev-contract-test-'));
  try {
    await writeFile(join(target, 'Cargo.toml'), '[package]\nname = "other"\n');
    await assert.rejects(exec(process.execPath, [script, '--write', target]), /not the QQ repository/);
    await writeFile(join(target, 'Cargo.toml'), '[package]\nname = "qq"\n');
    await writeFile(join(target, 'keep.txt'), 'owned by user');
    await exec(process.execPath, [script, '--write', target]);
    await exec(process.execPath, [script, target]);
    const file = join(target, 'contracts/jev/conformance.json');
    await writeFile(file, '{"drift":true}\n');
    await assert.rejects(exec(process.execPath, [script, target]), /Jev contract drift/);
    await exec(process.execPath, [script, '--write', target]);
    assert.equal(await readFile(join(target, 'keep.txt'), 'utf8'), 'owned by user');
    await rm(file);
    await symlink(join(target, 'keep.txt'), file);
    await assert.rejects(exec(process.execPath, [script, '--write', target]), /not a plain file/);
    assert.equal(await readFile(join(target, 'keep.txt'), 'utf8'), 'owned by user');
  } finally { await rm(target, {recursive: true, force: true}); }
});
