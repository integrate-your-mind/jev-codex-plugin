import {createHash, randomUUID} from 'node:crypto';
import {open, mkdir, readFile, writeFile, rm, rename} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {spawn, spawnSync} from 'node:child_process';
import {dirname, join, resolve} from 'node:path';
import {homedir} from 'node:os';
import {fileURLToPath} from 'node:url';

const controllerSource = fileURLToPath(import.meta.url);
const VM_NAME = 'jev-plugin-ci';
const ZERO_SHA = /^0{40}$/;
const SHA = /^[0-9a-f]{40}$/i;
const LOCK_NAME = 'controller.lock';

export function parsePrePush(input) {
  const shas = new Set();
  for (const [lineNumber, line] of input.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    const fields = line.trim().split(/\s+/);
    if (fields.length !== 4 || !SHA.test(fields[1]) || !SHA.test(fields[3])) {
      throw new Error(`Invalid pre-push record on line ${lineNumber + 1}`);
    }
    if (!ZERO_SHA.test(fields[1])) shas.add(fields[1].toLowerCase());
  }
  return [...shas];
}

function git(cwd, args, options = {}) {
  const result = spawnSync('git', args, {cwd, encoding: 'utf8', ...options});
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error((result.stderr || `git ${args.join(' ')} failed`).trim());
  return result.stdout.trim();
}

export function resolveRepository(cwd = process.cwd()) {
  const root = git(cwd, ['rev-parse', '--show-toplevel']);
  const commonDir = resolve(root, git(root, ['rev-parse', '--git-common-dir']));
  return {root, commonDir, stateDir: join(commonDir, 'jev-local-ci')};
}

function strictSha(sha) {
  if (!SHA.test(sha)) throw new Error(`Expected a full 40-character commit SHA: ${sha}`);
  return sha.toLowerCase();
}

function resolveCommit(root, sha) {
  const exact = strictSha(sha);
  return git(root, ['rev-parse', '--verify', `${exact}^{commit}`]).toLowerCase();
}

async function digestFiles(paths) {
  const hash = createHash('sha256');
  for (const path of paths) hash.update(await readFile(path));
  return hash.digest('hex');
}

async function archiveCommit(root, sha) {
  const result = spawnSync('git', ['archive', '--format=tar', sha], {cwd: root, encoding: null, maxBuffer: 128 * 1024 * 1024});
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error((result.stderr?.toString() || 'git archive failed').trim());
  return result.stdout;
}

function assertIsolationConfig(root) {
  const limaPath = join(root, '.ci/lima.yaml');
  if (!existsSync(limaPath)) throw new Error(`Missing Lima isolation config: ${limaPath}`);
  const config = spawnSync('cat', [limaPath], {encoding: 'utf8'}).stdout;
  for (const required of ['plain: true', 'mounts: []', 'forwardAgent: false', 'loadDotSSHPubKeys: false', 'propagateProxyEnv: false', 'overVsock: false']) {
    if (!config.includes(required)) throw new Error(`Lima isolation config missing ${required}`);
  }
}

export function runCommand(command, args, {input, cwd, timeoutMs = 900_000, env, killGraceMs = 5_000} = {}) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(command, args, {cwd, env, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe']});
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    let killTimer;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      resolveResult(result);
    };
    const signal = value => {
      try { if (process.platform !== 'win32') process.kill(-child.pid, value); else child.kill(value); }
      catch { child.kill(value); }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      signal('SIGTERM');
      killTimer = setTimeout(() => { if (!settled) signal('SIGKILL'); }, killGraceMs);
    }, timeoutMs);
    child.once('error', error => {
      if (error.code === 'EPIPE') return;
      if (!settled) reject(error);
    });
    child.stdin.on('error', error => {
      if (error.code !== 'EPIPE' && !settled) reject(error);
    });
    child.once('close', code => {
      finish({exitCode: timedOut ? 124 : (code ?? 1), stdout, stderr, timedOut});
    });
    if (input) child.stdin.end(input);
    else child.stdin.end();
  });
}

