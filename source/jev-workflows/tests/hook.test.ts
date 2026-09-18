import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeHookEvent, runHook, type FailureService } from '../src/hook.js';

let testRoot: string;

before(async () => {
  // Keep generated event receipts inside the task checkout and remove them in
  // the test teardown; no external or user-data paths are touched.
  await mkdir(join(process.cwd(), 'work'), { recursive: true });
  testRoot = await mkdtemp(join(process.cwd(), 'work', 'hook-tests-'));
});

after(async () => {
  await rm(testRoot, { recursive: true, force: true });
});

function event(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    hook_event_name: 'PostToolUse',
    tool_name: 'Bash',
    session_id: 'session-1',
    turn_id: 'turn-1',
    tool_use_id: 'tool-1',
    cwd: process.cwd(),
    tool_input: { command: 'npm test' },
    tool_response: { exit_code: 1, output: 'Assertion failed' },
    ...overrides,
  };
}

function enabledEnv(dataPath: string): NodeJS.ProcessEnv {
  return {
    JEV_HOOKS_ENABLED: '1',
    TYPESAFE_API_KEY: 'test-key',
    JEV_ALLOWED_WORKSPACES: JSON.stringify([process.cwd()]),
    PLUGIN_DATA: dataPath,
  };
}

function fakeService(counter: { calls: number; inputs: unknown[] }): FailureService {
  return {
    async classifyFailure(input, signal) {
      assert.equal(signal?.aborted, false);
      assert.equal(input.mode, 'preview');
      counter.calls += 1;
      counter.inputs.push(input);
      return {
        status: 'assessed',
        category: 'assertion_failure',
        workflow: 'inspect_assertion',
        reasonCode: 'assertion_not_reached',
        confidence: 0.9,
        receiptId: 'receipt-is-never-rendered',
      };
    },
  };
}

describe('hook normalization', () => {
  it('normalizes a completed native unified exec failure', () => {
    const normalized = normalizeHookEvent(event());
    assert.equal(normalized?.input.exitCode, 1);
    assert.equal(normalized?.input.output, 'Assertion failed');
    assert.equal(normalized?.input.mode, 'preview');
  });

  it('normalizes the documented model-facing failure string', () => {
    const normalized = normalizeHookEvent(event({
      tool_response: 'Process exited with code 1\nOutput:\npermission denied; Process exited with code 99',
    }));
    assert.equal(normalized?.input.exitCode, 1);
    assert.equal(normalized?.input.output, 'permission denied; Process exited with code 99');
  });

  it('marks provider output that is clipped to the bounded payload', () => {
    const normalized = normalizeHookEvent(event({
      tool_response: { exit_code: 1, output: 'x'.repeat(25_000) },
    }));
    assert.equal(normalized?.input.output.length, 24_000);
    assert.equal(normalized?.input.outputTruncated, true);
  });

  it('does not parse generic error text, successful output, or pending sessions', () => {
    assert.equal(normalizeHookEvent(event({ tool_response: 'Error: command failed' })), undefined);
    assert.equal(normalizeHookEvent(event({ tool_response: { exit_code: 0, output: 'ok' } })), undefined);
    assert.equal(normalizeHookEvent(event({ tool_response: { session_id: 'deferred', output: 'still running' } })), undefined);
  });
});

describe('hook execution', () => {
  it('does not call the service while disabled or for a successful Bash call', async () => {
    const dataPath = await mkdtemp(join(testRoot, 'disabled-'));
    const counter = { calls: 0, inputs: [] as unknown[] };
    const service = fakeService(counter);
    assert.deepEqual(await runHook(JSON.stringify(event()), { env: { ...enabledEnv(dataPath), JEV_HOOKS_ENABLED: '0' }, service }), {});
    assert.deepEqual(await runHook(JSON.stringify(event({ tool_response: { exit_code: 0, output: 'ok' } })), { env: enabledEnv(dataPath), service }), {});
    assert.equal(counter.calls, 0);
  });

  it('calls once for an allowed failed command and deduplicates the same event', async () => {
    const dataPath = join(testRoot, 'enabled-new-data');
    const counter = { calls: 0, inputs: [] as unknown[] };
    const service = fakeService(counter);
    const deps = { env: enabledEnv(dataPath), service };
    const first = await runHook(JSON.stringify(event()), deps);
    const second = await runHook(JSON.stringify(event()), deps);
    assert.equal(first.hookSpecificOutput?.additionalContext, 'JEV local preview: failed Bash command is ready for authorized diagnosis via diagnose-failure or classify_failure.');
    assert.deepEqual(second, {});
    assert.equal(counter.calls, 1);
    assert.equal((counter.inputs[0] as { output: string }).output, 'Assertion failed');
  });

  it('enforces a realpath workspace boundary and never reads transcript_path', async () => {
    const dataPath = await mkdtemp(join(testRoot, 'boundary-'));
    const counter = { calls: 0, inputs: [] as unknown[] };
    const service = fakeService(counter);
    const outside = await mkdtemp(join(tmpdir(), 'jev-outside-'));
    try {
      const result = await runHook(JSON.stringify(event({ cwd: outside, transcript_path: '/path/that/must-not-be-read' })), {
        env: enabledEnv(dataPath),
        service,
      });
      assert.deepEqual(result, {});
      assert.equal(counter.calls, 0);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('does not require an API key and honors the explicit service disable flag', async () => {
    const dataPath = join(testRoot, 'no-key-data');
    const counter = { calls: 0, inputs: [] as unknown[] };
    const service = fakeService(counter);
    const env = { ...enabledEnv(dataPath), TYPESAFE_API_KEY: undefined };
    const result = await runHook(JSON.stringify(event()), { env, service });
    assert.equal(result.hookSpecificOutput?.additionalContext, 'JEV local preview: failed Bash command is ready for authorized diagnosis via diagnose-failure or classify_failure.');
    assert.equal(counter.calls, 1);
    assert.deepEqual(await runHook(JSON.stringify(event({ tool_use_id: 'tool-disabled' })), { env: { ...enabledEnv(dataPath), JEV_ENABLED: '0' }, service }), {});
    assert.equal(counter.calls, 1);
  });

  it('rejects oversized stdin before invoking the service', async () => {
    const dataPath = await mkdtemp(join(testRoot, 'oversized-'));
    const counter = { calls: 0, inputs: [] as unknown[] };
    const service = fakeService(counter);
    const huge = JSON.stringify(event({ tool_response: { exit_code: 1, output: 'x'.repeat(140_000) } }));
    assert.deepEqual(await runHook(huge, { env: enabledEnv(dataPath), service }), {});
    assert.equal(counter.calls, 0);
  });
});
