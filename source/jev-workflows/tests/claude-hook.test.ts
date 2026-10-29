import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import { access, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { configurePolicy } from '../src/policy.js';
import { claudeHookDeadlineMs, runClaudeHook } from '../src/claude-hook.js';

const cwd = process.cwd();
const claudeEntry = process.env.JEV_CLAUDE_HOOK_TEST_ENTRYPOINT ?? join(cwd, 'dist', 'claude-hook.mjs');
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

async function runBuilt(entrypoint: string, event: Record<string, unknown>, env: NodeJS.ProcessEnv, nodeArgs: string[] = []): Promise<{code: number | null; stdout: string; stderr: string; wallMs: number}> {
  return await new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const child = spawn(process.execPath, [...nodeArgs, entrypoint], {cwd, env});
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', value => { stdout += value; });
    child.stderr.on('data', value => { stderr += value; });
    child.once('error', reject);
    child.once('close', code => resolve({code, stdout, stderr, wallMs: Date.now() - startedAt}));
    child.stdin.end(JSON.stringify(event));
  });
}

async function fixture(): Promise<{root: string; env: NodeJS.ProcessEnv}> {
  const parent = join(cwd, '..', '..', '.agent-work');
  await mkdir(parent, {recursive: true});
  const root = await mkdtemp(join(parent, 'jev-claude-hook-'));
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
    const claudeSession = await runBuilt(claudeEntry, {hook_event_name: 'SessionStart', session_id: 'built-claude', cwd, source: 'startup'}, env);
    const claudeEnd = await runBuilt(claudeEntry, {hook_event_name: 'SessionEnd', session_id: 'built-claude', cwd, reason: 'other'}, env);
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

const FAKE_KEY = Array.from({length: 96}, (_, index) => 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'[index % 62]).join('');

/** A child preload that applies `setup` and records the child's own clock at
 * exit. Deadline assertions then do not depend on process spawn latency, which
 * grows with host load and which no in-process deadline can observe. */
async function deadlinePreload(root: string, name: string, setup: string[]): Promise<{nodeArgs: string[]; exitFile: string}> {
  const exitFile = join(root, `${name}.exit`);
  const preload = join(root, `${name}.mjs`);
  await writeFile(preload, [
    "import { writeFileSync } from 'node:fs';",
    ...setup,
    `process.on('exit', () => writeFileSync(${JSON.stringify(exitFile)}, String(performance.now())));`,
  ].join('\n') + '\n');
  return {nodeArgs: ['--import', pathToFileURL(preload).href], exitFile};
}

test('built Claude hook answers within its hard deadline and exits while the provider hangs', async () => {
  for (const eventName of ['UserPromptSubmit', 'PreToolUse']) {
    const {root, env} = await fixture();
    try {
    const keyFile = join(root, 'typesafe.env');
    await writeFile(keyFile, `TYPESAFE_API_KEY=${FAKE_KEY}\n`, {mode: 0o600});
    // The provider never answers and ignores cancellation, while a referenced
    // timer stands in for a socket that keeps the event loop alive (an aborted
    // connect otherwise waits out the HTTP client's connect timeout).
    const {nodeArgs, exitFile} = await deadlinePreload(root, 'hung-fetch', [
      'globalThis.fetch = () => new Promise(() => { setTimeout(() => {}, 60_000); });',
    ]);
    const entry = claudeEntry;
    const sessionId = `built-deadline-${randomUUID()}`;
    if (eventName === 'PreToolUse') await runClaudeHook(prompt(sessionId, 'run the parser tests'), {env, service: {classifyDecision: async () => ({status: 'assessed', choice: 'proceed'})}});
    const event = eventName === 'UserPromptSubmit' ? prompt(sessionId, 'run the parser tests') : {hook_event_name: 'PreToolUse', session_id: sessionId, cwd, tool_name: 'Bash', tool_use_id: `tool-${randomUUID()}`, tool_input: {command: 'npm test'}};
      const name = String(event.hook_event_name);
      const run = await runBuilt(entry, event, {...env, JEV_API_KEY_FILE: keyFile}, nodeArgs);
      assert.equal(run.code, 0);
      assert.equal(run.stderr, '');
      const output = JSON.parse(run.stdout) as {hookSpecificOutput?: {hookEventName: string; additionalContext: string}};
      assert.equal(output.hookSpecificOutput?.hookEventName, name);
      assert.match(output.hookSpecificOutput?.additionalContext ?? '', /JEV advisory: status=unavailable; reason=hook_timeout;/);
      // Exit follows the deadline on the child's own clock instead of waiting
      // out the 60 s hang; the wall-clock bound is only a backstop.
      const exitAt = Number(await readFile(exitFile, 'utf8'));
      assert.ok(exitAt < claudeHookDeadlineMs(name) + 1_000, `${name} exited at ${Math.round(exitAt)} ms`);
      assert.ok(run.wallMs < 30_000, `${name} took ${run.wallMs} ms`);
    } finally {
      await rm(root, {recursive: true, force: true});
    }
  }
});

test('built Claude hook exits silently at its hard deadline when local work stalls before consultation', async () => {
  const {root, env} = await fixture();
  try {
    // Stall the private turn-state publish that precedes any consultation.
    const {nodeArgs, exitFile} = await deadlinePreload(root, 'stalled-rename', [
      "import fsp from 'node:fs/promises';",
      "import { syncBuiltinESMExports } from 'node:module';",
      'fsp.rename = () => new Promise(() => { setTimeout(() => {}, 60_000); });',
      'syncBuiltinESMExports();',
    ]);
    const run = await runBuilt(claudeEntry, prompt(`built-stall-${randomUUID()}`, 'stall locally'), env, nodeArgs);
    assert.equal(run.code, 0);
    assert.equal(run.stderr, '');
    assert.deepEqual(JSON.parse(run.stdout), {});
    const deadlineMs = claudeHookDeadlineMs('UserPromptSubmit');
    const exitAt = Number(await readFile(exitFile, 'utf8'));
    assert.ok(exitAt >= deadlineMs - 50 && exitAt < deadlineMs + 1_000, `stalled hook exited at ${Math.round(exitAt)} ms`);
    assert.ok(run.wallMs < 30_000, `stalled hook took ${run.wallMs} ms`);
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test('runClaudeHook bounds consultation by its deadline and reports the matching fallback', async () => {
  const {root, env} = await fixture();
  try {
    await runClaudeHook(prompt('session-deadline', 'start a turn'), {env, service: {classifyDecision: async () => ({status: 'assessed', choice: 'proceed'})}});
    let fallback: unknown;
    const startedAt = performance.now();
    const result = await runClaudeHook({hook_event_name: 'PostToolUseFailure', session_id: 'session-deadline', cwd, tool_name: 'Bash', tool_use_id: 'tool-deadline', tool_input: {command: 'npm test'}, error: 'Exit code 1'}, {
      env,
      service: {classifyDecision: () => new Promise<never>(() => {})},
      deadlineAt: performance.now() + 300,
      onConsult: value => { fallback = value; },
    });
    assert.ok(performance.now() - startedAt < 2_000);
    assert.equal(result.hookSpecificOutput?.hookEventName, 'PostToolUseFailure');
    assert.match(result.hookSpecificOutput?.additionalContext ?? '', /status=unavailable; reason=hook_timeout/);
    assert.deepEqual(fallback, result);
    let called = false;
    const expired = await runClaudeHook({hook_event_name: 'PreToolUse', session_id: 'session-deadline', cwd, tool_name: 'Read', tool_use_id: 'tool-expired', tool_input: {}}, {
      env,
      service: {classifyDecision: async () => { called = true; return {status: 'assessed', choice: 'proceed'}; }},
      deadlineAt: performance.now() - 1,
    });
    assert.equal(called, false);
    assert.equal(expired.hookSpecificOutput?.hookEventName, 'PreToolUse');
    assert.match(expired.hookSpecificOutput?.additionalContext ?? '', /status=unavailable; reason=hook_timeout/);
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test('Claude hook deadlines leave start-up headroom below every hooks.json timeout', async () => {
  const hooks = JSON.parse(await readFile(join(cwd, 'templates/claude/hooks/hooks.json'), 'utf8')) as {hooks: Record<string, Array<{hooks: Array<{timeout: number}>}>>};
  for (const [event, groups] of Object.entries(hooks.hooks)) {
    const timeoutMs = (groups[0]?.hooks[0]?.timeout ?? 0) * 1000;
    assert.ok(claudeHookDeadlineMs(event) <= timeoutMs - 1_500, `${event}: ${claudeHookDeadlineMs(event)} ms deadline vs ${timeoutMs} ms timeout`);
  }
  assert.equal(claudeHookDeadlineMs('UserPromptSubmit'), 3_500);
  assert.equal(claudeHookDeadlineMs('SessionStart'), 3_500);
  assert.equal(claudeHookDeadlineMs('PreToolUse'), 2_500);
  assert.equal(claudeHookDeadlineMs('SessionEnd'), 1_500);
  assert.equal(claudeHookDeadlineMs(undefined), 2_500);
});