function limaEnvironment() { return {PATH: process.env.PATH ?? '', HOME: homedir()}; }

function normalizeArch(value) {
  return value === 'aarch64' ? 'arm64' : value;
}

export function validateVmRecord(record) {
  const config = record?.config ?? record?.configuration;
  if (!config || config.plain !== true || (config.mounts !== undefined && (!Array.isArray(config.mounts) || config.mounts.length !== 0)) || config.propagateProxyEnv !== false || config.ssh?.forwardAgent !== false || config.ssh?.loadDotSSHPubKeys !== false || config.ssh?.overVsock !== false) {
    throw new Error(`Lima VM ${VM_NAME} does not expose the required isolated configuration`);
  }
}

async function inspectVm({start = true} = {}) {
  const result = spawnSync('limactl', ['list', '--json', VM_NAME], {encoding: 'utf8', env: limaEnvironment()});
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error((result.stderr || `Lima VM ${VM_NAME} is unavailable`).trim());
  const text = result.stdout.trim();
  let records;
  try { records = JSON.parse(text); } catch { throw new Error('limactl list --json returned invalid JSON'); }
  const record = Array.isArray(records) ? records.find(item => item.name === VM_NAME) : records?.name === VM_NAME ? records : undefined;
  if (!record) throw new Error(`Lima VM ${VM_NAME} was not listed`);
  validateVmRecord(record);
  if (!['Running', 'running'].includes(record.status)) {
    if (!start) throw new Error(`Lima VM ${VM_NAME} is not running`);
    console.error(`Starting isolated Lima VM ${VM_NAME}`);
    const started = await runCommand('limactl', ['start', '--tty=false', '--timeout=90s', VM_NAME], {timeoutMs: 120_000, env: limaEnvironment()});
    if (started.exitCode !== 0) throw new Error((started.stderr || `Failed to start Lima VM ${VM_NAME}`).trim());
    return inspectVm({start: false});
  }
  return record;
}

export async function acquireLock(stateDir, lockRoot = join(homedir(), '.lima', VM_NAME)) {
  await mkdir(stateDir, {recursive: true, mode: 0o700});
  await mkdir(lockRoot, {recursive: true, mode: 0o700});
  const handle = await open(join(lockRoot, LOCK_NAME), 'wx', 0o600);
  await handle.writeFile(`${process.pid}\n`);
  return async () => { await handle.close(); await rm(join(lockRoot, LOCK_NAME), {force: true}); };
}

async function writeReceipt(receiptPath, receipt) {
  const temporary = `${receiptPath}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(receipt, null, 2)}\n`, {mode: 0o600});
  await rename(temporary, receiptPath);
}

function hostPlatform() { return `${process.platform}/${process.arch}`; }

