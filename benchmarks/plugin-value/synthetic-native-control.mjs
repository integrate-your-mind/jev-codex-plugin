#!/usr/bin/env node

import assert from 'node:assert/strict';
import {createHash, randomBytes} from 'node:crypto';
import {execFile, spawn} from 'node:child_process';
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  readlink,
  realpath,
  symlink,
  writeFile,
} from 'node:fs/promises';
import {basename, dirname, join, relative, resolve, sep} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const CONTROL_SCHEMA = 'plugin-value-synthetic-native-control-v1';
const RUNTIME_SCHEMA = 'plugin-value-runtime-v1';
const IMAGE_TASK = 'ipython-session-bundle-replay';
const RUNTIME_MOUNT = '/opt/jev-codex-runtime';
const FORBIDDEN_ENV = ['TYPESAFE_API_KEY', 'JEV_API_KEY', 'JEV_API_KEY_FILE', 'OPENAI_API_KEY', 'CODEX_ACCESS_TOKEN'];
const MODEL_COMMAND_SOURCES = new Set(['unifiedExecStartup', 'unifiedExecInteraction']);
const SHA256 = /^[0-9a-f]{64}$/;
const DRIVER_PATH = fileURLToPath(import.meta.url);

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function fileSha256(path) {
  return sha256(await readFile(path));
}

async function writeJsonDurable(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, {encoding: 'utf8', mode: 0o600});
  const handle = await open(path, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

function pathContains(ancestor, candidate) {
  const value = relative(resolve(ancestor), resolve(candidate));
  return value === '' || (!value.startsWith(`..${sep}`) && value !== '..' && !value.startsWith('/'));
}

function safeMountPath(path, label) {
  assert.equal(path.includes(','), false, `${label} cannot contain a comma`);
  assert.equal(/[\r\n]/.test(path), false, `${label} cannot contain a newline`);
  return path;
}

async function execCapture(command, args, options = {}) {
  return new Promise(resolvePromise => {
    execFile(command, args, {encoding: 'utf8', maxBuffer: 4_000_000, ...options}, (error, stdout, stderr) => {
      resolvePromise({code: error?.code ?? 0, stdout: stdout ?? '', stderr: stderr ?? '', error});
    });
  });
}

async function spawnCapture(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {...options, stdio: ['ignore', 'pipe', 'pipe']});
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    child.stdout.on('data', value => { stdoutBytes += value.length; if (stdoutBytes <= 4_000_000) stdout.push(value); });
    child.stderr.on('data', value => { stderrBytes += value.length; if (stderrBytes <= 4_000_000) stderr.push(value); });
    child.on('error', reject);
    child.on('close', (code, signal) => resolvePromise({
      code: code ?? 1,
      signal,
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8'),
      stdoutBytes,
      stderrBytes,
    }));
  });
}

async function listTree(root, relativeDirectory = '') {
  const directory = join(root, relativeDirectory);
  const entries = await readdir(directory, {withFileTypes: true});
  const values = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const path = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
    values.push(path);
    if (entry.isDirectory()) values.push(...await listTree(root, path));
  }
  return values;
}

async function runtimeTreeSha256(root) {
  const digest = createHash('sha256');
  for (const path of await listTree(root)) {
    if (path === 'runtime-manifest.json') continue;
    const absolute = join(root, path);
    const metadata = await lstat(absolute);
    const mode = (metadata.mode & 0o7777).toString(8);
    if (metadata.isSymbolicLink()) {
      const target = await readlink(absolute);
      const resolved = await realpath(absolute);
      assert.equal(pathContains(root, resolved), true, `runtime symlink escapes bundle: ${path}`);
      digest.update(`L\0${path}\0${mode}\0${target}\n`);
    } else if (metadata.isDirectory()) {
      digest.update(`D\0${path}\0${mode}\n`);
    } else if (metadata.isFile()) {
      digest.update(`F\0${path}\0${mode}\0${await fileSha256(absolute)}\n`);
    } else {
      throw new Error(`unsupported runtime entry: ${path}`);
    }
  }
  return digest.digest('hex');
}

function requiredOption(options, name) {
  const value = options[name];
  if (typeof value !== 'string' || value.length === 0) throw new Error(`--${name} is required`);
  return value;
}

