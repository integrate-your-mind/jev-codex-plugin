import { mkdir, mkdtemp, rm, readFile, writeFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { configurePolicy } from '../src/policy.js';
import { normalizeDecisionEvent, runDecisionHook, type DecisionInput, type DecisionService } from '../src/decision-hook.js';

let root: string;

before(async () => {
  await mkdir(join(process.cwd(), 'work'), {recursive: true});
  root = await mkdtemp(join(process.cwd(), 'work', 'decision-hook-'));
});

after(async () => {
  await rm(root, {recursive: true, force: true});
});

function env(data = join(root, 'data')): NodeJS.ProcessEnv {
  return {PLUGIN_DATA: data, JEV_ENABLED: '1', TYPESAFE_API_KEY: 'dummy-key'};
}

function toolEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    hook_event_name: 'PreToolUse',
    session_id: 'session-1',
    turn_id: 'turn-1',
    tool_use_id: 'tool-1',
    cwd: process.cwd(),
    tool_name: 'Bash',
    model: 'test-model',
    tool_input: {command: 'printf "TOKEN=sk-123456789012345"', extra: 'ignored', 'dummy-key': 'ignored-secret-key'},
    ...overrides,
  };
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

async function enabledPolicy(environment: NodeJS.ProcessEnv, cap: number | null = 50): Promise<void> {
  await configurePolicy({enabled: true, scope: 'workspaces', workspaces: [process.cwd()], maxHookCallsPerSession: cap}, environment);
}

function fakeService(calls: {count: number; inputs: DecisionInput[]}): DecisionService {
  return {
    async classifyDecision(input, signal) {
      assert.equal(signal?.aborted, false);
      calls.count += 1;
      calls.inputs.push(input);
      return {status: 'assessed', choice: 'proceed'};
    },
  };
}

