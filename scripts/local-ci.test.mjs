import assert from 'node:assert/strict';
import {cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {execFile, spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';
import {parsePrePush, runCommand, runVerification, validateVmRecord} from './local-ci.mjs';
import {installHook} from './install-local-ci-hook.mjs';

const exec = promisify(execFile);
const controller = new URL('./local-ci.mjs', import.meta.url);

async function git(cwd, ...args) { await exec('git', args, {cwd}); }

async function fixture() {
  const root = await mkdtemp('/tmp/jev-local-ci-test-');
  await git(root, 'init', '-q');
  await git(root, 'config', 'user.email', 'test@example.invalid');
  await git(root, 'config', 'user.name', 'Local CI Test');
  await mkdir(join(root, '.ci'), {recursive: true});
  await writeFile(join(root, '.ci/lima.yaml'), 'plain: true\nmounts: []\nforwardAgent: false\nloadDotSSHPubKeys: false\npropagateProxyEnv: false\noverVsock: false\n');
  await writeFile(join(root, '.ci/run-guest.sh'), '#!/bin/sh\nexit 0\n');
  await writeFile(join(root, 'tracked.txt'), 'one\n');
  await git(root, 'add', '.');
  await git(root, 'commit', '-qm', 'fixture');
  const {stdout} = await exec('git', ['rev-parse', 'HEAD'], {cwd: root});
  return {root, sha: stdout.trim()};
}

test('pre-push parsing validates full SHAs, skips deletions, and deduplicates tips', () => {
  const sha = 'A'.repeat(40);
  const other = 'b'.repeat(40);
  assert.deepEqual(parsePrePush(`refs/heads/main ${sha} refs/heads/main ${other}\nrefs/heads/side ${sha} refs/heads/side ${other}\n`), [sha.toLowerCase()]);
  assert.deepEqual(parsePrePush(`refs/heads/main ${'0'.repeat(40)} refs/heads/main ${other}\n`), []);
  assert.throws(() => parsePrePush(`refs/heads/main ${'a'.repeat(39)} refs/heads/main ${other}\n`), /Invalid pre-push/);
});

test('exact commit runs archive and records failed receipt', async () => {
  const {root, sha} = await fixture();
  try {
    let receiptError;
    await runVerification({cwd: root, sha, stop: false, lockRoot: join(root, 'lock'), execute: async ({archive, sha: exact}) => {
      assert.ok(Buffer.isBuffer(archive) && archive.length > 0);
      assert.equal(exact, sha);
      return {exitCode: 7, stdout: 'failed\n', stderr: ''};
    }}).catch(error => { receiptError = error; });
    assert.ok(receiptError);
    assert.equal(receiptError.receipt.exitCode, 7);
    const log = await readFile(receiptError.receipt.logPath, 'utf8');
    assert.match(log, /failed/);
    await assert.rejects(runVerification({cwd: root, sha: 'f'.repeat(40), stop: false, lockRoot: join(root, 'lock'), execute: async () => ({exitCode: 0, stdout: '', stderr: ''})}), /did not resolve|fatal|unknown revision/);
  } finally { await rm(root, {recursive: true, force: true}); }
});

test('annotated tag object resolves to its commit for archive verification', async () => {
  const {root, sha} = await fixture();
  try {
    await git(root, 'tag', '-a', '-m', 'release', 'v-test');
    const {stdout: tagObject} = await exec('git', ['rev-parse', 'refs/tags/v-test'], {cwd: root});
    const {stdout: taggedCommit} = await exec('git', ['rev-parse', 'refs/tags/v-test^{commit}'], {cwd: root});
    let received;
    const receipt = await runVerification({cwd: root, sha: tagObject.trim(), stop: false, lockRoot: join(root, 'lock'), execute: async ({sha: exact}) => { received = exact; return {exitCode: 0, stdout: '', stderr: ''}; }});
    assert.equal(received, taggedCommit.trim());
    assert.equal(receipt.sha, sha);
  } finally { await rm(root, {recursive: true, force: true}); }
});

test('successful runs retain distinct receipts and do not reuse prior success', async () => {
  const {root, sha} = await fixture();
  let executions = 0;
  try {
    const options = {cwd: root, sha, now: () => '2026-10-15T00:00:00.000Z', stop: false, lockRoot: join(root, 'lock'), execute: async () => { executions += 1; return {exitCode: 0, stdout: 'ok\n', stderr: ''}; }};
    const first = await runVerification(options);
    const second = await runVerification(options);
    assert.equal(first.cached, undefined);
    assert.equal(second.cached, undefined);
    assert.equal(executions, 2);
    assert.notEqual(first.receiptPath, second.receiptPath);
    assert.notEqual(first.logPath, second.logPath);
    const common = (await exec('git', ['rev-parse', '--git-common-dir'], {cwd: root})).stdout.trim();
    const state = join(resolve(root, common), 'jev-local-ci/trusted');
    await mkdir(state, {recursive: true});
    await cp(controller, join(state, 'local-ci.mjs'));
    await cp(join(root, '.ci/run-guest.sh'), join(state, 'run-guest.sh'));
    await writeFile(join(state, 'run-guest.sh'), '#!/bin/sh\nexit 1\n');
    const third = await runVerification(options);
    assert.equal(third.cached, undefined);
    assert.equal(executions, 3);
  } finally { await rm(root, {recursive: true, force: true}); }
});

test('runCommand escalates a child that ignores SIGTERM', async () => {
  const result = await runCommand(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], {timeoutMs: 30, killGraceMs: 30});
  assert.equal(result.timedOut, true);
  assert.equal(result.exitCode, 124);
});

test('timeout exit is retained as a failed receipt', async () => {
  const {root, sha} = await fixture();
  try {
    let error;
    await runVerification({cwd: root, sha, stop: false, lockRoot: join(root, 'lock'), execute: async () => ({exitCode: 124, stdout: '', stderr: 'timeout\n'})}).catch(received => { error = received; });
    assert.ok(error);
    assert.equal(error.receipt.exitCode, 124);
  } finally { await rm(root, {recursive: true, force: true}); }
});

test('hook installer copies reviewed sources and refuses a different pre-push hook', async () => {
  const root = await mkdtemp('/tmp/jev-local-ci-install-');
  try {
    await git(root, 'init', '-q');
    await mkdir(join(root, 'scripts'), {recursive: true});
    await mkdir(join(root, '.ci'), {recursive: true});
    await writeFile(join(root, 'scripts/local-ci.mjs'), '# reviewed controller\n');
    await writeFile(join(root, '.ci/run-guest.sh'), '# reviewed guest\n');
    const installed = await installHook({repoRoot: root, lockRoot: join(root, '.lima/jev-plugin-ci')});
    assert.match(await readFile(installed.hookPath, 'utf8'), /jev-local-ci pre-push hook/);
    assert.equal(await readFile(installed.controller, 'utf8'), '# reviewed controller\n');
    assert.equal(await readFile(installed.guestRunner, 'utf8'), '# reviewed guest\n');
    await git(root, 'config', 'core.hooksPath', 'shared-hooks');
    await assert.rejects(installHook({repoRoot: root, lockRoot: join(root, '.lima/jev-plugin-ci')}), /configured core\.hooksPath/);
    await git(root, 'config', '--unset', 'core.hooksPath');
    await writeFile(installed.hookPath, '#!/bin/sh\n# jev-local-ci pre-push hook\necho other\n');
    await assert.rejects(installHook({repoRoot: root, lockRoot: join(root, '.lima/jev-plugin-ci')}), /Refusing to overwrite existing pre-push hook/);
  } finally { await rm(root, {recursive: true, force: true}); }
});

test('installed hook verifies the pushed archive, starts the VM and preserves the guest failure', async () => {
  const {root, sha} = await fixture();
  try {
    await mkdir(join(root, 'scripts'), {recursive: true});
    await cp(fileURLToPath(controller), join(root, 'scripts/local-ci.mjs'));
    const bin = join(root, 'bin');
    await mkdir(bin);
    const trace = join(root, 'limactl.trace');
    const state = join(root, 'vm-running');
    const guest = join(root, '.git/jev-local-ci/trusted/run-guest.sh');
    const stub = String.raw`#!${process.execPath}
const fs = require('node:fs');
const crypto = require('node:crypto');
const cp = require('node:child_process');
const trace = ${JSON.stringify(trace)}, state = ${JSON.stringify(state)}, guest = ${JSON.stringify(guest)};
const args = process.argv.slice(2);
fs.appendFileSync(trace, JSON.stringify(args) + '\n');
if (!process.env.HOME) process.exit(91);
if (args[0] === 'list') {
  console.log(JSON.stringify({name:'jev-plugin-ci',status:fs.existsSync(state)?'Running':'Stopped',arch:'aarch64',config:{plain:true,propagateProxyEnv:false,ssh:{forwardAgent:false,loadDotSSHPubKeys:false,overVsock:false}}}));
} else if (args[0] === 'start') { fs.writeFileSync(state, 'running'); }
else if (args[0] === 'stop') { fs.unlinkSync(state); }
else if (args.includes('sha256sum')) { console.log(crypto.createHash('sha256').update(fs.readFileSync(guest)).digest('hex') + ' helper'); }
else if (args.includes('/usr/local/bin/jev-local-ci-run')) {
  const archive = fs.readFileSync(0);
  const commit = cp.execFileSync('git', ['get-tar-commit-id'], {input:archive,encoding:'utf8'}).trim();
  fs.appendFileSync(trace, JSON.stringify({archiveCommit:commit,expected:args.at(-1),bytes:archive.length}) + '\n');
  if (commit !== args.at(-1)) process.exit(92);
  console.error('guest-failed-after-archive'); process.exit(9);
} else { process.exit(93); }
`;
    await writeFile(join(bin, 'limactl'), stub, {mode: 0o755});
    const installed = await installHook({repoRoot: root, lockRoot: join(root, '.lima/jev-plugin-ci')});
    await writeFile(join(root, 'tracked.txt'), 'dirty content must not enter archive');
    const result = await runCommand(installed.hookPath, [], {
      cwd: root, env: {...process.env, HOME: root, PATH: `${bin}:${process.env.PATH ?? ''}`},
      input: `refs/heads/other ${sha} refs/heads/other ${'0'.repeat(40)}\n`, timeoutMs: 5000,
    });
    assert.equal(result.exitCode, 1, result.stderr);
    const records = (await readFile(trace, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.ok(records.some(args => Array.isArray(args) && args[0] === 'start'));
    assert.ok(records.some(args => Array.isArray(args) && args.includes('sha256sum')));
    assert.ok(records.some(record => record.archiveCommit === sha && record.expected === sha && record.bytes > 0));
    assert.ok(records.some(args => Array.isArray(args) && args[0] === 'stop'));
    const receiptsDir = join(root, '.git/jev-local-ci/receipts');
    const files = await readdir(receiptsDir);
    assert.equal(files.length, 1);
    const receipt = JSON.parse(await readFile(join(receiptsDir, files[0]), 'utf8'));
    assert.equal(receipt.sha, sha);
    assert.equal(receipt.exitCode, 9);
    assert.equal(receipt.platform, 'linux/arm64');
    assert.match(await readFile(receipt.logPath, 'utf8'), /guest-failed-after-archive/);
    assert.equal(existsSync(state), false);
    assert.equal(existsSync(join(root, '.lima/jev-plugin-ci/controller.lock')), false);
  } finally { await rm(root, {recursive: true, force: true}); }
});


test('VM admission rejects mounts, forwarded credentials and missing isolation metadata', () => {
  const valid = {config: {plain: true, propagateProxyEnv: false, ssh: {forwardAgent: false, loadDotSSHPubKeys: false, overVsock: false}}};
  assert.doesNotThrow(() => validateVmRecord(valid));
  for (const config of [
    {...valid.config, mounts: [{location: '/Users'}]},
    {...valid.config, plain: false},
    {...valid.config, propagateProxyEnv: true},
    {...valid.config, ssh: {...valid.config.ssh, forwardAgent: true}},
    undefined,
  ]) assert.throws(() => validateVmRecord({config}), /isolated configuration/);
});


test('failed second install stage preserves the complete active installation', async () => {
  const {root} = await fixture();
  try {
    await mkdir(join(root, 'scripts'));
    await writeFile(join(root, 'scripts/local-ci.mjs'), 'old controller');
    const options = {repoRoot: root, lockRoot: join(root, 'lock')};
    const installed = await installHook(options);
    const paths = [installed.controller, installed.guestRunner, installed.hookPath, join(installed.stateDir, 'trusted/INSTALL.json')];
    const before = await Promise.all(paths.map(path => readFile(path)));
    await writeFile(join(root, 'scripts/local-ci.mjs'), 'new controller');
    await rm(join(root, '.ci/run-guest.sh'));
    await mkdir(join(root, '.ci/run-guest.sh'));
    await assert.rejects(installHook(options), {code: 'EISDIR'});
    const after = await Promise.all(paths.map(path => readFile(path)));
    assert.deepEqual(after, before);
    assert.equal(existsSync(join(root, 'lock/controller.lock')), false);
    assert.equal((await readdir(installed.stateDir)).some(name => name.startsWith('install-')), false);
  } finally { await rm(root, {recursive: true, force: true}); }
});
