import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import { access, lstat, mkdir, mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { test } from 'node:test';
import { configurePolicy } from '../src/policy.js';
import { runClaudeHook } from '../src/claude-hook.js';

const cwd = process.cwd();
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

async function runBuilt(entrypoint: string, event: Record<string, unknown>, env: NodeJS.ProcessEnv): Promise<{code: number | null; stdout: string; stderr: string}> {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entrypoint], {cwd, env});
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', value => { stdout += value; });
    child.stderr.on('data', value => { stderr += value; });
    child.once('error', reject);
    child.once('close', code => resolve({code, stdout, stderr}));
    child.stdin.end(JSON.stringify(event));
  });
}

async function fixture(): Promise<{root: string; env: NodeJS.ProcessEnv}> {
  const root = await mkdtemp('/tmp/jev-claude-hook-');
  const env = {JEV_STATE_DIRECTORY: join(root, 'state'), JEV_ENABLED: '1'};
  await configurePolicy({enabled: true, scope: 'all-workspaces', workspaces: []}, env);
  return {root, env};
}

function prompt(sessionId: string, promptText: string): Record<string, unknown> {
  return {hook_event_name: 'UserPromptSubmit', session_id: sessionId, cwd, prompt: promptText, prompt_id: randomUUID()};
}

test('Claude prompt creates a private turn UUID and prefixes the session identity', async () => {
  const {root, env} = await fixture();
  try {
    const result = await runClaudeHook(prompt('session-one', 'inspect the change'), {
      env,
      service: {classifyDecision: async () => ({status: 'assessed', choice: 'proceed', confidence: 0.91})},
    });
    assert.equal(result.hookSpecificOutput?.hookEventName, 'UserPromptSubmit');
    const state = join(env.JEV_STATE_DIRECTORY as string, 'claude-turns-v1', hash(cwd), hash('claude:session-one'), 'turn.json');
    const contents = JSON.parse(await readFile(state, 'utf8')) as {turnId: string};
    assert.match(contents.turnId, /^[a-f0-9-]{36}$/);
    assert.equal((await lstat(state)).mode & 0o777, 0o600);
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test('multiple prompts replace the current turn and later tool hooks reuse it', async () => {
  const {root, env} = await fixture();
  try {
    const service = {classifyDecision: async () => ({status: 'assessed', choice: 'proceed', confidence: 0.8})};
    await runClaudeHook(prompt('session-two', 'first'), {env, service});
    const state = join(env.JEV_STATE_DIRECTORY as string, 'claude-turns-v1', hash(cwd), hash('claude:session-two'), 'turn.json');
    const first = (JSON.parse(await readFile(state, 'utf8')) as {turnId: string}).turnId;
    await runClaudeHook(prompt('session-two', 'second'), {env, service});
    const second = (JSON.parse(await readFile(state, 'utf8')) as {turnId: string}).turnId;
    assert.notEqual(first, second);
    const toolResult = await runClaudeHook({hook_event_name: 'PreToolUse', session_id: 'session-two', cwd, tool_name: 'Read', tool_use_id: 'tool-1', tool_input: {file_path: 'x'}}, {env, service});
    assert.equal(toolResult.hookSpecificOutput?.hookEventName, 'PreToolUse');
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test('PostToolUseFailure uses the common result path and restores the native event name', async () => {
  const {root, env} = await fixture();
  try {
    await runClaudeHook(prompt('session-three', 'run tests'), {env, service: {classifyDecision: async () => ({status: 'assessed', choice: 'proceed'})}});
    let captured = '';
    const result = await runClaudeHook({hook_event_name: 'PostToolUseFailure', session_id: 'session-three', cwd, tool_name: 'Bash', tool_use_id: 'tool-fail', tool_input: {command: 'npm test'}, error: 'Exit code 1\nfailed'}, {
      env,
      service: {classifyDecision: async input => {captured = input.context; return {status: 'assessed', choice: 'proceed'};}},
    });
    assert.equal(result.hookSpecificOutput?.hookEventName, 'PostToolUseFailure');
    assert.match(captured, /"isError":true/);
    assert.match(captured, /Exit code 1/);
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test('Jev-owned tools stay silent and provider failures remain fail-open', async () => {
  const {root, env} = await fixture();
  try {
    let calls = 0;
    const internal = await runClaudeHook({hook_event_name: 'PreToolUse', session_id: 'session-four', cwd, tool_name: 'classify_decision', tool_use_id: 'tool-internal', tool_input: {}}, {env, service: {classifyDecision: async () => {calls += 1; return {status: 'assessed', choice: 'proceed'};}}});
    assert.deepEqual(internal, {});
    assert.equal(calls, 0);
    await runClaudeHook(prompt('session-four', 'continue'), {env, service: {classifyDecision: async () => {throw new Error('provider down');}}});
    const failed = await runClaudeHook({hook_event_name: 'PreToolUse', session_id: 'session-four', cwd, tool_name: 'Read', tool_use_id: 'tool-fail-open', tool_input: {}}, {env, service: {classifyDecision: async () => {throw new Error('provider down');}}});
    assert.match(failed.hookSpecificOutput?.additionalContext ?? '', /status=unavailable/);
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test('Claude native Jev MCP tools stay silent while foreign MCP tools remain evaluable', async () => {
  const {root, env} = await fixture();
  try {
    let calls = 0;
    const service = {classifyDecision: async () => { calls += 1; return {status: 'assessed', choice: 'proceed'}; }};
    await runClaudeHook(prompt('session-native-mcp', 'inspect MCP tools'), {env, service});
    calls = 0;
    for (const hook_event_name of ['PreToolUse', 'PostToolUse']) {
      const internal = await runClaudeHook({hook_event_name, session_id: 'session-native-mcp', cwd, tool_name: 'mcp__plugin_jev-workflows_jev-workflows__classify_decision', tool_use_id: `native-${hook_event_name}`, tool_input: {}, ...(hook_event_name === 'PostToolUse' ? {tool_response: {status: 'ok'}} : {})}, {env, service});
      assert.deepEqual(internal, {});
    }
    assert.equal(calls, 0);
    const foreign = await runClaudeHook({hook_event_name: 'PreToolUse', session_id: 'session-native-mcp', cwd, tool_name: 'mcp__foreign__lookup', tool_use_id: 'foreign-1', tool_input: {}}, {env, service});
    assert.equal(foreign.hookSpecificOutput?.hookEventName, 'PreToolUse');
    assert.equal(calls, 1);
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test('unsafe symlink turn state fails open without replacing the link', async () => {
  const {root, env} = await fixture();
  try {
    const directory = join(env.JEV_STATE_DIRECTORY as string, 'claude-turns-v1', hash(cwd), hash('claude:session-five'));
    await mkdir(directory, {recursive: true, mode: 0o700});
    const target = join(root, 'outside.json');
    await symlink(target, join(directory, 'turn.json'));
    const result = await runClaudeHook(prompt('session-five', 'do not follow links'), {env, service: {classifyDecision: async () => ({status: 'assessed', choice: 'proceed'})}});
    assert.deepEqual(result, {});
    assert.equal((await lstat(join(directory, 'turn.json'))).mode & constants.S_IFMT, constants.S_IFLNK);
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test('disabled policy and oversized input do not create Claude turn state', async () => {
  const root = await mkdtemp('/tmp/jev-claude-hook-disabled-');
  const env = {JEV_STATE_DIRECTORY: join(root, 'state'), JEV_ENABLED: '1'};
  try {
    await configurePolicy({enabled: false, scope: 'all-workspaces', workspaces: []}, env);
    const disabled = await runClaudeHook(prompt('session-disabled', 'no state write'), {env, service: {classifyDecision: async () => ({status: 'assessed', choice: 'proceed'})}});
    assert.deepEqual(disabled, {});
    await assert.rejects(access(join(env.JEV_STATE_DIRECTORY, 'claude-turns-v1')));
    const oversized = await runClaudeHook(' '.repeat(128 * 1024 + 1), {env});
    assert.deepEqual(oversized, {});
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test('built Claude and Codex hook entrypoints each emit exactly one JSON object', async () => {
  const {root, env} = await fixture();
  try {
    const claudeSession = await runBuilt(join(cwd, 'dist', 'claude-hook.mjs'), {hook_event_name: 'SessionStart', session_id: 'built-claude', cwd, source: 'startup'}, env);
    const claudeEnd = await runBuilt(join(cwd, 'dist', 'claude-hook.mjs'), {hook_event_name: 'SessionEnd', session_id: 'built-claude', cwd, reason: 'other'}, env);
    const codexSession = await runBuilt(join(cwd, 'dist', 'decision-hook.mjs'), {hook_event_name: 'SessionStart', session_id: 'built-codex', cwd}, env);
    const codexEnd = await runBuilt(join(cwd, 'dist', 'decision-hook.mjs'), {hook_event_name: 'SessionEnd', session_id: 'built-codex', cwd, reason: 'other'}, env);
    for (const result of [claudeSession, claudeEnd, codexSession, codexEnd]) {
      assert.equal(result.code, 0);
      assert.equal(result.stderr, '');
      assert.equal(result.stdout.trim().startsWith('{'), true);
      assert.equal(result.stdout.trim().endsWith('}'), true);
      assert.equal(JSON.parse(result.stdout).constructor, Object);
    }
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});
