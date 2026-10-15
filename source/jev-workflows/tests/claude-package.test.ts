import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { test } from 'node:test';

async function packageClaude(target: string): Promise<{code: number | null; stdout: string; stderr: string}> {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(process.cwd(), 'scripts/package-claude.mjs'), '--state-directory', '/tmp/jev-claude-state', '--credential-file', '/tmp/protected/typesafe.env', target], {cwd: process.cwd()});
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', value => { stdout += value; });
    child.stderr.on('data', value => { stderr += value; });
    child.once('error', reject);
    child.once('close', code => resolve({code, stdout, stderr}));
  });
}

test('Claude package carries native paths and protected credential path consistently', async () => {
  const parent = await mkdtemp('/tmp/jev-claude-package-test-');
  const target = join(parent, 'jev-workflows-claude');
  try {
    const result = await packageClaude(target);
    assert.equal(result.code, 0, result.stderr);
    const regenerated = await packageClaude(target);
    assert.equal(regenerated.code, 0, regenerated.stderr);
    const mcp = JSON.parse(await readFile(join(target, '.mcp.json'), 'utf8')) as {mcpServers: Record<string, {args: string[]; cwd?: string; env: Record<string, string>}>};
    assert.deepEqual(mcp.mcpServers['jev-workflows']?.args, ['${CLAUDE_PLUGIN_ROOT}/dist/server.mjs']);
    assert.equal(mcp.mcpServers['jev-workflows']?.cwd, undefined);
    assert.deepEqual(mcp.mcpServers['jev-workflows']?.env, {JEV_STATE_DIRECTORY: '/tmp/jev-claude-state', JEV_API_KEY_FILE: '/tmp/protected/typesafe.env'});
    const hooks = JSON.parse(await readFile(join(target, 'hooks/hooks.json'), 'utf8')) as {hooks: Record<string, Array<{hooks: Array<{command: string}>}>>};
    const commands = Object.values(hooks.hooks).flatMap(groups => groups.flatMap(group => group.hooks.map(hook => hook.command)));
    assert.ok(commands.length > 0);
    assert.ok(commands.every(command => command.startsWith("JEV_STATE_DIRECTORY='/tmp/jev-claude-state' JEV_API_KEY_FILE='/tmp/protected/typesafe.env' node \"${CLAUDE_PLUGIN_ROOT}/dist/claude-hook.mjs\"")));
    assert.equal(Object.hasOwn(JSON.parse(await readFile(join(target, '.claude-plugin/plugin.json'), 'utf8')), 'extensions'), false);
    assert.equal(await readFile(join(target, 'README.md'), 'utf8'), await readFile(join(process.cwd(), 'README.md'), 'utf8'));
    assert.equal(await readFile(join(target, 'LICENSE'), 'utf8'), await readFile(join(process.cwd(), 'LICENSE'), 'utf8'));
    await writeFile(join(target, 'unexpected.txt'), 'refuse this overwrite\n');
    const refused = await packageClaude(target);
    assert.notEqual(refused.code, 0);
    assert.match(refused.stderr, /unrecognized target entry unexpected\.txt/);
  } finally {
    await rm(parent, {recursive: true, force: true});
  }
});