export async function runVerification({sha, cwd = process.cwd(), execute, inspect = inspectVm, stop = true, now = () => new Date().toISOString(), lockRoot} = {}) {
  const {root, stateDir} = resolveRepository(cwd);
  const exactSha = resolveCommit(root, sha);
  console.error(`Verifying commit ${exactSha} through local Actions`);
  const receiptsDir = join(stateDir, 'receipts');
  const logsDir = join(stateDir, 'logs');
  await mkdir(receiptsDir, {recursive: true, mode: 0o700});
  await mkdir(logsDir, {recursive: true, mode: 0o700});
  const release = await acquireLock(stateDir, lockRoot);
  let controllerDigest;
  let trustedGuest;
  try {
    trustedGuest = controllerSource === join(stateDir, 'trusted/local-ci.mjs')
      ? join(dirname(controllerSource), 'run-guest.sh')
      : join(root, '.ci/run-guest.sh');
    controllerDigest = await digestFiles([controllerSource, trustedGuest]);
  }
  catch (error) { await release(); throw error; }
  const startedAt = now();
  const runId = randomUUID();
  const logPath = join(logsDir, `${exactSha}-${runId}.log`);
  const receiptPath = join(receiptsDir, `${exactSha}-${controllerDigest}-${runId}.json`);
  let exitCode = 1;
  let output = '';
  let guestPlatform = null;
  try {
    assertIsolationConfig(root);
    if (!execute) {
      const vm = await inspect();
      guestPlatform = `linux/${normalizeArch(vm.arch ?? vm.architecture ?? 'arm64')}`;
    }
    const archive = await archiveCommit(root, exactSha);
    const guestDigest = await digestFiles([trustedGuest]);
    const result = execute ? await execute({sha: exactSha, archive, root, guestDigest}) : await runGuest({sha: exactSha, archive, guestDigest});
    exitCode = result.exitCode;
    output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  } catch (error) {
    output = `${output}${error instanceof Error ? error.stack ?? error.message : String(error)}\n`;
    exitCode = 1;
  } finally {
    if (stop && !execute) {
      try {
        const stopped = await runCommand('limactl', ['stop', VM_NAME], {timeoutMs: 120_000, env: limaEnvironment()});
        output += `${stopped.stdout}${stopped.stderr}`;
        if (stopped.exitCode !== 0 && exitCode === 0) exitCode = stopped.exitCode;
      } catch (error) {
        output += `${error instanceof Error ? error.message : String(error)}\n`;
        if (exitCode === 0) exitCode = 1;
      }
    }
    await release();
  }
  await writeFile(logPath, output, {mode: 0o600});
  const receipt = {sha: exactSha, controllerDigest, startedAt, finishedAt: now(), exitCode, platform: guestPlatform, hostPlatform: hostPlatform(), logPath, receiptPath};
  await writeReceipt(receiptPath, receipt);
  if (exitCode !== 0) throw Object.assign(new Error(`Local CI failed for ${exactSha}`), {receipt});
  return receipt;
}

async function runGuest({sha, archive, guestDigest}) {
  const isolatedEnv = ['sudo', '-n', 'env', '-i', 'PATH=/usr/local/bin:/usr/bin:/bin'];
  const digestCheck = await runCommand('limactl', ['shell', '--workdir', '/tmp', VM_NAME, ...isolatedEnv, 'sha256sum', '/usr/local/bin/jev-local-ci-run'], {env: limaEnvironment(), timeoutMs: 120_000});
  if (digestCheck.exitCode !== 0) throw new Error(`Remote guest helper digest check failed: ${digestCheck.stderr.trim()}`);
  const remoteDigest = digestCheck.stdout.trim().split(/\s+/)[0];
  if (remoteDigest !== guestDigest) throw new Error(`Remote guest helper digest mismatch: expected ${guestDigest}, got ${remoteDigest || 'none'}`);
  return runCommand('limactl', ['shell', '--workdir', '/tmp', VM_NAME, ...isolatedEnv, '/usr/local/bin/jev-local-ci-run', sha], {input: archive, env: limaEnvironment()});
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === '--pre-push') {
    if (args.length !== 1) throw new Error('Usage: local-ci.mjs --pre-push');
    const shas = parsePrePush(await new Promise(resolveInput => { let input = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', chunk => { input += chunk; }); process.stdin.on('end', () => resolveInput(input)); }));
    for (const sha of shas) {
      const receipt = await runVerification({sha});
      reportReceipt(receipt);
    }
    return;
  }
  if (args.length !== 1) throw new Error('Usage: local-ci.mjs <full-commit-sha>');
  reportReceipt(await runVerification({sha: args[0]}));
}

function reportReceipt(receipt) {
  const outcome = receipt.exitCode === 0 ? 'passed' : 'failed';
  console.log(`Local CI ${outcome} for ${receipt.sha}; log=${receipt.logPath}; receipt=${receipt.receiptPath}`);
}

if (process.argv[1]?.endsWith('/local-ci.mjs')) main().catch(error => {
  if (error?.receipt) {
    console.error(`Local CI failed for ${error.receipt.sha}; log=${error.receipt.logPath}; receipt=${error.receipt.receiptPath}`);
  } else {
    console.error(error instanceof Error ? error.message : String(error));
  }
  process.exitCode = 1;
});
