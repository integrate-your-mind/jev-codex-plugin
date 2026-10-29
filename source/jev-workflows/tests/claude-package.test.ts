import assert from 'node:assert/strict';
import { access, cp, mkdir, readFile, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import {build} from 'esbuild';
import {createHash} from 'node:crypto';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { test } from 'node:test';

async function fixtureDirectory(prefix: string): Promise<string> {
  const parent = join(process.cwd(), '..', '..', '.agent-work');
  await mkdir(parent, {recursive: true});
  return await mkdtemp(join(parent, prefix));
}

async function packageClaude(target: string, injectFailure = false, nativeConfig?: string, source = process.cwd()): Promise<{code: number | null; stdout: string; stderr: string}> {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(source, 'scripts/package-claude.mjs'), '--state-directory', '/tmp/jev-claude-state', '--credential-file', '/tmp/protected/typesafe.env', ...(nativeConfig ? ['--native-routing-config', nativeConfig] : []), target], {cwd: process.cwd(), env: {...process.env, ...(injectFailure ? {JEV_PACKAGE_TEST_FAIL_AFTER_STAGE: '1'} : {})}});
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
  const parent = await fixtureDirectory('jev-claude-package-test-');
  const target = join(parent, 'jev-workflows-claude');
  try {
    const result = await packageClaude(target);
    assert.equal(result.code, 0, result.stderr);
    await mkdir(join(target, 'skills', 'removed-skill', 'scripts'), {recursive: true});
    await writeFile(join(target, 'skills', 'removed-skill', 'scripts', 'old.mjs'), 'stale\n');
    const regenerated = await packageClaude(target);
    assert.equal(regenerated.code, 0, regenerated.stderr);
    await assert.rejects(access(join(target, 'skills', 'removed-skill', 'scripts', 'old.mjs')));
    const mcp = JSON.parse(await readFile(join(target, '.mcp.json'), 'utf8')) as {mcpServers: Record<string, {args: string[]; cwd?: string; env: Record<string, string>}>};
    assert.deepEqual(mcp.mcpServers['jev-workflows']?.args, ['${CLAUDE_PLUGIN_ROOT}/dist/server.mjs']);
    assert.equal(mcp.mcpServers['jev-workflows']?.cwd, undefined);
    assert.deepEqual(mcp.mcpServers['jev-workflows']?.env, {JEV_STATE_DIRECTORY: '/tmp/jev-claude-state', JEV_API_KEY_FILE: '/tmp/protected/typesafe.env'});
    const hooks = JSON.parse(await readFile(join(target, 'hooks/hooks.json'), 'utf8')) as {hooks: Record<string, Array<{hooks: Array<{command: string; timeout: number}>}>>};
    const commands = Object.values(hooks.hooks).flatMap(groups => groups.flatMap(group => group.hooks.map(hook => hook.command)));
    assert.ok(commands.length > 0);
    // Prompt and session-start consultations get extra host time; tool-call
    // hooks keep 5 s so a slow consultation never stalls a tool call longer.
    assert.deepEqual(Object.fromEntries(Object.entries(hooks.hooks).map(([event, groups]) => [event, groups.flatMap(group => group.hooks.map(hook => hook.timeout))])), {
      SessionStart: [10], UserPromptSubmit: [10], PreToolUse: [5], PostToolUse: [5], PostToolUseFailure: [5], PermissionRequest: [5],
      PreCompact: [5], PostCompact: [5], SubagentStart: [5], SubagentStop: [5], Stop: [5], SessionEnd: [3],
    });
    assert.ok(commands.every(command => command.startsWith("JEV_STATE_DIRECTORY='/tmp/jev-claude-state' JEV_API_KEY_FILE='/tmp/protected/typesafe.env' node \"${CLAUDE_PLUGIN_ROOT}/dist/claude-hook.mjs\"")));
    assert.equal(Object.hasOwn(JSON.parse(await readFile(join(target, '.claude-plugin/plugin.json'), 'utf8')), 'extensions'), false);
    assert.equal(await readFile(join(target, 'README.md'), 'utf8'), await readFile(join(process.cwd(), 'README.md'), 'utf8'));
    assert.equal(await readFile(join(target, 'LICENSE'), 'utf8'), await readFile(join(process.cwd(), 'LICENSE'), 'utf8'));
    await writeFile(join(target, 'unexpected.txt'), 'refuse this overwrite\n');
    const readmeBeforeRefusal = await readFile(join(target, 'README.md'), 'utf8');
    const refused = await packageClaude(target);
    assert.notEqual(refused.code, 0);
    assert.match(refused.stderr, /unrecognized target entry unexpected\.txt/);
    assert.equal(await readFile(join(target, 'README.md'), 'utf8'), readmeBeforeRefusal);
    assert.equal(await readFile(join(target, 'unexpected.txt'), 'utf8'), 'refuse this overwrite\n');
  } finally {
    await rm(parent, {recursive: true, force: true});
  }
});

