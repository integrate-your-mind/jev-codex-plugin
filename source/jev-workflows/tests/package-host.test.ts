import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { test } from 'node:test';

type ChildResult = {code: number | null; stdout: string; stderr: string};

async function runPackageHost(args: string[]): Promise<ChildResult> {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(process.cwd(), 'scripts/package-host.mjs'), ...args], {
      cwd: process.cwd(),
      env: process.env,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', code => resolve({code, stdout, stderr}));
  });
}

function commandHooks(hooks: Record<string, Array<{hooks?: Array<{type?: string; command?: string}>}>>): string[] {
  return Object.values(hooks).flatMap(groups => groups.flatMap(group => (group.hooks ?? [])
    .filter(hook => hook.type === 'command')
    .map(hook => hook.command ?? '')));
}

async function textContents(root: string): Promise<string> {
  const entries = await readdir(root, {withFileTypes: true});
  const contents = await Promise.all(entries.map(async entry => {
    const path = join(root, entry.name);
    return entry.isDirectory() ? textContents(path) : await readFile(path, 'utf8').catch(() => '');
  }));
  return contents.join('\n');
}

test('neutral legacy package passes user state mode consistently to MCP and hooks', async () => {
  const parent = await mkdtemp('/tmp/jev-package-host-test-');
  const target = join(parent, 'jev-workflows');
  try {
    const result = await runPackageHost([target]);
    assert.equal(result.code, 0, result.stderr);
    const mcp = JSON.parse(await readFile(join(target, '.mcp.json'), 'utf8')) as {mcpServers: Record<string, {env?: Record<string, string>; env_vars?: string[]}>};
    const hooks = JSON.parse(await readFile(join(target, 'hooks/hooks.json'), 'utf8')) as {hooks: Record<string, Array<{hooks?: Array<{type?: string; command?: string}>}>>};
    const compatibility = JSON.parse(await readFile(join(target, 'HOST-COMPATIBILITY.json'), 'utf8')) as {stateDirectory?: unknown; stateMode?: {mode?: string; mcpEnvironment?: string; rewrittenHookCommands?: number}};
    const server = mcp.mcpServers['jev-workflows'];
    assert.deepEqual(server?.env, {JEV_STATE_MODE: 'user'});
    assert.ok(server?.env_vars?.includes('XDG_STATE_HOME'));
    assert.ok(server?.env_vars?.includes('JEV_STATE_DIRECTORY'));
    assert.equal(new Set(server?.env_vars ?? []).size, server?.env_vars?.length);
    const commands = commandHooks(hooks.hooks);
    assert.ok(commands.length > 0);
    assert.ok(commands.every(command => command.startsWith("JEV_STATE_MODE='user' ")));
    assert.equal(compatibility.stateDirectory, null);
    assert.deepEqual(compatibility.stateMode, {
      mode: 'user',
      source: 'neutral-legacy-host-default',
      mcpEnvironment: 'JEV_STATE_MODE',
      rewrittenHookCommands: commands.length,
      pluginDataReserved: true,
    });
    const packagedText = await textContents(target);
    assert.equal(await readFile(join(target, 'LICENSE'), 'utf8'), await readFile(join(process.cwd(), 'LICENSE'), 'utf8'));
    assert.doesNotMatch(packagedText, /\/Users\/romanmondello(?:\/|$)/);
    assert.doesNotMatch(packagedText, /\/private\/tmp(?:\/|$)/);
  } finally {
    await rm(parent, {recursive: true, force: true});
  }
});

test('explicit legacy state directory remains shared by MCP and hooks', async () => {
  const parent = await mkdtemp('/tmp/jev-package-host-test-');
  const target = join(parent, 'jev-workflows');
  const stateDirectory = '/tmp/jev-explicit-state';
  try {
    const result = await runPackageHost(['--state-directory', stateDirectory, target]);
    assert.equal(result.code, 0, result.stderr);
    const mcp = JSON.parse(await readFile(join(target, '.mcp.json'), 'utf8')) as {mcpServers: Record<string, {env?: Record<string, string>; env_vars?: string[]}>};
    const hooks = JSON.parse(await readFile(join(target, 'hooks/hooks.json'), 'utf8')) as {hooks: Record<string, Array<{hooks?: Array<{type?: string; command?: string}>}>>};
    const server = mcp.mcpServers['jev-workflows'];
    assert.deepEqual(server?.env, {JEV_STATE_DIRECTORY: stateDirectory});
    assert.ok(server?.env_vars?.includes('XDG_STATE_HOME'));
    assert.ok(server?.env_vars?.includes('JEV_STATE_DIRECTORY'));
    assert.equal(new Set(server?.env_vars ?? []).size, server?.env_vars?.length);
    const commands = commandHooks(hooks.hooks);
    assert.ok(commands.length > 0);
    assert.ok(commands.every(command => command.startsWith(`JEV_STATE_DIRECTORY='${stateDirectory}' `)));
  } finally {
    await rm(parent, {recursive: true, force: true});
  }
});
