import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { configurePolicy } from '../src/policy.js';

async function runNode(entrypoint: string, input: string, env: NodeJS.ProcessEnv): Promise<{code: number | null; stdout: string; stderr: string}> {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entrypoint], {cwd: process.cwd(), env});
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('hook process timed out'));
    }, 5_000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); resolve({code, stdout, stderr}); });
    child.stdin.end(input);
  });
}

test('standalone hook runs through a symlinked dist entrypoint', async () => {
  await mkdir(join(process.cwd(), 'work'), {recursive: true});
  const root = await mkdtemp(join(process.cwd(), 'work', 'decision-hook-entry-'));
  try {
    const stateDirectory = join(root, 'state');
    const linkedDist = join(root, 'linked-dist');
    await symlink(join(process.cwd(), 'dist'), linkedDist, 'dir');
    await configurePolicy({enabled: true, scope: 'all-workspaces', workspaces: []}, {JEV_STATE_DIRECTORY: stateDirectory});
    const event = JSON.stringify({
      hook_event_name: 'SessionStart',
      session_id: 'entry-session',
      cwd: process.cwd(),
    });
    const result = await runNode(join(linkedDist, 'decision-hook.mjs'), event, {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      JEV_ENABLED: '1',
      JEV_STATE_DIRECTORY: stateDirectory,
    });
    assert.equal(result.code, 0);
    assert.equal(result.stderr, '');
    const output = JSON.parse(result.stdout) as {hookSpecificOutput?: {hookEventName?: string; additionalContext?: string}};
    assert.equal(output.hookSpecificOutput?.hookEventName, 'SessionStart');
    assert.match(output.hookSpecificOutput?.additionalContext ?? '', /consult classify_decision/);
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test('bundled hook emits only a supplied validated candidate', async () => {
  await mkdir(join(process.cwd(), 'work'), {recursive: true});
  const root = await mkdtemp(join(process.cwd(), 'work', 'decision-hook-dist-choice-'));
  try {
    const environment = {PLUGIN_DATA: join(root, 'state'), JEV_ENABLED: '1', TYPESAFE_API_KEY: 'dummy-key'};
    await configurePolicy({enabled: true, scope: 'all-workspaces', workspaces: []}, environment);
    const entrypoint = pathToFileURL(join(process.cwd(), 'dist', 'decision-hook.mjs')).href;
    const bundled = await import(`${entrypoint}?test=${Date.now()}`) as {
      runDecisionHook: (raw: unknown, options: Record<string, unknown>) => Promise<{hookSpecificOutput?: {additionalContext?: string}}>;
    };
    const result = await bundled.runDecisionHook({
      hook_event_name: 'PreToolUse', session_id: 'dist-choice-session', turn_id: 'dist-choice-turn',
      tool_use_id: 'dist-choice-tool', cwd: process.cwd(), tool_name: 'SyntheticTool', tool_input: {action: 'inspect'},
      task_context: {candidateCatalog: {tool: [
        {id: 'read_thread', description: 'Read the relevant thread.'},
        {id: 'run_tests', description: 'Run focused tests.'},
      ]}},
    }, {
      env: environment,
      service: {classifyDecision: async () => ({status: 'assessed', choice: 'read_thread', confidence: 0.98})},
    });
    assert.match(result.hookSpecificOutput?.additionalContext ?? '', /status=assessed; decision=read_thread; confidence=0\.98/);
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});
