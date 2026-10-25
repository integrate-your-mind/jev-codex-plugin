import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {chmod, lstat, mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';

import {
  buildConfigToml,
  buildEnvironmentsToml,
  buildRemoteEnvironmentSelection,
  buildThreadStartParams,
  buildTurnStartParams,
  CONTAINER_WORKSPACE_ALIAS_ACCESS_SCRIPT,
  CONTAINER_WORKSPACE_ALIAS_REMOVE_SCRIPT,
  CONTAINER_WORKSPACE_ALIAS_SETUP_SCRIPT,
  compactHookRun,
  compactMcp,
  replaceStateDirectory,
  validateRequest,
  verifyRemoteEnvironment,
  verifyPinnedPlugin,
  verifyHostRuntimeIdentity,
  verifyModelEnvironmentSelection,
} from '../host-runner.mjs';

const CONTAINER = 'a'.repeat(64);
const request = Object.freeze({
  schemaVersion: 'plugin-value-runtime-v1',
  arm: 'treatment',
  containerId: CONTAINER,
  containerUser: 'agent',
  dockerPath: '/usr/local/bin/docker',
  dockerSha256: 'b'.repeat(64),
  nodePath: '/opt/pinned/node',
  nodeSha256: 'c'.repeat(64),
  codexPath: '/opt/homebrew/bin/codex',
  codexSha256: 'd'.repeat(64),
  instruction: 'repair the repository',
  logsDir: '/tmp/private-results',
  model: 'gpt-6-astra',
  effort: 'medium',
  remoteCwd: '/tmp/private-results/workspace',
  hostCwd: '/tmp/private-results/workspace',
  runtimeHome: '/tmp/private-results/runtime-home',
  turnTimeoutMs: 10_700_000,
  preflightOnly: true,
});

const digest = value => createHash('sha256').update(value).digest('hex');

test('plugin verification binds the complete copied file inventory', async t => {
  const root = await mkdtemp(join(tmpdir(), 'plugin-value-tree-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  await mkdir(join(root, 'skills', 'tool'), {recursive: true});
  const contents = Buffer.from('authenticated skill\n');
  const relativePath = 'skills/tool/SKILL.md';
  await writeFile(join(root, relativePath), contents);
  await writeFile(join(root, '.DS_Store'), 'ignored Finder metadata');
  const expected = {[relativePath]: digest(contents)};
  assert.deepEqual(await verifyPinnedPlugin(root, expected), expected);
  await writeFile(join(root, 'skills', 'tool', 'unbound.md'), 'changes behavior');
  await assert.rejects(verifyPinnedPlugin(root, expected), /file inventory drifted/);
});

test('request pins model, effort, remote cwd, and host hook shadow', () => {
  assert.deepEqual(validateRequest(request), request);
  assert.throws(() => validateRequest({...request, model: 'other'}), /gpt-6-astra/);
  assert.throws(() => validateRequest({...request, remoteCwd: '/tmp/work'}), /remoteCwd/);
  assert.throws(() => validateRequest({...request, hostCwd: '/tmp/work'}), /hostCwd/);
  assert.throws(
    () => validateRequest({...request, logsDir: '/app/host-control', hostCwd: '/app/host-control/workspace', remoteCwd: '/app/host-control/workspace', runtimeHome: '/app/host-control/runtime-home'}),
    /protected task-container path/,
  );
  assert.throws(() => validateRequest({...request, containerId: 'a;touch x'}), /container id/);
  assert.throws(() => validateRequest({...request, nodeSha256: 'not-a-hash'}), /nodeSha256/);
});

test('host runtime identity binds the executing Node and Codex bytes', async t => {
  const root = await mkdtemp(join(tmpdir(), 'plugin-value-host-identity-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const codexPath = join(root, 'codex');
  const dockerPath = join(root, 'docker');
  const controlledBin = join(root, 'bin');
  const codexBytes = '#!/bin/sh\necho codex-cli 0.155.0\n';
  const dockerBytes = '#!/bin/sh\necho "Docker version 29.7.1, build fixture"\n';
  await writeFile(codexPath, codexBytes);
  await writeFile(dockerPath, dockerBytes);
  await chmod(codexPath, 0o500);
  await chmod(dockerPath, 0o500);
  await mkdir(controlledBin);
  await symlink(process.execPath, join(controlledBin, 'node'));
  const nodeBytes = await readFile(process.execPath);
  const identityRequest = {
    ...request,
    nodePath: process.execPath,
    nodeSha256: digest(nodeBytes),
    codexPath,
    codexSha256: digest(codexBytes),
    dockerPath,
    dockerSha256: digest(dockerBytes),
  };
  assert.deepEqual(await verifyHostRuntimeIdentity(identityRequest, {PATH: `${controlledBin}:/usr/bin:/bin`}), {
    nodeVersion: 'v22.23.2',
    nodeSha256: identityRequest.nodeSha256,
    codexVersion: 'codex-cli 0.155.0',
    codexSha256: identityRequest.codexSha256,
    dockerVersion: 'Docker version 29.7.1, build fixture',
    dockerSha256: identityRequest.dockerSha256,
    pluginNodeVersion: 'v22.23.2',
  });
  await assert.rejects(
    verifyHostRuntimeIdentity(
      {...identityRequest, codexSha256: '0'.repeat(64)},
      {PATH: `${controlledBin}:/usr/bin:/bin`},
    ),
    /Codex executable hash drifted/,
  );
});

test('exec-server launcher clears host env and forwards no credential', () => {
  const toml = buildEnvironmentsToml(request);
  assert.match(toml, /include_local = true/);
  assert.match(toml, /default = "deep-swe"/);
  assert.match(toml, /program = "\/usr\/bin\/env"/);
  assert.equal((toml.match(/"-i"/g) ?? []).length, 3);
  assert.match(toml, /"exec", "-i", "-u", "agent", "-w", "\/tmp\/private-results\/workspace"/);
  assert.match(toml, /"\/usr\/bin\/env", "-i", "PATH=\/usr\/local\/bin:\/usr\/bin:\/bin", "HOME=\/installed-agent\/codex-exec-launcher", "CODEX_HOME=\/installed-agent\/codex-exec-home"/);
  assert.doesNotMatch(toml, /CODEX_HOME=\/tmp/);
  assert.doesNotMatch(toml, /OPENAI|TYPESAFE|JEV_API_KEY|auth\.json/);
});

test('thread and turn select only the remote environment with external sandboxing', () => {
  const environments = [{environmentId: 'deep-swe', cwd: request.remoteCwd, runtimeWorkspaceRoots: [request.remoteCwd]}];
  assert.deepEqual(buildRemoteEnvironmentSelection(request), environments);
  assert.deepEqual(buildThreadStartParams(request), {
    cwd: request.hostCwd,
    environments,
    ephemeral: false,
    approvalPolicy: 'never',
    sandbox: 'workspace-write',
    model: 'gpt-6-astra',
  });
  assert.deepEqual(buildTurnStartParams({...request, preflightOnly: false}, 'thread-1'), {
    threadId: 'thread-1',
    environments,
    input: [{type: 'text', text: request.instruction, text_elements: []}],
    model: 'gpt-6-astra',
    effort: 'medium',
    approvalPolicy: 'never',
    sandboxPolicy: {type: 'externalSandbox', networkAccess: 'restricted'},
  });
  assert.deepEqual(verifyModelEnvironmentSelection(environments, request), environments);
  assert.throws(
    () => verifyModelEnvironmentSelection([...environments, {
      environmentId: 'local', cwd: request.hostCwd, runtimeWorkspaceRoots: [request.hostCwd],
    }], request),
    /exactly the deep-swe environment/,
  );
  assert.throws(
    () => verifyModelEnvironmentSelection([{
      environmentId: 'local', cwd: request.hostCwd, runtimeWorkspaceRoots: [request.hostCwd],
    }], request),
    /exactly the deep-swe environment/,
  );
});

test('remote environment proof rejects local, pending, and host-native identities', () => {
  assert.deepEqual(
    verifyRemoteEnvironment(
      {status: 'ready'},
      {cwd: 'file:///app', shell: {name: 'bash', path: '/bin/bash'}},
      request,
    ),
    {
      status: 'ready',
      cwd: 'file:///app',
      selectedCwdAlias: request.remoteCwd,
      canonicalCwd: '/app',
      shell: {name: 'bash', path: '/bin/bash'},
    },
  );
  assert.throws(
    () => verifyRemoteEnvironment({status: 'pending'}, {cwd: 'file:///app', shell: {name: 'sh', path: '/bin/sh'}}, request),
    /not ready/,
  );
  assert.throws(
    () => verifyRemoteEnvironment({status: 'ready'}, {cwd: 'file:\/\/\/tmp\/host', shell: {name: 'zsh', path: '/bin/zsh'}}, request),
    /canonical cwd drifted/,
  );
});

test('container workspace alias scripts reject redirected parents and clean exact owned paths', async t => {
  const traversableTemporaryRoot = process.platform === 'darwin' ? '/private/tmp' : tmpdir();
  const temporary = await mkdtemp(join(traversableTemporaryRoot, 'plugin-value-alias-'));
  t.after(() => rm(temporary, {recursive: true, force: true}));
  const root = await realpath(temporary);
  await chmod(root, 0o711);
  const target = join(root, 'target');
  const alias = join(root, 'owned', 'nested', 'workspace');
  await mkdir(target);
  const setup = spawnSync(process.execPath, ['-e', CONTAINER_WORKSPACE_ALIAS_SETUP_SCRIPT, alias, target], {encoding: 'utf8'});
  assert.equal(setup.status, 0, setup.stderr);
  const setupReceipt = JSON.parse(setup.stdout);
  assert.equal(setupReceipt.selectedCwdAlias, alias);
  assert.equal(setupReceipt.canonicalTarget, target);
  assert.equal((await lstat(alias)).isSymbolicLink(), true);
  assert.equal(await realpath(alias), target);
  for (const directory of setupReceipt.createdDirectories) {
    assert.equal((await lstat(directory)).mode & 0o777, 0o711, 'created alias parents must be traversable without being listable or writable');
  }
  const access = spawnSync(process.execPath, ['-e', CONTAINER_WORKSPACE_ALIAS_ACCESS_SCRIPT, alias, target], {encoding: 'utf8'});
  assert.equal(access.status, 0, access.stderr);
  assert.deepEqual(JSON.parse(access.stdout), {selectedCwdAlias: alias, canonicalCwd: target, accessible: true});
  const cleanup = spawnSync(process.execPath, [
    '-e', CONTAINER_WORKSPACE_ALIAS_REMOVE_SCRIPT, alias, target,
    JSON.stringify(setupReceipt.createdDirectories),
  ], {encoding: 'utf8'});
  assert.equal(cleanup.status, 0, cleanup.stderr);
  assert.equal(JSON.parse(cleanup.stdout).removed, true);
  await assert.rejects(lstat(alias), /ENOENT/);

  const redirectedParent = join(root, 'redirected');
  const otherTarget = join(root, 'other-target');
  await mkdir(otherTarget);
  await symlink(target, redirectedParent);
  const rejected = spawnSync(process.execPath, [
    '-e', CONTAINER_WORKSPACE_ALIAS_SETUP_SCRIPT, join(redirectedParent, 'workspace'), otherTarget,
  ], {encoding: 'utf8'});
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /redirected or not a directory/);
});

test('host config fails closed for task command environment', () => {
  const toml = buildConfigToml(request, [{
    key: 'jev-workflows@personal:hooks/hooks.json:session_start:0:0',
    currentHash: `sha256:${'b'.repeat(64)}`,
  }]);
  assert.match(toml, /inherit = "none"/);
  assert.match(toml, /ignore_default_excludes = false/);
  assert.match(toml, /plugins = true/);
  assert.match(toml, /trusted_hash = "sha256:/);
  assert.doesNotMatch(toml, /OPENAI_API_KEY|TYPESAFE_API_KEY|JEV_API_KEY_FILE/);
});

test('MCP startup diagnostics are bounded and redact credential-shaped values', () => {
  const oldApiKey = process.env.TYPESAFE_API_KEY;
  process.env.TYPESAFE_API_KEY = 'private-fixture-value';
  try {
    const [server] = compactMcp({data: [{
      name: 'jev-workflows',
      pluginId: 'jev-workflows@personal',
      runtimeStatus: 'failed',
      authStatus: 'unsupported',
      tools: {},
      toolsError: `local stdio MCP server failed: api_key=super-secret Bearer bearer-secret private-fixture-value ${'x'.repeat(2_100)}`,
    }]});
    assert.equal(server.name, 'jev-workflows');
    assert.equal(server.runtimeStatus, 'failed');
    assert.deepEqual(server.tools, []);
    assert.equal(server.toolsError.bytes > 2_000, true);
    assert.equal(server.toolsError.truncated, true);
    assert.equal(server.toolsError.excerpt.length <= 2_000, true);
    assert.match(server.toolsError.excerpt, /api_key=\[REDACTED\]/);
    assert.match(server.toolsError.excerpt, /Bearer \[REDACTED\]/);
    assert.doesNotMatch(server.toolsError.excerpt, /super-secret|bearer-secret|private-fixture-value/);
    assert.match(server.toolsError.excerptSha256, /^[0-9a-f]{64}$/);
  } finally {
    if (oldApiKey === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = oldApiKey;
  }
  assert.equal(compactMcp({data: [{name: 'ready', tools: {}}]})[0].toolsError, null);
});

test('failed hook diagnostics retain bounded redacted status and output entries', () => {
  const oldApiKey = process.env.TYPESAFE_API_KEY;
  process.env.TYPESAFE_API_KEY = 'private-fixture-value';
  try {
    const hook = compactHookRun({
      eventName: 'sessionStart',
      source: 'plugin',
      handlerType: 'command',
      executionMode: 'sync',
      status: 'failed',
      durationMs: 2,
      statusMessage: 'token=status-secret',
      entries: [
        {kind: 'error', text: `spawn failed api_key=entry-secret private-fixture-value ${'x'.repeat(2_100)}`},
        ...Array.from({length: 16}, (_, index) => ({kind: 'warning', text: `warning-${index}`})),
      ],
    });
    assert.equal(hook.status, 'failed');
    assert.equal(hook.entriesTotal, 17);
    assert.equal(hook.entriesTruncated, true);
    assert.equal(hook.entries.length, 16);
    assert.match(hook.statusMessage.excerpt, /token=\[REDACTED\]/);
    assert.match(hook.entries[0].text.excerpt, /api_key=\[REDACTED\]/);
    assert.doesNotMatch(hook.entries[0].text.excerpt, /entry-secret|private-fixture-value/);
    assert.equal(hook.entries[0].text.truncated, true);
  } finally {
    if (oldApiKey === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = oldApiKey;
  }
});

test('fresh install wiring rewrites MCP and every hook state path', async () => {
  const root = await mkdtemp(join(tmpdir(), 'plugin-value-state-test-'));
  await mkdir(join(root, 'hooks'));
  const oldState = '/old/plugin/state';
  const freshState = '/tmp/fresh/plugin/state';
  await writeFile(join(root, '.mcp.json'), JSON.stringify({
    mcpServers: {'jev-workflows': {env: {JEV_STATE_DIRECTORY: oldState}}},
  }));
  await writeFile(join(root, 'hooks', 'hooks.json'), JSON.stringify({
    hooks: {
      SessionStart: [{hooks: [{command: `JEV_STATE_DIRECTORY='${oldState}' node hook.mjs`}]}],
      Stop: [{hooks: [{command: `JEV_STATE_DIRECTORY='${oldState}' node hook.mjs`}]}],
    },
  }));
  assert.equal(await replaceStateDirectory(root, freshState), oldState);
  const mcp = await readFile(join(root, '.mcp.json'), 'utf8');
  const hooks = await readFile(join(root, 'hooks', 'hooks.json'), 'utf8');
  assert.doesNotMatch(mcp + hooks, new RegExp(oldState));
  assert.equal((mcp + hooks).split(freshState).length - 1, 3);
});
