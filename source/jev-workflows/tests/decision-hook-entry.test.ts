import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
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
