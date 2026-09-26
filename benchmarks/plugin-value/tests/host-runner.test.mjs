import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';

import {
  buildConfigToml,
  buildEnvironmentsToml,
  replaceStateDirectory,
  validateRequest,
} from '../host-runner.mjs';

const CONTAINER = 'a'.repeat(64);
const request = Object.freeze({
  schemaVersion: 'plugin-value-runtime-v1',
  arm: 'treatment',
  containerId: CONTAINER,
  containerUser: 'agent',
  dockerPath: '/usr/local/bin/docker',
  codexPath: '/opt/homebrew/bin/codex',
  instruction: 'repair the repository',
  logsDir: '/tmp/private-results',
  model: 'gpt-6-astra',
  effort: 'medium',
  remoteCwd: '/app',
  hostCwd: `/tmp/deepswe-runs/${CONTAINER.slice(0, 12)}/workspace`,
  turnTimeoutMs: 10_700_000,
  preflightOnly: true,
});

test('request pins model, effort, remote cwd, and host hook shadow', () => {
  assert.deepEqual(validateRequest(request), request);
  assert.throws(() => validateRequest({...request, model: 'other'}), /gpt-6-astra/);
  assert.throws(() => validateRequest({...request, remoteCwd: '/tmp/work'}), /remoteCwd/);
  assert.throws(() => validateRequest({...request, hostCwd: '/tmp/work'}), /hostCwd/);
  assert.throws(() => validateRequest({...request, containerId: 'a;touch x'}), /container id/);
});

test('exec-server launcher clears host env and forwards no credential', () => {
  const toml = buildEnvironmentsToml(request);
  assert.match(toml, /include_local = true/);
  assert.match(toml, /program = "\/usr\/bin\/env"/);
  assert.equal((toml.match(/"-i"/g) ?? []).length, 3);
  assert.match(toml, /"exec", "-i", "-u", "agent"/);
  assert.match(toml, /"\/usr\/bin\/env", "-i", "PATH=\/usr\/local\/bin:\/usr\/bin:\/bin", "HOME=\/tmp\/codex-exec-launcher", "CODEX_HOME=\/tmp\/codex-exec-home"/);
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
