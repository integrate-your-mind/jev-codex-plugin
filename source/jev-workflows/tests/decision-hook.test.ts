import { mkdir, mkdtemp, rm, readFile, writeFile, readdir, rename, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { renameSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { configurePolicy } from '../src/policy.js';
import { normalizeDecisionEvent, runDecisionHook, type DecisionInput, type DecisionService } from '../src/decision-hook.js';
import { createService } from '../src/service.js';
import { updateTaskContext } from '../src/task-context.js';

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

type ProviderPayload = {
  state: DecisionInput;
  questions: {decision: {criteria: Record<string, string>}};
};

function providerSelecting(choice: string, calls: ProviderPayload[] = []): typeof fetch {
  return async (_input, init) => {
    const payload = JSON.parse(String(init?.body)) as ProviderPayload;
    calls.push(payload);
    const labels = Object.keys(payload.questions.decision.criteria);
    assert.ok(labels.includes(choice));
    const selectedProbability = 0.91;
    const remainder = labels.length > 1 ? (1 - selectedProbability) / (labels.length - 1) : 0;
    const probabilities = Object.fromEntries(labels.map(label => [label, label === choice ? selectedProbability : remainder]));
    return new Response(JSON.stringify({
      model: 'jev-1.13.0',
      answers: {decision: {type: 'choice', choice, probabilities, confidence: 0.96}},
      usage: {input_tokens: 31, output_tokens: 11},
    }));
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
    const parsedContext = JSON.parse(stopInput.context) as {contextTruncated?: boolean; turnResults?: {status?: string; resultCount?: number}};
    assert.equal(parsedContext.contextTruncated, true);
    assert.equal(parsedContext.turnResults?.status, 'available');
    assert.equal(parsedContext.turnResults?.resultCount, 8);
    assert.ok(Buffer.byteLength(stopInput.context) < 5_000);
    const receiptPath = join(environment.PLUGIN_DATA!, 'decision-hook-v1', digest(process.cwd()), digest('session-1'), 'invocations', `${digest(`Stop\0session-1\0${turnId}`)}.json`);
    const receipt = JSON.parse(await readFile(receiptPath, 'utf8')) as {contextTruncated: boolean; evidenceTruncated: boolean};
    assert.equal(receipt.contextTruncated, true);
    assert.equal(receipt.evidenceTruncated, true);
  });

  it('bounds a valid large saved task context before the real service validates and calls the provider', async () => {
    const environment = env(join(root, 'large-saved-context'));
    await enabledPolicy(environment);
    const sessionId = 'large-saved-context-session';
    const opaqueSecret = 'sk-123456789012345';
    const segment = 'context-segment '.repeat(100);
    const saved = await updateTaskContext({cwd: process.cwd(), sessionId}, {
      operation: 'replace',
      rootObjective: `root-${segment}`,
      constraints: Array.from({length: 9}, (_, index) => `constraint-${index}-${index === 0 ? opaqueSecret : ''}${segment}`),
      criteria: [`Retain the latest constraint and result metadata ${segment}-LATEST_CRITERION_KEEP`],
      corrections: Array.from({length: 3}, (_, index) => `correction-${index}-${segment}${index === 2 ? '-LATEST_CORRECTION_DECISIVE' : ''}`),
      provenance: {source: 'system'},
    }, {env: environment});
    assert.ok(saved);

    const providerCalls: ProviderPayload[] = [];
    const service = createService({apiKey: 'dummy-key', env: environment, fetchFn: providerSelecting('proceed', providerCalls)});
    const result = await runDecisionHook(JSON.stringify(toolEvent({
      hook_event_name: 'UserPromptSubmit', session_id: sessionId, turn_id: 'large-saved-context-turn',
      tool_name: undefined, tool_use_id: undefined, prompt: `Continue the bounded task ${opaqueSecret}`,
    })), {env: environment, service});
    assert.match(result.hookSpecificOutput?.additionalContext ?? '', /status=assessed; decision=proceed/);
    assert.equal(providerCalls.length, 1);

    const state = providerCalls[0]!.state;
    const promptEvidence = state.evidence.find(item => item.id === 'task.prompt');
    assert.equal(promptEvidence?.text, 'Continue the bounded task [REDACTED]');
    assert.ok(Buffer.byteLength(promptEvidence?.text ?? '') < 12_000);
    assert.doesNotMatch(promptEvidence?.text ?? '', /rootObjective|constraints/);
    const context = JSON.parse(state.context) as {
      contextTruncated?: boolean;
      taskContext?: Record<string, unknown>;
      truncation?: {taskContext?: boolean};
    };
    assert.equal(context.contextTruncated, true);
    assert.equal(context.truncation?.taskContext, true);
    assert.equal('taskPrompt' in context, false);
    assert.equal(typeof context.taskContext, 'object');
    assert.match(JSON.stringify(context.taskContext), /constraint-8/);
    assert.match(JSON.stringify(context.taskContext), /LATEST_CRITERION_KEEP/);
    assert.match(JSON.stringify(context.taskContext), /LATEST_CORRECTION_DECISIVE/);
    assert.ok(Buffer.byteLength(JSON.stringify(context.taskContext)) <= 1_400);
    const taskTruncation = context.taskContext?.truncation as {omitted?: {constraints?: number; corrections?: number}};
    assert.equal(taskTruncation.omitted?.constraints, 7);
    assert.equal(taskTruncation.omitted?.corrections, 2);
    assert.doesNotMatch(JSON.stringify(providerCalls[0]), /sk-123456789012345|dummy-key/);
  });

  it('retains the newest constraint and correction in the strict fallback context budget', async () => {
    const environment = env(join(root, 'strict-context-fallback'));
    await enabledPolicy(environment);
    const sessionId = 'strict-context-fallback-session';
    const segment = 'bounded-context '.repeat(100);
    await updateTaskContext({cwd: process.cwd(), sessionId}, {
      operation: 'replace',
      rootObjective: `root ${segment}`,
      latestStep: `latest ${segment}`,
      constraints: Array.from({length: 9}, (_, index) => `constraint-${index} ${segment}${index === 8 ? 'LATEST_CONSTRAINT_DECISIVE' : ''}`),
      criteria: [`criterion ${segment}LATEST_CRITERION_DECISIVE`],
      corrections: Array.from({length: 3}, (_, index) => `correction-${index} ${segment}${index === 2 ? 'LATEST_CORRECTION_DECISIVE' : ''}`),
      provenance: {source: 'system'},
    }, {env: environment});
    const calls = {count: 0, inputs: [] as DecisionInput[]};
    const escapeHeavy = '\\"'.repeat(900);
    await runDecisionHook(JSON.stringify(toolEvent({
      hook_event_name: 'Stop', session_id: sessionId, turn_id: 'strict-context-turn', tool_name: undefined, tool_use_id: undefined,
      tool_input: {command: escapeHeavy},
      tool_response: {status: 'failed', exit_code: 1, output: escapeHeavy},
      last_assistant_message: escapeHeavy,
    })), {env: environment, service: fakeService(calls)});
    const context = JSON.parse(calls.inputs[0]!.context) as {
      contextTruncated?: boolean;
      response?: {status?: string; exitCode?: number};
      taskContext?: Record<string, unknown>;
    };
    assert.equal(context.contextTruncated, true);
    assert.equal(context.response?.status, 'failed');
    assert.equal(context.response?.exitCode, 1);
    assert.ok(Buffer.byteLength(JSON.stringify(context.taskContext)) <= 700);
    assert.match(JSON.stringify(context.taskContext), /LATEST_CONSTRAINT_DECISIVE/);
    assert.match(JSON.stringify(context.taskContext), /LATEST_CORRECTION_DECISIVE/);
    const taskTruncation = context.taskContext?.truncation as {omitted?: {constraints?: number; criteria?: number; corrections?: number}};
    assert.equal(taskTruncation.omitted?.constraints, 8);
    assert.equal(taskTruncation.omitted?.criteria, 0);
    assert.equal(taskTruncation.omitted?.corrections, 2);
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

  it('does not send a retired credential from a queued hook event after file rotation', async () => {
    const environment = env(join(root, 'rotated-event'));
    const credentialPath = join(root, 'rotated-event-key.env');
    const oldKey = 'old.' + 'aB7_cD8-eF9.'.repeat(9);
    const newKey = 'new.' + 'gH2_iJ3-kL4.'.repeat(9);
    await writeFile(credentialPath, `TYPESAFE_API_KEY='${oldKey}'\n`, {mode: 0o600});
    environment.JEV_API_KEY_FILE = credentialPath;
    await enabledPolicy(environment);
    const queuedEvent = JSON.stringify(toolEvent({
      hook_event_name: 'PostToolUse',
      tool_use_id: 'queued-before-rotation',
      tool_response: `command output contained ${oldKey} before rotation`,
    }));
    const replacement = `${credentialPath}.next`;
    await writeFile(replacement, `TYPESAFE_API_KEY='${newKey}'\n`, {mode: 0o600});
    await rename(replacement, credentialPath);
    const calls = {count: 0, inputs: [] as DecisionInput[]};
    await runDecisionHook(queuedEvent, {env: environment, service: fakeService(calls)});
    assert.equal(calls.count, 1);
    const outbound = JSON.stringify(calls.inputs[0]);
    assert.ok(outbound.includes('[REDACTED OPAQUE TOKEN]'));
    assert.equal(outbound.includes(oldKey), false);
    assert.equal(outbound.includes(newKey), false);

    await rm(credentialPath);
    await runDecisionHook(JSON.stringify(toolEvent({tool_use_id: 'missing-credential'})), {env: environment, service: fakeService(calls)});
    assert.equal(calls.count, 1);
  });

  it('uses the hook-entry credential for redaction and provider authentication across rotation', async () => {
    const environment = env(join(root, 'rotation-during-hook'));
    const credentialPath = join(root, 'rotation-during-hook-key.env');
    const firstKey = 'first.' + 'aB7_cD8-eF9.'.repeat(9);
    const secondKey = 'second.' + 'gH2_iJ3-kL4.'.repeat(9);
    const replacement = `${credentialPath}.next`;
    await writeFile(credentialPath, `TYPESAFE_API_KEY='${firstKey}'\n`, {mode: 0o600});
    await writeFile(replacement, `TYPESAFE_API_KEY='${secondKey}'\n`, {mode: 0o600});
    environment.JEV_API_KEY_FILE = credentialPath;
    await enabledPolicy(environment);
    let authorization: string | null = null;
    let outbound = '';
    const fetchFn: typeof fetch = async (_url, init) => {
      authorization = new Headers(init?.headers).get('authorization');
      outbound = String(init?.body ?? '');
      return new Response('', {status: 403});
    };
    const pending = runDecisionHook(JSON.stringify(toolEvent({
      tool_use_id: 'rotation-after-entry',
      tool_input: {command: `process ${firstKey}`},
    })), {env: environment, fetchFn});
    // runDecisionHook snapshots synchronously before its first await.
    renameSync(replacement, credentialPath);
    const result = await pending;
    assert.equal(authorization, `Bearer ${firstKey}`);
    assert.equal(outbound.includes(firstKey), false);
    assert.match(outbound, /\[REDACTED\]/);
    assert.match(result.hookSpecificOutput?.additionalContext ?? '', /status=unavailable; reason=request_forbidden/);
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

  it('clips hook context on UTF-8 boundaries while retaining the tail', async () => {
    const environment = env(join(root, 'utf8-context'));
    await enabledPolicy(environment);
    const calls = {count: 0, inputs: [] as DecisionInput[]};
    const service = fakeService(calls);
    await runDecisionHook(JSON.stringify(toolEvent({
      hook_event_name: 'UserPromptSubmit', tool_name: undefined, tool_use_id: undefined,
      turn_id: 'utf8-turn', prompt: `${'é'.repeat(1_000)}HOOK_UTF8_TAIL_KEEP`,
    })), {env: environment, service});
    assert.equal(calls.count, 1);
    assert.doesNotMatch(calls.inputs[0]?.context ?? '', /\uFFFD/);
    assert.match(calls.inputs[0]?.context ?? '', /HOOK_UTF8_TAIL_KEEP/);
  });

  it('uses a supplied single candidate instead of inventing a fallback catalog', async () => {
    const environment = env(join(root, 'single-candidate'));
    await enabledPolicy(environment);
    const calls = {count: 0, inputs: [] as DecisionInput[]};
    const service = fakeService(calls);
    await runDecisionHook(JSON.stringify(toolEvent({
      task_context: {candidateCatalog: {tool: [{id: 'read_thread', description: 'Read the supplied thread.'}]}},
    })), {env: environment, service});
    assert.deepEqual(calls.inputs[0]?.candidates.map(candidate => candidate.id), ['read_thread']);
    assert.match(calls.inputs[0]?.context ?? '', /"provided":true/);
  });

  it('prefers the current event candidate catalog over a stale saved catalog', async () => {
    const environment = env(join(root, 'current-catalog-precedence'));
    await enabledPolicy(environment);
    const sessionId = 'current-catalog-session';
    await updateTaskContext({cwd: process.cwd(), sessionId}, {
      operation: 'replace',
      rootObjective: 'Use the current event availability.',
      candidateCatalogs: {tool: [{id: 'read_thread', description: 'Stale saved candidate.'}]},
      provenance: {source: 'system'},
    }, {env: environment});
    const calls = {count: 0, inputs: [] as DecisionInput[]};
    const result = await runDecisionHook(JSON.stringify(toolEvent({
      session_id: sessionId,
      tool_use_id: 'current-catalog-tool',
      task_context: {candidateCatalog: {tool: [{id: 'run_tests', description: 'Current available candidate.'}]}},
    })), {env: environment, service: {
      async classifyDecision(input) {
        calls.count += 1;
        calls.inputs.push(input);
        return {status: 'assessed', choice: 'run_tests', confidence: 0.93};
      },
    }});
    assert.deepEqual(calls.inputs[0]?.candidates.map(candidate => candidate.id), ['run_tests']);
    assert.match(calls.inputs[0]?.context ?? '', /"source":"host\.event\.task_context"/);
    assert.match(result.hookSpecificOutput?.additionalContext ?? '', /decision=run_tests/);
    assert.doesNotMatch(result.hookSpecificOutput?.additionalContext ?? '', /read_thread/);
  });

  it('rejects duplicate supplied candidate IDs instead of resolving conflicting availability by order', async () => {
    const environment = env(join(root, 'duplicate-candidate-ids'));
    await enabledPolicy(environment);
    const calls = {count: 0, inputs: [] as DecisionInput[]};
    await runDecisionHook(JSON.stringify(toolEvent({
      tool_use_id: 'duplicate-candidate-tool',
      task_context: {candidateCatalog: {tool: [
        {id: 'read_thread', description: 'First duplicate.', available: true},
        {id: 'read_thread', description: 'Conflicting duplicate.', available: false},
      ]}},
    })), {env: environment, service: fakeService(calls)});
    assert.deepEqual(calls.inputs[0]?.candidates.map(candidate => candidate.id), ['proceed', 'reconsider', 'gather_evidence']);
    assert.match(calls.inputs[0]?.context ?? '', /"source":"fallback:invalid_or_insufficient_catalog"/);
    assert.match(calls.inputs[0]?.question ?? '', /Should this tool action proceed/);
  });

  it('rejects non-boolean candidate availability instead of coercing it to available', async () => {
    const cases: Array<{name: string; available: unknown}> = [
      {name: 'string', available: 'false'},
      {name: 'number', available: 0},
      {name: 'null', available: null},
    ];
    for (const item of cases) {
      const environment = env(join(root, `malformed-availability-${item.name}`));
      await enabledPolicy(environment);
      const calls = {count: 0, inputs: [] as DecisionInput[]};
      await runDecisionHook(JSON.stringify(toolEvent({
        tool_use_id: `malformed-availability-${item.name}`,
        task_context: {candidateCatalog: {tool: [
          {id: 'read_thread', description: 'Malformed availability candidate.', available: item.available},
        ]}},
      })), {env: environment, service: fakeService(calls)});
      assert.deepEqual(calls.inputs[0]?.candidates.map(candidate => candidate.id), ['proceed', 'reconsider', 'gather_evidence']);
      assert.match(calls.inputs[0]?.context ?? '', /"source":"fallback:invalid_or_insufficient_catalog"/);
      assert.match(calls.inputs[0]?.question ?? '', /Should this tool action proceed/);
    }
  });

  it('asks about and emits the selected supplied candidate through the real service boundary', async () => {
    const environment = env(join(root, 'selected-candidate'));
    await enabledPolicy(environment);
    const providerCalls: ProviderPayload[] = [];
    const service = createService({apiKey: 'dummy-key', env: environment, fetchFn: providerSelecting('read_thread', providerCalls)});
    const result = await runDecisionHook(JSON.stringify(toolEvent({
      tool_use_id: 'selected-candidate-tool',
      task_context: {candidateCatalog: {tool: [
        {id: 'read_thread', description: 'Read the relevant thread.'},
        {id: 'run_tests', description: 'Run focused tests.'},
      ]}},
    })), {env: environment, service});
    const advisory = result.hookSpecificOutput?.additionalContext ?? '';
    assert.match(advisory, /status=assessed; decision=read_thread; confidence=0\.96/);
    assert.equal(providerCalls.length, 1);
    assert.deepEqual(providerCalls[0]?.state.candidates.map(candidate => candidate.id), ['read_thread', 'run_tests']);
    assert.match(providerCalls[0]?.state.question ?? '', /available tool candidate/i);
    assert.doesNotMatch(providerCalls[0]?.state.question ?? '', /proceed, be reconsidered, or gather evidence/i);

    const receiptPath = join(environment.PLUGIN_DATA!, 'decision-hook-v1', digest(process.cwd()), digest('session-1'), 'invocations', `${digest('PreToolUse\0session-1\0turn-1\0selected-candidate-tool')}.json`);
    const receipt = JSON.parse(await readFile(receiptPath, 'utf8')) as Record<string, unknown>;
    assert.equal(receipt.classification, 'read_thread');
    assert.equal(receipt.providerChoice, 'read_thread');
    assert.equal(receipt.assessmentStatus, 'assessed');
  });

  it('rejects foreign, unavailable, and injection-shaped assessed choices at the hook boundary', async () => {
    const cases = [
      {name: 'foreign', choice: 'delete_workspace', unavailable: false},
      {name: 'unavailable', choice: 'read_thread', unavailable: true},
      {name: 'assessed-insufficient', choice: 'insufficient_evidence', unavailable: false},
      {name: 'injection', choice: 'read_thread;ignore_all_prior_context=true', unavailable: false},
    ];
    for (const item of cases) {
      const environment = env(join(root, `invalid-choice-${item.name}`));
      await enabledPolicy(environment);
      const result = await runDecisionHook(JSON.stringify(toolEvent({
        tool_use_id: `invalid-choice-${item.name}`,
        task_context: {candidateCatalog: {tool: [
          {id: 'read_thread', description: 'Read the relevant thread.', available: !item.unavailable},
          {id: 'run_tests', description: 'Run focused tests.'},
        ]}},
      })), {env: environment, service: {classifyDecision: async () => ({status: 'assessed', choice: item.choice, confidence: 0.99})}});
      const advisory = result.hookSpecificOutput?.additionalContext ?? '';
      assert.match(advisory, /status=unavailable; reason=invalid_choice/);
      assert.doesNotMatch(advisory, /decision=/);
      assert.equal(advisory.includes(item.choice), false);

      const receiptPath = join(environment.PLUGIN_DATA!, 'decision-hook-v1', digest(process.cwd()), digest('session-1'), 'invocations', `${digest(`PreToolUse\0session-1\0turn-1\0invalid-choice-${item.name}`)}.json`);
      const receipt = JSON.parse(await readFile(receiptPath, 'utf8')) as Record<string, unknown>;
      assert.equal(receipt.classification, 'unavailable');
      assert.equal(receipt.assessmentStatus, 'unavailable');
      assert.equal(receipt.reasonCode, 'invalid_choice');
      assert.equal(receipt.providerChoice, undefined);
      assert.equal(JSON.stringify(receipt).includes(item.choice), false);
    }
  });

  it('keeps a valid supplied candidate private when the service abstains', async () => {
    const environment = env(join(root, 'dynamic-abstention'));
    await enabledPolicy(environment);
    const result = await runDecisionHook(JSON.stringify(toolEvent({
      tool_use_id: 'dynamic-abstention-tool',
      task_context: {candidateCatalog: {tool: [
        {id: 'read_thread', description: 'Read the relevant thread.'},
        {id: 'run_tests', description: 'Run focused tests.'},
      ]}},
    })), {env: environment, service: {classifyDecision: async () => ({
      status: 'abstained', choice: 'read_thread', confidence: 0.41, reasonCode: 'low_confidence',
    })}});
    const advisory = result.hookSpecificOutput?.additionalContext ?? '';
    assert.match(advisory, /status=abstained; confidence=0\.41; reason=low_confidence/);
    assert.doesNotMatch(advisory, /decision=read_thread/);
    const receiptPath = join(environment.PLUGIN_DATA!, 'decision-hook-v1', digest(process.cwd()), digest('session-1'), 'invocations', `${digest('PreToolUse\0session-1\0turn-1\0dynamic-abstention-tool')}.json`);
    const receipt = JSON.parse(await readFile(receiptPath, 'utf8')) as Record<string, unknown>;
    assert.equal(receipt.providerChoice, 'read_thread');
    assert.equal(receipt.classification, 'unavailable');
    assert.equal(receipt.assessmentStatus, 'abstained');
  });

  it('retains a real provider insufficient-evidence abstention only in the compact receipt', async () => {
    const environment = env(join(root, 'provider-insufficient-evidence'));
    await enabledPolicy(environment);
    const providerCalls: ProviderPayload[] = [];
    const service = createService({apiKey: 'dummy-key', env: environment, fetchFn: providerSelecting('insufficient_evidence', providerCalls)});
    const result = await runDecisionHook(JSON.stringify(toolEvent({
      tool_use_id: 'provider-insufficient-evidence-tool',
      task_context: {candidateCatalog: {tool: [
        {id: 'read_thread', description: 'Read the relevant thread.'},
        {id: 'run_tests', description: 'Run focused tests.'},
      ]}},
    })), {env: environment, service});
    const advisory = result.hookSpecificOutput?.additionalContext ?? '';
    assert.match(advisory, /status=abstained; confidence=0\.96; reason=insufficient_evidence/);
    assert.doesNotMatch(advisory, /decision=/);
    assert.equal(providerCalls.length, 1);
    const receiptPath = join(environment.PLUGIN_DATA!, 'decision-hook-v1', digest(process.cwd()), digest('session-1'), 'invocations', `${digest('PreToolUse\0session-1\0turn-1\0provider-insufficient-evidence-tool')}.json`);
    const receipt = JSON.parse(await readFile(receiptPath, 'utf8')) as Record<string, unknown>;
    assert.equal(receipt.providerChoice, 'insufficient_evidence');
    assert.equal(receipt.classification, 'unavailable');
    assert.equal(receipt.assessmentStatus, 'abstained');
  });

  it('does not call the provider after a contended context lock consumes the hook budget', async () => {
    const environment = env(join(root, 'context-lock-timeout'));
    await enabledPolicy(environment);
    const sessionId = 'context-lock-session';
    const contextDirectory = join(environment.PLUGIN_DATA!, 'task-context-v1', digest(process.cwd()), digest(sessionId), digest('root'));
    const lockPath = join(contextDirectory, '.context.lock');
    await mkdir(contextDirectory, {recursive: true});
    await writeFile(lockPath, JSON.stringify({pid: process.pid, token: 'context-lock-test', createdAt: new Date().toISOString()}));
    const calls = {count: 0, inputs: [] as DecisionInput[]};
    try {
      const result = await runDecisionHook(JSON.stringify(toolEvent({
        session_id: sessionId, hook_event_name: 'UserPromptSubmit', tool_name: undefined, tool_use_id: undefined,
        turn_id: 'context-lock-turn', prompt: 'update the task context',
      })), {env: environment, service: fakeService(calls), hookTimeoutMs: 30});
      assert.match(result.hookSpecificOutput?.additionalContext ?? '', /status=unavailable; reason=hook_timeout/);
      assert.equal(calls.count, 0);
    } finally {
      await unlink(lockPath).catch(() => {});
    }
  });

  it('preserves structured argument values, task context, and an explicit candidate catalog', async () => {
    const environment = env(join(root, 'structured-context'));
    await enabledPolicy(environment);
    const calls = {count: 0, inputs: [] as DecisionInput[]};
    const service = fakeService(calls);
    await runDecisionHook(JSON.stringify(toolEvent({
      hook_event_name: 'UserPromptSubmit', tool_name: undefined, tool_use_id: undefined, turn_id: 'context-turn',
      prompt: 'Build the adapter and retain TAIL_CONSTRAINT_KEEP_UNLIMITED',
    })), {env: environment, service});
    await runDecisionHook(JSON.stringify(toolEvent({
      tool_use_id: 'catalog-tool', tool_input: {threadId: 'thread-123', turnLimit: 3, nested: {mode: 'review'}},
      task_context: {candidateCatalog: {tool: [
        {id: 'read_thread', description: 'Read the supplied thread.', metadata: {scope: 'current'}},
        {id: 'run_tests', description: 'Run the focused tests.', available: true},
      ]}},
    })), {env: environment, service});
    const input = calls.inputs.at(-1)!;
    assert.deepEqual(input.candidates.map(candidate => candidate.id), ['read_thread', 'run_tests']);
    assert.match(input.context, /thread-123/);
    assert.match(input.context, /"turnLimit":3/);
    assert.match(input.context, /Build the adapter/);
    assert.match(input.context, /TAIL_CONSTRAINT_KEEP_UNLIMITED/);
    assert.match(input.context, /"provided":true/);
    assert.doesNotMatch(input.context, /dummy-key/);
  });

  it('skips pure Jev wrappers while retaining mixed real work for evaluation', async () => {
    const environment = env(join(root, 'mixed-wrapper'));
    await enabledPolicy(environment);
    const calls = {count: 0, inputs: [] as DecisionInput[]};
    const service = fakeService(calls);
    const pure = await runDecisionHook(JSON.stringify(toolEvent({
      tool_name: 'functions.exec', tool_use_id: 'pure-wrapper',
      tool_input: {code: 'await tools.mcp__jev_workflows__classify_decision({domain:"tool"});'},
    })), {env: environment, service});
    assert.deepEqual(pure, {});
    await runDecisionHook(JSON.stringify(toolEvent({
      tool_name: 'functions.exec', tool_use_id: 'mixed-wrapper',
      tool_input: {code: 'await tools.mcp__jev_workflows__classify_decision({domain:"tool"}); await tools.exec_command({cmd:"printf real-work"});'},
    })), {env: environment, service});
    assert.equal(calls.count, 1);
  });

  it('records invocation origin, timestamp, correlation, and candidate digest', async () => {
    const environment = env(join(root, 'receipt-attribution'));
    await enabledPolicy(environment);
    const service: DecisionService = {classifyDecision: async () => ({status: 'abstained', choice: 'reconsider', confidence: 0.2})};
    await runDecisionHook(JSON.stringify(toolEvent({source: 'codex-host', event_id: 'event-receipt'})), {env: environment, service});
    const receiptPath = join(environment.PLUGIN_DATA!, 'decision-hook-v1', digest(process.cwd()), digest('session-1'), 'invocations', `${digest('PreToolUse\0session-1\0event-receipt')}.json`);
    const receipt = JSON.parse(await readFile(receiptPath, 'utf8')) as Record<string, unknown>;
    assert.equal(typeof receipt.timestamp, 'string');
    assert.equal(typeof receipt.correlationId, 'string');
    assert.equal(typeof receipt.candidateDigest, 'string');
    assert.equal((receipt.origin as Record<string, unknown>).source, 'codex-host');
    assert.equal(receipt.providerChoice, 'reconsider');
    assert.equal(receipt.classification, 'unavailable');
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
      'JEV advisory: status=abstained; confidence=0.37; reason=low_confidence; receipt=11111111-1111-1111-1111-111111111111; continue ordinary reasoning and gather authorized evidence if useful.');
  });
});