test('Claude staging failure preserves the marked package and cleans staging debris', async () => {
  const parent = await fixtureDirectory('jev-claude-package-failure-');
  const target = join(parent, 'jev-workflows-claude');
  try {
    assert.equal((await packageClaude(target)).code, 0);
    const readme = await readFile(join(target, 'README.md'), 'utf8');
    const failed = await packageClaude(target, true);
    assert.notEqual(failed.code, 0);
    assert.equal(await readFile(join(target, 'README.md'), 'utf8'), readme);
    assert.deepEqual((await readdir(parent)).filter(name => name.startsWith('.jev-claude-stage-')), []);
  } finally {
    await rm(parent, {recursive: true, force: true});
  }
});


test('fresh Claude package failure leaves no partial target and retry succeeds', async () => {
  const parent = await fixtureDirectory('jev-claude-fresh-failure-');
  const target = join(parent, 'jev-workflows-claude');
  try {
    assert.notEqual((await packageClaude(target, true)).code, 0);
    assert.deepEqual(await readdir(parent), []);
    assert.equal((await packageClaude(target)).code, 0);
  } finally { await rm(parent, {recursive: true, force: true}); }
});

test('native edition is opt-in, has one command producer and keeps native code free of Node imports', async () => {
  const parent = await fixtureDirectory('jev-claude-native-package-');
  try {
    const source = join(parent, 'fixture-source');
    assert.equal(createHash('sha256').update(await readFile(join(process.cwd(), 'tests/fixtures/claude-code.d.ts'))).digest('hex'), 'e51e637fbbebb2a6a49c4bdc3860a251c2ca2295884822dff0f4c3e3ec802163');
    for (const name of ['templates', 'dist', 'skills', 'docs', 'scripts']) await mkdir(join(source, name), {recursive: true});
    await mkdir(join(source, 'src/hosts/claude'), {recursive: true});
    await cp(join(process.cwd(), 'src/hosts/claude/config.mjs'), join(source, 'src/hosts/claude/config.mjs'));
    for (const name of ['templates/claude', 'skills', 'docs']) await cp(join(process.cwd(), name), join(source, name), {recursive: true});
    for (const name of ['scripts/package-claude.mjs', 'README.md', 'LICENSE', 'dist/server.mjs', 'dist/claude-hook.mjs']) await cp(join(process.cwd(), name), join(source, name));
    const bundle = await build({entryPoints: [join(process.cwd(), 'src/hosts/claude/mod.ts')], bundle: true, format: 'esm', platform: 'neutral', write: false, metafile: true});
    const code = bundle.outputFiles[0]?.text ?? '';
    assert.ok(code.length > 0);
    assert.match(code, /function register\(/);
    assert.doesNotMatch(code, /node:|\brequire\s*\(|\$\.mcp\.|\$\.tool\.call/);
    assert.deepEqual(Object.values(bundle.metafile?.outputs ?? {}).flatMap(output => output.imports), []);
    await writeFile(join(source, 'dist/claude-mod.mjs'), code);
    const configPath = join(parent, 'routing-config.json');
    const config = {version: 'jev-claude-routing-v1', enabled: true, stateDirectory: '/tmp/jev-claude-state', hostId: 'claude-code', providerId: 'current-account', catalogGeneration: 'configured-only-1', policyGeneration: 'policy-1', profiles: []};
    await writeFile(configPath, JSON.stringify(config));
    const target = join(parent, 'jev-workflows-claude');
    const result = await packageClaude(target, false, configPath, source);
    assert.equal(result.code, 0, result.stderr);
    const hooks = JSON.parse(await readFile(join(target, 'hooks/hooks.json'), 'utf8'));
    assert.deepEqual(hooks.modules, ['../dist/claude-mod.mjs']);
    assert.deepEqual(Object.keys(hooks.hooks), ['UserPromptSubmit', 'PostToolBatch']);
    assert.match(hooks.hooks.PostToolBatch[0].hooks[0].command, /JEV_CLAUDE_NATIVE_BRIDGE=1 JEV_CLAUDE_ROUTING_CONFIG="\$\{CLAUDE_PLUGIN_ROOT\}\/claude-routing\.json"/);
    assert.deepEqual(JSON.parse(await readFile(join(target, 'claude-routing.json'), 'utf8')), config);
    const manifest = JSON.parse(await readFile(join(target, 'CLAUDE-HOST-COMPATIBILITY.json'), 'utf8'));
    assert.equal(manifest.nativeRouting.acceptance, 'offline-only');
    assert.equal(manifest.nativeRouting.liveClaudeInference, 'not-run');
    assert.equal(await readFile(join(target, 'dist/claude-mod.mjs'), 'utf8'), code);
    const priorConfiguration = await readFile(join(target, 'claude-routing.json'), 'utf8');
    for (const malformed of [
      {...config, transitions: [{from: 'x', to: 'y', kind: 'upshift', credential: 'must-not-be-packaged'}]},
      {...config, profiles: [{id: 'x', model: {credential: 'must-not-be-packaged'}, effort: 'low', hostId: 'claude-code', providerId: 'current-account', availability: 'verified'}]},
    ]) {
      await writeFile(configPath, JSON.stringify(malformed));
      const rejected = await packageClaude(target, false, configPath, source);
      assert.notEqual(rejected.code, 0);
      assert.equal(await readFile(join(target, 'claude-routing.json'), 'utf8'), priorConfiguration);
    }
    await writeFile(configPath, JSON.stringify(config));
    if (process.env.JEV_CLAUDE_VALIDATE === '1') {
      const validation = await new Promise<{code: number | null; stdout: string; stderr: string}>((resolve, reject) => {
        const child = spawn('claude', ['plugin', 'validate', '--json', target], {timeout: 30_000});
        let stdout = ''; let stderr = '';
        child.stdout?.setEncoding('utf8'); child.stderr?.setEncoding('utf8');
        child.stdout?.on('data', text => { stdout += text; }); child.stderr?.on('data', text => { stderr += text; });
        child.once('error', reject); child.once('close', code => resolve({code, stdout, stderr}));
      });
      assert.equal(validation.code, 0, validation.stderr || validation.stdout);
      assert.equal(JSON.parse(validation.stdout).success, true);
    }
    assert.equal((await packageClaude(target, false, undefined, source)).code, 0);
    assert.equal(Object.hasOwn(JSON.parse(await readFile(join(target, 'hooks/hooks.json'), 'utf8')), 'modules'), false);
    await assert.rejects(access(join(target, 'claude-routing.json')));
    await assert.rejects(access(join(target, 'dist/claude-mod.mjs')));
  } finally { await rm(parent, {recursive: true, force: true}); }
});