describe('decision hook', () => {
  it('normalizes supported events and rejects missing native identity', () => {
    assert.equal(normalizeDecisionEvent(toolEvent())?.name, 'PreToolUse');
    assert.equal(normalizeDecisionEvent(toolEvent({tool_use_id: undefined})), undefined);
    assert.equal(normalizeDecisionEvent({...toolEvent(), hook_event_name: 'UserPromptSubmit', tool_use_id: undefined, tool_name: undefined, turn_id: undefined, prompt: 'plan the task'})?.name, 'UserPromptSubmit');
    assert.equal(normalizeDecisionEvent({...toolEvent(), hook_event_name: 'SubagentStop', tool_use_id: undefined, tool_name: undefined, agent_id: undefined}), undefined);
    assert.equal(normalizeDecisionEvent({...toolEvent(), hook_event_name: 'PermissionRequest', tool_use_id: undefined})?.name, 'PermissionRequest');
    assert.equal(normalizeDecisionEvent({...toolEvent(), hook_event_name: 'PreCompact', tool_use_id: undefined, tool_name: undefined, trigger: 'auto'})?.name, 'PreCompact');
    assert.equal(normalizeDecisionEvent({...toolEvent(), hook_event_name: 'SubagentStart', tool_use_id: undefined, tool_name: undefined, agent_id: 'agent-a', agent_type: 'worker'})?.name, 'SubagentStart');
    assert.equal(normalizeDecisionEvent({...toolEvent(), hook_event_name: 'Interrupt', tool_use_id: undefined, tool_name: undefined})?.name, 'Interrupt');
    assert.equal(normalizeDecisionEvent({...toolEvent(), hook_event_name: 'SessionEnd', turn_id: undefined, tool_use_id: undefined, tool_name: undefined, reason: 'other'})?.name, 'SessionEnd');
  });

  it('keeps added lifecycle events advisory and uses only their supported output shape', async () => {
    const environment = env(join(root, 'extended-events'));
    await enabledPolicy(environment);
    const calls = {count: 0, inputs: [] as DecisionInput[]};
    const service = fakeService(calls);
    const permission = await runDecisionHook(JSON.stringify(toolEvent({
      hook_event_name: 'PermissionRequest', tool_use_id: undefined, tool_input: {command: 'network request', description: 'needs approval'},
    })), {env: environment, service});
    assert.match(permission.systemMessage ?? '', /status=assessed; decision=proceed/);
    assert.equal(permission.hookSpecificOutput, undefined);
    assert.equal(calls.inputs.at(-1)?.domain, 'tool');

    const preCompact = await runDecisionHook(JSON.stringify(toolEvent({
      hook_event_name: 'PreCompact', tool_name: undefined, tool_use_id: undefined, turn_id: 'compact-turn', trigger: 'auto',
    })), {env: environment, service});
    assert.match(preCompact.systemMessage ?? '', /status=assessed/);
    assert.equal(calls.inputs.at(-1)?.domain, 'context');
    const beforeRepeatedCompact = calls.count;
    await runDecisionHook(JSON.stringify(toolEvent({
      hook_event_name: 'PreCompact', tool_name: undefined, tool_use_id: undefined, turn_id: 'compact-turn', trigger: 'auto',
    })), {env: environment, service});
    assert.equal(calls.count, beforeRepeatedCompact + 1);
    const identifiedCompact = toolEvent({
      hook_event_name: 'PostCompact', tool_name: undefined, tool_use_id: undefined, turn_id: 'compact-turn', trigger: 'manual', event_id: 'compact-event-1',
    });
    await runDecisionHook(JSON.stringify(identifiedCompact), {env: environment, service});
    const beforeDuplicate = calls.count;
    assert.deepEqual(await runDecisionHook(JSON.stringify(identifiedCompact), {env: environment, service}), {});
    assert.equal(calls.count, beforeDuplicate);

    const subagentStart = await runDecisionHook(JSON.stringify(toolEvent({
      hook_event_name: 'SubagentStart', tool_name: undefined, tool_use_id: undefined, turn_id: 'agent-turn', agent_id: 'agent-a', agent_type: 'worker',
    })), {env: environment, service});
    assert.equal(subagentStart.hookSpecificOutput?.hookEventName, 'SubagentStart');
    assert.equal(calls.inputs.at(-1)?.domain, 'task');

    const interrupt = await runDecisionHook(JSON.stringify(toolEvent({
      hook_event_name: 'Interrupt', tool_name: undefined, tool_use_id: undefined, turn_id: 'interrupt-turn',
    })), {env: environment, service});
    assert.match(interrupt.systemMessage ?? '', /status=assessed/);

    const sessionEnd = await runDecisionHook(JSON.stringify(toolEvent({
      hook_event_name: 'SessionEnd', tool_name: undefined, tool_use_id: undefined, turn_id: undefined, reason: 'other',
    })), {env: environment, service});
    assert.match(sessionEnd.systemMessage ?? '', /status=assessed/);
    assert.equal(calls.inputs.at(-1)?.domain, 'result');
  });

  it('calls classifyDecision with bounded redacted semantic input and fixed advisory output', async () => {
    const environment = env(join(root, 'enabled'));
    await enabledPolicy(environment);
    const calls = {count: 0, inputs: [] as DecisionInput[]};
    const result = await runDecisionHook(JSON.stringify(toolEvent()), {env: environment, service: fakeService(calls)});
    assert.equal(result.hookSpecificOutput?.additionalContext, 'JEV advisory: status=assessed; decision=proceed; advisory only, continue ordinary reasoning.');
    assert.equal(calls.count, 1);
    assert.equal(calls.inputs[0]?.mode, 'evaluate');
    assert.doesNotMatch(calls.inputs[0]?.context ?? '', /dummy-key/);
    assert.equal(calls.inputs[0]?.domain, 'tool');
    assert.deepEqual(calls.inputs[0]?.candidates.map(candidate => candidate.id), ['proceed', 'reconsider', 'gather_evidence']);
    assert.doesNotMatch(calls.inputs[0]?.context ?? '', /sk-123456789012345/);
    assert.doesNotMatch(result.hookSpecificOutput?.additionalContext ?? '', /TOKEN|sk-/);
  });

  it('captures bounded successful string and MCP results plus freeform code without surfacing raw output', async () => {
    const environment = env(join(root, 'successful-results'));
    await enabledPolicy(environment);
    const calls = {count: 0, inputs: [] as DecisionInput[]};
    const service = fakeService(calls);
    const codeResult = await runDecisionHook(JSON.stringify(toolEvent({
      tool_name: 'functions.exec',
      tool_input: {code: 'await tools.exec_command({cmd:"TOKEN=sk-123456789012345"})'},
      tool_use_id: 'tool-code',
    })), {env: environment, service});
    assert.match(calls.inputs[0]?.context ?? '', /"code":"await tools\.exec_command/);
    assert.doesNotMatch(calls.inputs[0]?.context ?? '', /sk-123456789012345/);
    assert.doesNotMatch(codeResult.hookSpecificOutput?.additionalContext ?? '', /exec_command|TOKEN/);

    await runDecisionHook(JSON.stringify(toolEvent({
      hook_event_name: 'PostToolUse',
      tool_use_id: 'tool-string-result',
      tool_response: 'BUILD_OK TOKEN=sk-123456789012345',
    })), {env: environment, service});
    const stringInput = calls.inputs.at(-1)!;
    assert.equal(stringInput.domain, 'result');
    assert.equal(stringInput.evidence.some(item => item.id === 'tool.result' && /BUILD_OK TOKEN=\[REDACTED\]/.test(item.text)), true);
    const stringReceiptPath = join(environment.PLUGIN_DATA!, 'decision-hook-v1', digest(process.cwd()), digest('session-1'), 'invocations', `${digest('PostToolUse\0session-1\0turn-1\0tool-string-result')}.json`);
    const stringReceipt = JSON.parse(await readFile(stringReceiptPath, 'utf8')) as {output: Record<string, unknown>; evidenceIds: string[]; contextBytes: number; contextTruncated: boolean; evidenceTruncated: boolean};
    assert.deepEqual(stringReceipt.evidenceIds, ['tool.result']);
    assert.equal(typeof stringReceipt.output.resultExcerptDigest, 'string');
    assert.equal(typeof stringReceipt.output.resultExcerptBytes, 'number');
    assert.equal(typeof stringReceipt.contextBytes, 'number');
    assert.equal(stringReceipt.contextTruncated, false);
    assert.equal(stringReceipt.evidenceTruncated, false);
    assert.doesNotMatch(JSON.stringify(stringReceipt), /BUILD_OK|sk-123/);

    const binary = 'x'.repeat(400);
    await runDecisionHook(JSON.stringify(toolEvent({
      hook_event_name: 'PostToolUse',
      tool_name: 'mcp__example__read',
      tool_use_id: 'tool-mcp-result',
      tool_response: {
        isError: false,
        content: [{type: 'text', text: 'record count 2'}],
        structuredContent: {count: 2, token: 'sk-123456789012345'},
        image: binary,
        download_url: 'https://example.test/private?sig=should-not-leak',
      },
    })), {env: environment, service});
    const mcpEvidence = calls.inputs.at(-1)?.evidence.find(item => item.id === 'tool.result')?.text ?? '';
    assert.match(mcpEvidence, /record count 2/);
    assert.match(mcpEvidence, /"count":2/);
    assert.match(mcpEvidence, /\[REDACTED_FIELD\]/);
    assert.match(mcpEvidence, /OMITTED_BINARY/);
    assert.doesNotMatch(mcpEvidence, /x{200}/);
    assert.doesNotMatch(mcpEvidence, /should-not-leak/);
  });

  it('captures raw string tool input and failure evidence', async () => {
    const environment = env(join(root, 'raw-and-failure'));
    await enabledPolicy(environment);
    const calls = {count: 0, inputs: [] as DecisionInput[]};
    const service = fakeService(calls);
    await runDecisionHook(JSON.stringify(toolEvent({tool_use_id: 'raw-input', tool_input: 'run focused verification'})), {env: environment, service});
    assert.match(calls.inputs.at(-1)?.context ?? '', /run focused verification/);
    await runDecisionHook(JSON.stringify(toolEvent({
      hook_event_name: 'PostToolUse',
      tool_use_id: 'failed-result',
      tool_response: {status: 'failed', exit_code: 7, stderr: 'compile failed at target A'},
    })), {env: environment, service});
    assert.equal(calls.inputs.at(-1)?.evidence.some(item => item.id === 'tool.failure' && item.text === 'compile failed at target A'), true);
  });

  it('marks asynchronous tool responses as running instead of completed', async () => {
    const environment = env(join(root, 'pending-result'));
    await enabledPolicy(environment);
    const calls = {count: 0, inputs: [] as DecisionInput[]};
    const service = fakeService(calls);
    await runDecisionHook(JSON.stringify(toolEvent({
      hook_event_name: 'PostToolUse', tool_use_id: 'pending-object',
      tool_response: {session_id: 42, output: 'Script running with session ID 42'},
    })), {env: environment, service});
    assert.match(calls.inputs.at(-1)?.context ?? '', /"status":"running"/);
    await runDecisionHook(JSON.stringify(toolEvent({
      hook_event_name: 'PostToolUse', tool_use_id: 'pending-string',
      tool_response: 'Script running with cell ID abc123',
    })), {env: environment, service});
    assert.match(calls.inputs.at(-1)?.context ?? '', /"status":"running"/);
  });

  it('fails open for disabled policy, Jev recursion, duplicate events, and cap exhaustion', async () => {
    const disabledEnv = env(join(root, 'disabled'));
    const disabledCalls = {count: 0, inputs: [] as DecisionInput[]};
    assert.deepEqual(await runDecisionHook(JSON.stringify(toolEvent()), {env: disabledEnv, service: fakeService(disabledCalls)}), {});
    assert.equal(disabledCalls.count, 0);

    const cappedEnv = env(join(root, 'capped'));
    await enabledPolicy(cappedEnv, 1);
    const calls = {count: 0, inputs: [] as DecisionInput[]};
    const service = fakeService(calls);
    await runDecisionHook(JSON.stringify(toolEvent()), {env: cappedEnv, service});
    assert.deepEqual(await runDecisionHook(JSON.stringify(toolEvent({tool_use_id: 'tool-2'})), {env: cappedEnv, service}), {});
    assert.equal(calls.count, 1);

    const recursionEnv = env(join(root, 'recursion'));
    await enabledPolicy(recursionEnv);
    const recursionCalls = {count: 0, inputs: [] as DecisionInput[]};
    assert.deepEqual(await runDecisionHook(JSON.stringify(toolEvent({tool_name: 'mcp__jev-workflows__classify_decision'})), {env: recursionEnv, service: fakeService(recursionCalls)}), {});
    assert.equal(recursionCalls.count, 0);
  });

  it('evaluates concurrent distinct events under unlimited policy and atomically deduplicates identical events', async () => {
    const environment = env(join(root, 'concurrent-unlimited'));
    await enabledPolicy(environment, null);
    const calls = {count: 0, inputs: [] as DecisionInput[]};
    const service = fakeService(calls);
    await Promise.all([
      runDecisionHook(JSON.stringify(toolEvent({tool_use_id: 'concurrent-a'})), {env: environment, service}),
      runDecisionHook(JSON.stringify(toolEvent({tool_use_id: 'concurrent-b'})), {env: environment, service}),
    ]);
    assert.equal(calls.count, 2);
    const duplicate = JSON.stringify(toolEvent({tool_use_id: 'concurrent-duplicate'}));
    await Promise.all([
      runDecisionHook(duplicate, {env: environment, service}),
      runDecisionHook(duplicate, {env: environment, service}),
    ]);
    assert.equal(calls.count, 3);
  });

  it('reports oversized hook input only when automation is enabled', async () => {
    const disabledEnvironment = env(join(root, 'oversized-disabled'));
    const oversized = 'x'.repeat(129 * 1024);
    assert.deepEqual(await runDecisionHook(oversized, {env: disabledEnvironment}), {});
    const enabledEnvironment = env(join(root, 'oversized-enabled'));
    await enabledPolicy(enabledEnvironment);
    const result = await runDecisionHook(oversized, {env: enabledEnvironment});
    assert.equal(result.systemMessage, 'JEV advisory: status=skipped; reason=hook_input_too_large; continue ordinary reasoning and gather authorized evidence if useful.');
  });

  it('classifies a bounded prompt, reuses it for tool relevance, and injects fixed guidance', async () => {
    const environment = env(join(root, 'guidance'));
    await enabledPolicy(environment);
    const session = toolEvent({hook_event_name: 'SessionStart', turn_id: undefined, tool_use_id: undefined, tool_name: undefined});
    const prompt = toolEvent({hook_event_name: 'UserPromptSubmit', tool_input: {prompt: 'ignored'}, tool_use_id: undefined, tool_name: undefined, turn_id: undefined, prompt: 'plan TOKEN=sk-123456789012345 safely'});
    const first = await runDecisionHook(JSON.stringify(session), {env: environment});
    const second = await runDecisionHook(JSON.stringify(session), {env: environment});
    const calls = {count: 0, inputs: [] as DecisionInput[]};
    const service = fakeService(calls);
    const promptResult = await runDecisionHook(JSON.stringify(prompt), {env: environment, service});
    const toolResult = await runDecisionHook(JSON.stringify(toolEvent({session_id: 'session-1', turn_id: 'turn-2', tool_use_id: 'tool-relevance'})), {env: environment, service});
    assert.match(first.hookSpecificOutput?.additionalContext ?? '', /consult classify_decision/);
    assert.match(second.hookSpecificOutput?.additionalContext ?? '', /consult classify_decision/);
    assert.match(promptResult.hookSpecificOutput?.additionalContext ?? '', /consult classify_decision/);
    assert.match(promptResult.hookSpecificOutput?.additionalContext ?? '', /decision=proceed/);
    assert.equal(calls.inputs[0]?.domain, 'task');
    assert.match(calls.inputs[0]?.context ?? '', /plan TOKEN=\[REDACTED\] safely/);
    assert.equal(calls.inputs[1]?.domain, 'tool');
    assert.match(calls.inputs[1]?.context ?? '', /plan TOKEN=\[REDACTED\] safely/);
    assert.equal('continue' in first, false);
    assert.equal('decision' in first, false);
  });

  it('includes bounded final assistant messages and expires the private prompt cache', async () => {
    const environment = env(join(root, 'ttl'));
    await enabledPolicy(environment);
    const calls = {count: 0, inputs: [] as DecisionInput[]};
    const service = fakeService(calls);
    await runDecisionHook(JSON.stringify(toolEvent({hook_event_name: 'UserPromptSubmit', tool_name: undefined, tool_use_id: undefined, turn_id: 'turn-ttl', prompt: 'remember this task'})), {env: environment, service});
    await runDecisionHook(JSON.stringify(toolEvent({hook_event_name: 'Stop', tool_name: undefined, tool_use_id: undefined, turn_id: 'turn-stop', last_assistant_message: 'final answer with SECRET=hidden'})), {env: environment, service});
    assert.match(calls.inputs.at(-1)?.context ?? '', /final answer with SECRET=\[REDACTED\]/);
    const cache = join(environment.PLUGIN_DATA!, 'decision-hook-v1', digest(process.cwd()), digest('session-1'), 'prompt.json');
    const stale = JSON.stringify({prompt: 'stale task', updatedAt: Date.now() - 25 * 60 * 60 * 1000});
    await writeFile(cache, stale, {mode: 0o600});
    const before = calls.count;
    await runDecisionHook(JSON.stringify(toolEvent({turn_id: 'turn-after-ttl', tool_use_id: 'tool-after-ttl'})), {env: environment, service});
    assert.equal(calls.count, before + 1);
    assert.doesNotMatch(calls.inputs.at(-1)?.context ?? '', /stale task/);
  });

  it('carries same-turn tool summaries into Stop and excludes other-turn summaries', async () => {
    const environment = env(join(root, 'turn-results'));
    await enabledPolicy(environment);
    const calls = {count: 0, inputs: [] as DecisionInput[]};
    const service = fakeService(calls);
    await runDecisionHook(JSON.stringify(toolEvent({
      hook_event_name: 'PostToolUse',
      turn_id: 'turn-with-result',
      tool_use_id: 'tool-for-stop',
      tool_response: 'TESTS_PASSED',
    })), {env: environment, service});
    await runDecisionHook(JSON.stringify(toolEvent({
      hook_event_name: 'Stop',
      tool_name: undefined,
      tool_use_id: undefined,
      turn_id: 'turn-with-result',
      last_assistant_message: 'work complete',
    })), {env: environment, service});
    const sameTurn = calls.inputs.at(-1)!;
    assert.match(sameTurn.context, /"turnResults":\{"status":"available"/);
    assert.equal(sameTurn.evidence.some(item => item.id === 'result.tool_summaries' && /TESTS_PASSED/.test(item.text)), true);

    await runDecisionHook(JSON.stringify(toolEvent({
      hook_event_name: 'Stop',
      tool_name: undefined,
      tool_use_id: undefined,
      turn_id: 'different-turn',
      last_assistant_message: 'different result',
    })), {env: environment, service});
    const otherTurn = calls.inputs.at(-1)!;
    assert.match(otherTurn.context, /"turnResults":\{"status":"out_of_turn","results":\[\]\}/);
    assert.equal(otherTurn.evidence.some(item => item.id === 'result.tool_summaries'), false);
  });

  it('marks stale same-turn tool summaries and does not use them as evidence', async () => {
    const environment = env(join(root, 'stale-turn-results'));
    await enabledPolicy(environment);
    const calls = {count: 0, inputs: [] as DecisionInput[]};
    const service = fakeService(calls);
    const turnId = 'stale-turn';
    await runDecisionHook(JSON.stringify(toolEvent({
      hook_event_name: 'PostToolUse', turn_id: turnId, tool_use_id: 'stale-tool', tool_response: 'OLD_RESULT',
    })), {env: environment, service});
    const path = join(environment.PLUGIN_DATA!, 'decision-hook-v1', digest(process.cwd()), digest('session-1'), 'turn-results', `${digest(turnId)}.json`);
    await writeFile(path, JSON.stringify({turnHash: digest(turnId), updatedAt: Date.now() - 3 * 60 * 60 * 1000, results: [{resultExcerpt: 'OLD_RESULT'}]}), {mode: 0o600});
    await runDecisionHook(JSON.stringify(toolEvent({
      hook_event_name: 'Stop', tool_name: undefined, tool_use_id: undefined, turn_id: turnId, last_assistant_message: 'done',
    })), {env: environment, service});
    const stopInput = calls.inputs.at(-1)!;
    assert.match(stopInput.context, /"turnResults":\{"status":"stale","results":\[\]\}/);
    assert.equal(stopInput.evidence.some(item => /OLD_RESULT/.test(item.text)), false);
  });

  it('keeps oversized task context valid JSON and records explicit truncation flags', async () => {
    const environment = env(join(root, 'context-truncation'));
    await enabledPolicy(environment);
    const calls = {count: 0, inputs: [] as DecisionInput[]};
    const service = fakeService(calls);
    const turnId = 'large-context-turn';
    await runDecisionHook(JSON.stringify(toolEvent({
      hook_event_name: 'UserPromptSubmit', tool_name: undefined, tool_use_id: undefined, turn_id: turnId, prompt: `task-${'p'.repeat(1490)}`,
    })), {env: environment, service});
    for (let index = 0; index < 8; index++) {
      await runDecisionHook(JSON.stringify(toolEvent({
        hook_event_name: 'PostToolUse', turn_id: turnId, tool_use_id: `large-result-${index}`, tool_response: `${index}-${'r'.repeat(1490)}`,
      })), {env: environment, service});
    }
    await runDecisionHook(JSON.stringify(toolEvent({
      hook_event_name: 'Stop', tool_name: undefined, tool_use_id: undefined, turn_id: turnId, last_assistant_message: `final-${'f'.repeat(2000)}`,
    })), {env: environment, service});
    const stopInput = calls.inputs.at(-1)!;
    const parsedContext = JSON.parse(stopInput.context) as {contextTruncated?: boolean};
    assert.equal(parsedContext.contextTruncated, true);
    assert.ok(Buffer.byteLength(stopInput.context) < 5_000);
    const receiptPath = join(environment.PLUGIN_DATA!, 'decision-hook-v1', digest(process.cwd()), digest('session-1'), 'invocations', `${digest(`Stop\0session-1\0${turnId}`)}.json`);
    const receipt = JSON.parse(await readFile(receiptPath, 'utf8')) as {contextTruncated: boolean; evidenceTruncated: boolean};
    assert.equal(receipt.contextTruncated, true);
    assert.equal(receipt.evidenceTruncated, true);
  });

  it('writes bounded private invocation receipts without raw context', async () => {
    const environment = env(join(root, 'receipts'));
    await enabledPolicy(environment);
    const service: DecisionService = {classifyDecision: async () => ({status: 'assessed', choice: 'proceed', receiptId: '11111111-1111-1111-1111-111111111111', receiptPersisted: true})};
    await runDecisionHook(JSON.stringify(toolEvent()), {env: environment, service});
    const receiptPath = join(environment.PLUGIN_DATA!, 'decision-hook-v1', digest(process.cwd()), digest('session-1'), 'invocations', `${digest('PreToolUse\0session-1\0turn-1\0tool-1')}.json`);
    const receipt = JSON.parse(await readFile(receiptPath, 'utf8')) as Record<string, unknown>;
    assert.equal(receipt.event, 'PreToolUse');
    assert.equal(receipt.referenceReceiptId, '11111111-1111-1111-1111-111111111111');
    assert.equal(typeof receipt.inputDigest, 'string');
    assert.doesNotMatch(JSON.stringify(receipt), /TOKEN|sk-123/);
  });

  it('deduplicates each SubagentStop agent independently within a shared turn', async () => {
    const environment = env(join(root, 'subagents'));
    await enabledPolicy(environment);
    const calls = {count: 0, inputs: [] as DecisionInput[]};
    const service = fakeService(calls);
    const base = toolEvent({hook_event_name: 'SubagentStop', tool_name: undefined, tool_use_id: undefined, turn_id: 'shared-turn', stop_hook_active: false, agent_type: 'worker'});
    const first = {...base, agent_id: 'agent-a', last_assistant_message: 'agent A finished'};
    const second = {...base, agent_id: 'agent-b', last_assistant_message: 'agent B finished'};
    assert.equal((await runDecisionHook(JSON.stringify(first), {env: environment, service})).systemMessage?.includes('decision=proceed'), true);
    assert.equal((await runDecisionHook(JSON.stringify(second), {env: environment, service})).systemMessage?.includes('decision=proceed'), true);
    assert.deepEqual(await runDecisionHook(JSON.stringify(first), {env: environment, service}), {});
    assert.equal(calls.count, 2);
    assert.match(calls.inputs[0]?.context ?? '', /"turnResults":\{"status":"unsupported_agent_scope","results":\[\]\}/);
    const invocationDir = join(environment.PLUGIN_DATA!, 'decision-hook-v1', digest(process.cwd()), digest('session-1'), 'invocations');
    assert.equal((await readdir(invocationDir)).length, 2);
  });

  it('reports a provider that ignores abort as an explicit hook timeout', async () => {
    const environment = env(join(root, 'timeout'));
    await enabledPolicy(environment);
    const service: DecisionService = {classifyDecision: async () => new Promise(() => {})};
    const started = Date.now();
    const result = await runDecisionHook(JSON.stringify(toolEvent()), {env: environment, service, hookTimeoutMs: 25});
    assert.match(result.hookSpecificOutput?.additionalContext ?? '', /status=unavailable; reason=hook_timeout/);
    assert.ok(Date.now() - started < 500);
  });

  it('reports service errors and fixed receipt-backed abstention details', async () => {
    const errorEnvironment = env(join(root, 'service-error'));
    await enabledPolicy(errorEnvironment);
    const errorService: DecisionService = {classifyDecision: async () => { throw new Error('private failure'); }};
    const errorResult = await runDecisionHook(JSON.stringify(toolEvent()), {env: errorEnvironment, service: errorService});
    assert.match(errorResult.hookSpecificOutput?.additionalContext ?? '', /status=unavailable; reason=service_error/);
    assert.doesNotMatch(errorResult.hookSpecificOutput?.additionalContext ?? '', /private failure/);

    const abstainEnvironment = env(join(root, 'abstention'));
    await enabledPolicy(abstainEnvironment);
    const abstainService: DecisionService = {classifyDecision: async () => ({
      status: 'abstained', choice: 'gather_evidence', confidence: 0.37,
      reasonCode: 'low_confidence', receiptId: '11111111-1111-1111-1111-111111111111', receiptPersisted: true,
    })};
    const abstain = await runDecisionHook(JSON.stringify(toolEvent()), {env: abstainEnvironment, service: abstainService});
    assert.equal(abstain.hookSpecificOutput?.additionalContext,
      'JEV advisory: status=abstained; decision=gather_evidence; confidence=0.37; reason=low_confidence; receipt=11111111-1111-1111-1111-111111111111; continue ordinary reasoning and gather authorized evidence if useful.');
  });
});