export function parseOptions(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const token = argv[index];
    if (!token?.startsWith('--') || argv[index + 1] === undefined) throw new Error(`invalid option: ${token ?? ''}`);
    const key = token.slice(2);
    if (values[key] !== undefined) throw new Error(`duplicate option: ${token}`);
    values[key] = argv[index + 1];
  }
  const arm = requiredOption(values, 'arm');
  if (!['baseline', 'treatment'].includes(arm)) throw new Error('--arm must be baseline or treatment');
  return {
    arm,
    output: resolve(requiredOption(values, 'output')),
    identity: resolve(requiredOption(values, 'identity')),
    imageLedger: resolve(requiredOption(values, 'image-ledger')),
    runtimeBundle: resolve(requiredOption(values, 'runtime-bundle')),
    hostRunner: resolve(requiredOption(values, 'host-runner')),
    node: resolve(requiredOption(values, 'node')),
    codex: resolve(requiredOption(values, 'codex')),
    docker: resolve(requiredOption(values, 'docker')),
    turnTimeoutMs: Number(values['turn-timeout-ms'] ?? 900_000),
  };
}

export function buildSyntheticInstruction(arm) {
  const jev = arm === 'treatment' ? [
    'Before changing files, call the Jev MCP tools jev_status and classify_decision.',
    'For classify_decision, set mode="evaluate" and ask whether the evidence-gathering sequence should read the nonce before editing; supply two harmless candidate sequences.',
    'The user has authorized this bounded Jev provider evaluation for benchmark QA. Send only the synthetic question, candidates, and evidence needed for that decision.',
    'Continue regardless of whether Jev assesses or abstains; it is advisory.',
  ] : [];
  return [
    'This is a synthetic native tool-routing control, outside the scored benchmark.',
    ...jev,
    'From the selected workspace, without changing directories, use a shell command to run pwd -P, read READ_ME.txt, and create command-proof.txt.',
    'command-proof.txt must contain exactly two lines: read_nonce=<the value after READ_NONCE=> and cwd=/app.',
    'Then use the apply_patch tool to change the only line in patch-target.txt from state=before to state=after:<the same nonce>.',
    'Use a final shell command to read command-proof.txt and patch-target.txt. Do not create or modify any other workspace file.',
    'Do not use network access, subagents, or ask for approval.',
  ].join('\n');
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

export function buildVerifierScript(nonce, {submission = '/submission', output = '/logs/verifier'} = {}) {
  assert.match(nonce, /^[0-9a-f]{32}$/);
  assert.equal(submission.startsWith('/'), true, 'verifier submission path must be absolute');
  assert.equal(output.startsWith('/'), true, 'verifier output path must be absolute');
  return `#!/bin/sh
set -eu
submission=${shellQuote(submission)}
result=${shellQuote(join(output, 'verification.json'))}
fail() { printf '%s\n' '{"schemaVersion":"plugin-value-synthetic-verifier-v1","passed":false}' > "$result"; exit 1; }
for path in READ_ME.txt command-proof.txt patch-target.txt unchanged.txt; do
  test -f "$submission/$path" && test ! -L "$submission/$path" || fail
done
test "$(cat "$submission/READ_ME.txt")" = "READ_NONCE=${nonce}" || fail
test "$(cat "$submission/command-proof.txt")" = "read_nonce=${nonce}
cwd=/app" || fail
test "$(cat "$submission/patch-target.txt")" = "state=after:${nonce}" || fail
test "$(cat "$submission/unchanged.txt")" = "unchanged-control" || fail
actual=$(find "$submission" -mindepth 1 -maxdepth 1 -exec basename {} \\; | LC_ALL=C sort)
expected=$(printf '%s\n' READ_ME.txt command-proof.txt patch-target.txt unchanged.txt | LC_ALL=C sort)
test "$actual" = "$expected" || fail
printf '%s\n' '{"schemaVersion":"plugin-value-synthetic-verifier-v1","passed":true}' > "$result"
`;
}

function normalizedChangePath(value, expectedAlias) {
  if (typeof value !== 'string') return null;
  if (value.startsWith('/app/')) return value.slice('/app/'.length);
  if (value.startsWith(`${expectedAlias}/`)) return value.slice(expectedAlias.length + 1);
  return value.replace(/^\.\//, '');
}

export function validateControlReceipt(receipt, arm, expectedAlias) {
  assert.equal(typeof expectedAlias, 'string', 'expected workspace alias is missing');
  assert.equal(expectedAlias.startsWith('/'), true, 'expected workspace alias must be absolute');
  assert.notEqual(expectedAlias, '/app', 'selected workspace alias must remain distinct from its canonical target');
  assert.equal(receipt?.schemaVersion, RUNTIME_SCHEMA, 'host runner receipt schema drifted');
  assert.equal(receipt?.arm, arm, 'host runner receipt arm drifted');
  assert.equal(receipt?.status, 'passed', 'host runner did not pass');
  assert.equal(receipt?.preflightOnly, false, 'synthetic control must execute one model turn');
  assert.equal(receipt?.environment?.status, 'ready', 'remote environment was not ready');
  assert.equal(receipt?.environment?.cwd, 'file:///app', 'remote environment cwd drifted');
  assert.equal(receipt?.environment?.selectedCwdAlias, expectedAlias, 'remote environment selected alias drifted');
  assert.equal(receipt?.environment?.canonicalCwd, '/app', 'remote environment canonical cwd drifted');
  assert.equal(receipt?.workspaceAlias?.selectedCwdAlias, expectedAlias, 'container workspace alias drifted');
  assert.equal(receipt?.workspaceAlias?.canonicalTarget, '/app', 'container workspace alias target drifted');
  assert.deepEqual(receipt?.workspaceAlias?.taskUserAccess, {
    selectedCwdAlias: expectedAlias,
    canonicalCwd: '/app',
    accessible: true,
  }, 'container workspace alias was not accessible to the task user');
  assert.equal(receipt?.workspaceAlias?.cleanup?.removed, true, 'container workspace alias was not cleaned');
  assert.deepEqual(receipt?.modelEnvironmentSelection, [{
    environmentId: 'deep-swe',
    cwd: expectedAlias,
    runtimeWorkspaceRoots: [expectedAlias],
  }], 'model execution environment selection drifted');
  assert.equal(receipt?.turn?.status, 'completed', 'model turn did not complete');
  assert.equal(receipt?.evidence?.sessions, true, 'Codex session evidence is missing');

  const items = (receipt?.events ?? []).filter(event => event?.method === 'item/completed').map(event => event.item);
  const commands = items.filter(item => item?.type === 'commandExecution');
  assert.equal(commands.length > 0, true, 'no remote model shell command was recorded');
  assert.equal(commands.every(item => MODEL_COMMAND_SOURCES.has(item.source)), true, 'command receipt contains a user-shell or unknown source');
  assert.equal(commands.some(item => item.status === 'completed' && item.exitCode === 0 && item.cwd === expectedAlias), true, 'no completed remote model shell command from the selected alias');
  const changes = items.filter(item => item?.type === 'fileChange' && item.status === 'completed').flatMap(item => item.changes ?? []);
  assert.equal(changes.some(change => normalizedChangePath(change.path, expectedAlias) === 'patch-target.txt'), true, 'apply_patch did not change patch-target.txt');

  const mcp = items.filter(item => item?.type === 'mcpToolCall');
  const hooks = (receipt?.events ?? []).filter(event => event?.method === 'hook/completed').map(event => event.hook);
  if (arm === 'baseline') {
    assert.equal(mcp.some(item => item.pluginId === 'jev-workflows@personal' || item.server === 'jev-workflows'), false, 'baseline invoked Jev MCP');
    assert.equal(hooks.some(hook => hook?.source === 'plugin'), false, 'baseline ran plugin hooks');
  } else {
    assert.equal(receipt?.evidence?.jevState, true, 'treatment Jev evidence is missing');
    for (const tool of ['jev_status', 'classify_decision']) {
      const call = mcp.find(item => item.tool === tool && item.status === 'completed' && item.pluginId === 'jev-workflows@personal');
      assert.ok(call, `treatment did not complete ${tool}`);
      if (tool === 'classify_decision') {
        assert.equal(['assessed', 'abstained'].includes(call.result?.status), true, 'Jev classification returned no decision status');
        assert.equal(call.result?.receiptPersisted, true, 'Jev classification receipt was not persisted');
        assert.equal(call.result?.transport?.fetchInvoked, true, 'Jev classification did not call the provider');
        assert.equal(call.result?.transport?.responseStatus, 200, 'Jev classification provider status was not HTTP 200');
        assert.equal(call.result?.transport?.validatedResponse, true, 'Jev provider response was not validated');
      }
    }
    for (const eventName of ['preToolUse', 'postToolUse']) {
      assert.equal(hooks.some(hook => hook?.source === 'plugin' && hook.eventName === eventName && hook.status === 'completed'), true, `treatment ${eventName} hook did not complete`);
    }
  }
  return {commands: commands.length, fileChanges: changes.length, mcpCalls: mcp.length, hookRuns: hooks.length};
}

export function validateAgentInspection(inspection, {image, workspace, runtimeBundle}) {
  assert.equal(inspection?.Config?.Image, image, 'agent container image drifted');
  assert.equal(inspection?.Config?.WorkingDir, '/app', 'agent container workdir drifted');
  assert.equal(inspection?.HostConfig?.NetworkMode, 'none', 'agent container network is enabled');
  assert.equal(Boolean(inspection?.HostConfig?.Privileged), false, 'agent container is privileged');
  assert.equal((inspection?.HostConfig?.CapAdd ?? []).length, 0, 'agent container adds Linux capabilities');
  assert.notEqual(inspection?.HostConfig?.PidMode, 'host', 'agent container shares the host PID namespace');
  assert.notEqual(inspection?.HostConfig?.IpcMode, 'host', 'agent container shares the host IPC namespace');
  assert.equal((inspection?.HostConfig?.Devices ?? []).length, 0, 'agent container exposes host devices');
  assert.equal((inspection?.HostConfig?.DeviceRequests ?? []).length, 0, 'agent container requests host devices');
  const envNames = (inspection?.Config?.Env ?? []).map(value => String(value).split('=', 1)[0]);
  for (const key of FORBIDDEN_ENV) assert.equal(envNames.includes(key), false, `agent container exposes ${key}`);
  const mounts = inspection?.Mounts ?? [];
  assert.equal(mounts.length, 2, 'agent container has an unexpected mount');
  const workspaceMounts = mounts.filter(mount => mount?.Destination === '/app');
  const runtimeMounts = mounts.filter(mount => mount?.Destination === RUNTIME_MOUNT);
  assert.equal(workspaceMounts.length, 1, 'agent container needs exactly one /app mount');
  assert.equal(runtimeMounts.length, 1, 'agent container needs exactly one runtime mount');
  assert.equal(resolve(workspaceMounts[0].Source), resolve(workspace), 'agent workspace source drifted');
  assert.equal(workspaceMounts[0].RW, true, 'agent workspace must be writable');
  assert.equal(resolve(runtimeMounts[0].Source), resolve(runtimeBundle), 'agent runtime source drifted');
  assert.equal(runtimeMounts[0].RW, false, 'agent runtime mount must be read-only');
  assert.equal(mounts.some(mount => String(mount?.Source).endsWith('/docker.sock') || mount?.Destination === '/var/run/docker.sock'), false, 'agent container exposes the Docker socket');
  return {networkMode: 'none', workspaceReadWrite: true, runtimeReadOnly: true, credentialsPresent: false};
}

export function validateVerifierInspection(inspection, {image, workspace, oracle, output}) {
  assert.equal(inspection?.Config?.Image, image, 'verifier image drifted');
  assert.equal(inspection?.HostConfig?.NetworkMode, 'none', 'verifier network is enabled');
  assert.equal(Boolean(inspection?.HostConfig?.Privileged), false, 'verifier is privileged');
  assert.equal((inspection?.HostConfig?.CapAdd ?? []).length, 0, 'verifier adds Linux capabilities');
  assert.notEqual(inspection?.HostConfig?.PidMode, 'host', 'verifier shares the host PID namespace');
  assert.notEqual(inspection?.HostConfig?.IpcMode, 'host', 'verifier shares the host IPC namespace');
  assert.equal((inspection?.HostConfig?.Devices ?? []).length, 0, 'verifier exposes host devices');
  assert.equal((inspection?.HostConfig?.DeviceRequests ?? []).length, 0, 'verifier requests host devices');
  const mounts = inspection?.Mounts ?? [];
  assert.equal(mounts.some(mount => mount?.Destination === RUNTIME_MOUNT), false, 'verifier exposes the agent runtime');
  assert.equal(mounts.length, 3, 'verifier has an unexpected mount');
  for (const [destination, source, writable] of [
    ['/submission', workspace, false],
    ['/tests', oracle, false],
    ['/logs/verifier', output, true],
  ]) {
    const matches = mounts.filter(mount => mount?.Destination === destination);
    assert.equal(matches.length, 1, `verifier mount ${destination} drifted`);
    assert.equal(resolve(matches[0].Source), resolve(source), `verifier source ${destination} drifted`);
    assert.equal(matches[0].RW, writable, `verifier mode ${destination} drifted`);
  }
  return {networkMode: 'none', runtimePresent: false, workspaceReadOnly: true};
}

export function validateLocalImageInspection(inspection, image) {
  assert.equal(inspection?.Os, 'linux', 'synthetic base image OS drifted');
  assert.equal(inspection?.Architecture, 'amd64', 'synthetic base image architecture drifted');
  assert.equal((inspection?.RepoDigests ?? []).includes(image), true, 'digest-pinned synthetic base image is not present locally');
  assert.match(inspection?.Id ?? '', /^sha256:[0-9a-f]{64}$/, 'synthetic base image id is invalid');
  return {id: inspection.Id, os: inspection.Os, architecture: inspection.Architecture, digest: image};
}

export async function validateControlInputs(options) {
  for (const [label, path] of Object.entries({
    identity: options.identity,
    imageLedger: options.imageLedger,
    runtimeBundle: options.runtimeBundle,
    hostRunner: options.hostRunner,
    node: options.node,
    codex: options.codex,
    docker: options.docker,
  })) {
    const canonical = await realpath(path);
    assert.equal((await lstat(canonical)).isSymbolicLink(), false, `${label} canonical path cannot be a symlink`);
    options[label] = canonical;
  }
  const identity = JSON.parse(await readFile(options.identity, 'utf8'));
  assert.equal(identity.schemaVersion, 'plugin-value-runtime-identity-v1');
  assert.equal(identity.executionReady, false, 'synthetic control must not use a score-ready identity as an implicit scored run');
  const identitySha256 = await fileSha256(options.identity);
  const imageLedgerSha256 = await fileSha256(options.imageLedger);
  assert.equal(imageLedgerSha256, identity.dataset?.imageIdentityLedgerSha256, 'image identity ledger sha256 drifted');
  const driverSha256 = await fileSha256(DRIVER_PATH);
  assert.equal(driverSha256, identity.syntheticNativeControl?.driverSha256, 'synthetic control driver sha256 drifted');
  const expected = identity.hostRuntime;
  for (const [path, digest, label] of [
    [options.node, expected.node.sha256, 'Node'],
    [options.codex, expected.codex.sha256, 'Codex'],
    [options.docker, expected.docker.sha256, 'Docker'],
    [options.hostRunner, expected.runner.sha256, 'host runner'],
  ]) assert.equal(await fileSha256(path), digest, `${label} sha256 drifted`);

  const runtimeManifestPath = join(options.runtimeBundle, 'runtime-manifest.json');
  assert.equal(await fileSha256(runtimeManifestPath), identity.sharedRuntime.manifestSha256, 'runtime manifest sha256 drifted');
  assert.equal(await runtimeTreeSha256(options.runtimeBundle), identity.sharedRuntime.treeSha256, 'runtime tree sha256 drifted');
  const runtimeManifest = JSON.parse(await readFile(runtimeManifestPath, 'utf8'));
  assert.equal(runtimeManifest.treeSha256, identity.sharedRuntime.treeSha256, 'runtime manifest tree identity drifted');
  for (const name of ['node', 'codex']) {
    const executable = runtimeManifest.executables?.[name];
    assert.match(executable?.sha256 ?? '', SHA256, `runtime ${name} digest is invalid`);
    assert.equal(await fileSha256(join(options.runtimeBundle, executable.path)), executable.sha256, `runtime ${name} sha256 drifted`);
  }

  const ledger = JSON.parse(await readFile(options.imageLedger, 'utf8'));
  assert.equal(ledger.schemaVersion, 'jev-plugin-value-image-identities-v1');
  const image = ledger.images?.find(item => item.taskId === IMAGE_TASK);
  assert.ok(image, 'synthetic base image is absent from the ledger');
  assert.match(image.manifestDigest ?? '', /^sha256:[0-9a-f]{64}$/);
  return {
    identity,
    identitySha256,
    imageLedgerSha256,
    driverSha256,
    runtimeManifest,
    image: `${image.repository}@${image.manifestDigest}`,
    imageIdentity: image,
  };
}

async function dockerInspect(docker, containerId) {
  const inspected = await execCapture(docker, ['container', 'inspect', containerId]);
  if (inspected.code !== 0) throw new Error(`docker inspect failed: ${inspected.stderr.slice(-500)}`);
  const values = JSON.parse(inspected.stdout);
  assert.equal(Array.isArray(values) && values.length === 1, true, 'docker inspect returned an unexpected shape');
  return values[0];
}

async function inspectLocalImage(docker, image) {
  const inspected = await execCapture(docker, ['image', 'inspect', image]);
  if (inspected.code !== 0) throw new Error(`pinned synthetic image is not locally available: ${inspected.stderr.slice(-500)}`);
  const values = JSON.parse(inspected.stdout);
  assert.equal(Array.isArray(values) && values.length === 1, true, 'docker image inspect returned an unexpected shape');
  validateLocalImageInspection(values[0], image);
  return values[0];
}

async function dockerCommand(docker, args, label) {
  const result = await execCapture(docker, args);
  if (result.code !== 0) throw new Error(`${label} failed: ${result.stderr.slice(-500)}`);
  return result.stdout.trim();
}

function runnerEnvironment(hostControl) {
  const allowed = ['HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'TMPDIR', 'CODEX_HOME', 'TYPESAFE_API_KEY', 'JEV_API_KEY_FILE', 'PLUGIN_VALUE_PLUGIN_DIR', 'PLUGIN_VALUE_SOURCE_CODEX_HOME'];
  const env = Object.fromEntries(allowed.flatMap(key => process.env[key] === undefined ? [] : [[key, process.env[key]]]));
  env.PATH = `${join(hostControl, 'bin')}:/usr/bin:/bin:/usr/sbin:/sbin`;
  return env;
}

async function createAgentContainer(options, validated, workspace, name) {
  const id = await dockerCommand(options.docker, [
    'create', '--platform', 'linux/amd64', '--network', 'none', '--workdir', '/app',
    '--label', `com.openai.jev.synthetic-control=${basename(options.output)}`,
    '--mount', `type=bind,src=${safeMountPath(workspace, 'workspace')},dst=/app`,
    '--mount', `type=bind,src=${safeMountPath(options.runtimeBundle, 'runtime bundle')},dst=${RUNTIME_MOUNT},readonly`,
    '--name', name, '--entrypoint', '/bin/sh', validated.image,
    '-c', 'trap "exit 0" TERM INT; while :; do sleep 3600; done',
  ], 'agent container create');
  try {
    assert.match(id, /^[0-9a-f]{64}$/);
    await dockerCommand(options.docker, ['start', id], 'agent container start');
    const inspection = await dockerInspect(options.docker, id);
    validateAgentInspection(inspection, {image: validated.image, workspace, runtimeBundle: options.runtimeBundle});
    return {id, inspection};
  } catch (error) {
    await cleanupContainer(options.docker, id);
    throw error;
  }
}

async function setupAgentRuntime(options, validated, containerId) {
  const runtimeNode = `${RUNTIME_MOUNT}/${validated.runtimeManifest.executables.node.path}`;
  const runtimeCodex = `${RUNTIME_MOUNT}/${validated.runtimeManifest.executables.codex.path}`;
  const checksumScript = "const fs=require('node:fs'),c=require('node:crypto');for(const p of process.argv.slice(1))console.log(c.createHash('sha256').update(fs.readFileSync(p)).digest('hex'))";
  const checksums = await dockerCommand(options.docker, ['exec', '-u', '0', containerId, runtimeNode, '-e', checksumScript, runtimeCodex, runtimeNode], 'runtime checksum');
  assert.deepEqual(checksums.split('\n'), [validated.runtimeManifest.executables.codex.sha256, validated.runtimeManifest.executables.node.sha256]);
  await dockerCommand(options.docker, ['exec', '-u', '0', containerId, '/bin/sh', '-c',
    `mkdir -p /usr/local/bin /installed-agent && ln -sfn '${runtimeNode}' /usr/local/bin/node && ln -sfn '${runtimeCodex}' /usr/local/bin/codex && umask 077 && test ! -e /installed-agent/codex-exec-home && test ! -e /installed-agent/codex-exec-launcher && mkdir /installed-agent/codex-exec-home /installed-agent/codex-exec-launcher && chmod 700 /installed-agent/codex-exec-home /installed-agent/codex-exec-launcher`,
  ], 'runtime setup');
  assert.equal(await dockerCommand(options.docker, ['exec', '-u', '0', containerId, '/usr/local/bin/codex', '--version'], 'Codex version'), 'codex-cli 0.155.0');
}

async function runHostControl(options, containerId, hostControl) {
  await mkdir(hostControl, {mode: 0o700});
  const bin = join(hostControl, 'bin');
  await mkdir(bin, {mode: 0o700});
  await symlink(options.node, join(bin, 'node'));
  const selectedCwdAlias = join(hostControl, 'workspace');
  const request = {
    schemaVersion: RUNTIME_SCHEMA,
    arm: options.arm,
    containerId,
    containerUser: null,
    dockerPath: options.docker,
    dockerSha256: await fileSha256(options.docker),
    nodePath: options.node,
    nodeSha256: await fileSha256(options.node),
    codexPath: options.codex,
    codexSha256: await fileSha256(options.codex),
    instruction: buildSyntheticInstruction(options.arm),
    logsDir: hostControl,
    model: 'gpt-6-astra',
    effort: 'medium',
    remoteCwd: selectedCwdAlias,
    hostCwd: selectedCwdAlias,
    runtimeHome: join(hostControl, 'runtime-home'),
    turnTimeoutMs: options.turnTimeoutMs,
    preflightOnly: false,
  };
  const requestPath = join(hostControl, 'host-runner-request.json');
  const resultPath = join(hostControl, 'host-runner-result.json');
  await writeJsonDurable(requestPath, request);
  const result = await spawnCapture(options.node, [options.hostRunner, '--request', requestPath, '--result', resultPath], {
    cwd: hostControl,
    env: runnerEnvironment(hostControl),
  });
  await writeFile(join(hostControl, 'host-runner.stdout'), result.stdout, {mode: 0o600});
  await writeFile(join(hostControl, 'host-runner.stderr'), result.stderr, {mode: 0o600});
  const receipt = JSON.parse(await readFile(join(hostControl, 'runtime-evidence.json'), 'utf8'));
  if (result.code !== 0) throw new Error(`host runner failed: ${receipt?.failure?.message ?? result.stderr.slice(-500)}`);
  return {receipt, eventSummary: validateControlReceipt(receipt, options.arm, selectedCwdAlias)};
}

async function runVerifier(options, validated, workspace, oracle, verifierOutput, name) {
  const id = await dockerCommand(options.docker, [
    'create', '--platform', 'linux/amd64', '--network', 'none', '--workdir', '/submission',
    '--label', `com.openai.jev.synthetic-verifier=${basename(options.output)}`,
    '--mount', `type=bind,src=${safeMountPath(workspace, 'workspace')},dst=/submission,readonly`,
    '--mount', `type=bind,src=${safeMountPath(oracle, 'oracle')},dst=/tests,readonly`,
    '--mount', `type=bind,src=${safeMountPath(verifierOutput, 'verifier output')},dst=/logs/verifier`,
    '--name', name, '--entrypoint', '/bin/sh', validated.image, '/tests/verify.sh',
  ], 'verifier container create');
  try {
    const inspection = await dockerInspect(options.docker, id);
    validateVerifierInspection(inspection, {image: validated.image, workspace, oracle, output: verifierOutput});
    await writeJsonDurable(join(options.output, 'verifier-inspect.json'), inspection);
    const execution = await spawnCapture(options.docker, ['start', '-a', id]);
    const completed = await dockerInspect(options.docker, id);
    await writeFile(join(verifierOutput, 'stdout'), execution.stdout, {mode: 0o600});
    await writeFile(join(verifierOutput, 'stderr'), execution.stderr, {mode: 0o600});
    const verdict = JSON.parse(await readFile(join(verifierOutput, 'verification.json'), 'utf8'));
    assert.equal(execution.code, 0, 'independent verifier process failed');
    assert.equal(completed?.State?.ExitCode, 0, 'independent verifier container failed');
    assert.equal(verdict?.passed, true, 'independent verifier rejected the workspace');
    return {id, inspection, execution, verdict};
  } catch (error) {
    await cleanupContainer(options.docker, id);
    throw error;
  }
}

async function cleanupContainer(docker, id, {strict = false} = {}) {
  if (!id) return;
  await execCapture(docker, ['container', 'stop', '--time', '10', id]);
  const removed = await execCapture(docker, ['container', 'rm', id]);
  if (strict && removed.code !== 0) throw new Error(`container cleanup failed: ${removed.stderr.slice(-500)}`);
}

export async function runSyntheticControl(options) {
  assert.equal(Number.isSafeInteger(options.turnTimeoutMs) && options.turnTimeoutMs >= 1_000 && options.turnTimeoutMs <= 10_790_000, true, 'turn timeout is invalid');
  const validated = await validateControlInputs(options);
  await mkdir(options.output, {recursive: false, mode: 0o700});
  await chmod(options.output, 0o700);
  const workspace = join(options.output, 'workspace');
  const hostControl = join(options.output, 'host-control');
  const oracle = join(options.output, 'verifier-oracle');
  const verifierOutput = join(options.output, 'verifier');
  for (const path of [workspace, oracle, verifierOutput]) await mkdir(path, {mode: 0o700});
  const nonce = randomBytes(16).toString('hex');
  await writeFile(join(workspace, 'READ_ME.txt'), `READ_NONCE=${nonce}\n`, {mode: 0o600});
  await writeFile(join(workspace, 'patch-target.txt'), 'state=before\n', {mode: 0o600});
  await writeFile(join(workspace, 'unchanged.txt'), 'unchanged-control\n', {mode: 0o600});
  const verifyScript = join(oracle, 'verify.sh');
  await writeFile(verifyScript, buildVerifierScript(nonce), {mode: 0o500});
  await chmod(verifyScript, 0o500);

  const controlId = `${options.arm}-${randomBytes(6).toString('hex')}`;
  const manifest = {
    schemaVersion: CONTROL_SCHEMA,
    controlId,
    arm: options.arm,
    scored: false,
    status: 'running',
    startedAt: new Date().toISOString(),
    identities: {
      image: validated.image,
      imageManifestDigest: validated.imageIdentity.manifestDigest,
      runtimeManifestSha256: validated.identity.sharedRuntime.manifestSha256,
      runtimeTreeSha256: validated.identity.sharedRuntime.treeSha256,
      hostRunnerSha256: await fileSha256(options.hostRunner),
      syntheticControlDriverSha256: validated.driverSha256,
      runtimeIdentitySha256: validated.identitySha256,
      imageIdentityLedgerSha256: validated.imageLedgerSha256,
      model: 'gpt-6-astra',
      effort: 'medium',
    },
    boundary: {
      turnSandboxPolicy: {type: 'externalSandbox', networkAccess: 'restricted'},
      taskContainerNetwork: 'none',
      taskCredentials: 'none',
      taskSourceMounted: false,
      verifierRuntimeMounted: false,
      selectedCwdAlias: join(hostControl, 'workspace'),
      canonicalRemoteCwd: '/app',
      aliasAddsHostMount: false,
    },
    fixture: {
      nonceSha256: sha256(nonce),
      inputHashes: Object.fromEntries(await Promise.all(['READ_ME.txt', 'patch-target.txt', 'unchanged.txt'].map(async name => [name, await fileSha256(join(workspace, name))]))),
      oracleSha256: await fileSha256(verifyScript),
    },
  };
  await writeJsonDurable(join(options.output, 'control-manifest.json'), manifest);

  let agent;
  let verifier;
  try {
    const imageInspection = await inspectLocalImage(options.docker, validated.image);
    await writeJsonDurable(join(options.output, 'image-inspect.json'), imageInspection);
    agent = await createAgentContainer(options, validated, workspace, `jev-native-${controlId}`);
    await writeJsonDurable(join(options.output, 'agent-inspect.json'), agent.inspection);
    await setupAgentRuntime(options, validated, agent.id);
    const control = await runHostControl(options, agent.id, hostControl);
    const diff = await execCapture(options.docker, ['container', 'diff', agent.id]);
    await writeFile(join(options.output, 'agent-docker-diff.txt'), diff.stdout, {mode: 0o600});
    assert.equal(diff.code, 0, 'docker diff failed');
    await cleanupContainer(options.docker, agent.id, {strict: true});
    agent.id = null;

    verifier = await runVerifier(options, validated, workspace, oracle, verifierOutput, `jev-verify-${controlId}`);
    await cleanupContainer(options.docker, verifier.id, {strict: true});
    verifier.id = null;

    manifest.status = 'passed';
    manifest.completedAt = new Date().toISOString();
    manifest.eventSummary = control.eventSummary;
    manifest.verifier = verifier.verdict;
    manifest.workspaceHashes = Object.fromEntries(await Promise.all(['READ_ME.txt', 'command-proof.txt', 'patch-target.txt', 'unchanged.txt'].map(async name => [name, await fileSha256(join(workspace, name))])));
    await writeJsonDurable(join(options.output, 'control-manifest.json'), manifest);
    return manifest;
  } catch (error) {
    if (agent?.id) {
      const diff = await execCapture(options.docker, ['container', 'diff', agent.id]);
      if (diff.code === 0) await writeFile(join(options.output, 'agent-docker-diff.failed.txt'), diff.stdout, {mode: 0o600});
    }
    manifest.status = 'failed';
    manifest.completedAt = new Date().toISOString();
    manifest.failure = {name: error?.name ?? 'Error', message: String(error?.message ?? error).slice(0, 2_000)};
    await writeJsonDurable(join(options.output, 'control-manifest.json'), manifest);
    throw error;
  } finally {
    await cleanupContainer(options.docker, verifier?.id);
    await cleanupContainer(options.docker, agent?.id);
  }
}

async function main(argv) {
  const options = parseOptions(argv);
  const result = await runSyntheticControl(options);
  process.stdout.write(`${JSON.stringify({schemaVersion: result.schemaVersion, controlId: result.controlId, status: result.status})}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch(error => {
    process.stderr.write(`${error?.stack ?? error}\n`);
    process.exitCode = 1;
  });
}
