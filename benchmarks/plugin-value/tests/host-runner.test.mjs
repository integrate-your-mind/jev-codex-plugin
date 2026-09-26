import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {chmod, mkdtemp, mkdir, readFile, rm, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';

import {
  buildConfigToml,
  buildEnvironmentsToml,
  replaceStateDirectory,
  validateRequest,
  verifyPinnedPlugin,
  verifyHostRuntimeIdentity,
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
  remoteCwd: '/app',
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
  assert.match(toml, /program = "\/usr\/bin\/env"/);
  assert.equal((toml.match(/"-i"/g) ?? []).length, 3);
  assert.match(toml, /"exec", "-i", "-u", "agent"/);
  assert.match(toml, /"\/usr\/bin\/env", "-i", "PATH=\/usr\/local\/bin:\/usr\/bin:\/bin", "HOME=\/installed-agent\/codex-exec-launcher", "CODEX_HOME=\/installed-agent\/codex-exec-home"/);
  assert.doesNotMatch(toml, /CODEX_HOME=\/tmp/);
  assert.doesNotMatch(toml, /OPENAI|TYPESAFE|JEV_API_KEY|auth\.json/);
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
