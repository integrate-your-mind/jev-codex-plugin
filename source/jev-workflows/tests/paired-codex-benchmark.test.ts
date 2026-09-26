import assert from 'node:assert/strict';
import {test} from 'node:test';
// The benchmark runner is deliberately a directly executable .mjs harness.
// @ts-expect-error It does not ship as a typed library module.
import {buildPlan, collectPluginIds, collectRuntimeMcpServerNames, compactUsage, isInfrastructureFailure, parseArgs, summarizeEvents, validateTaskDocument} from '../scripts/paired-codex-benchmark.mjs';

type PlanEntry = {taskId: string; repeat: number; arm: 'baseline' | 'treatment'; armPosition: number};

const verification = {command: '$NODE', args: ['$TASKS_DIR/grade.mjs', 'task-one'], expectedExitCode: 0};

test('paired benchmark requires the live gate, absolute paths, and bounded repeats', () => {
  assert.throws(() => parseArgs(['--tasks', '/tmp/tasks.json', '--output', '/tmp/out']), /--live/);
  assert.throws(() => parseArgs(['--live', '--tasks', 'tasks.json', '--output', '/tmp/out']), /--tasks must be an absolute/);
  assert.throws(() => parseArgs(['--live', '--tasks', '/tmp/tasks.json', '--output', '/tmp/out', '--repeats', '0']), /--repeats/);
  assert.deepEqual(parseArgs(['--live', '--tasks', '/tmp/tasks.json', '--output', '/tmp/out']), {
    live: true,
    preflightOnly: false,
    tasksPath: '/tmp/tasks.json',
    outputPath: '/tmp/out',
    repeats: 1,
    seed: 'paired-codex-v1',
    timeoutMs: 180_000,
  });
  assert.equal(parseArgs(['--live', '--preflight-only', '--tasks', '/tmp/tasks.json', '--output', '/tmp/out']).preflightOnly, true);
});

test('task validation accepts private oracle macros and rejects fixture escapes', () => {
  const valid = validateTaskDocument({
    schemaVersion: 'paired-codex-v1',
    tasks: [{id: 'task-one', prompt: 'Repair the local implementation.', files: {'solution.mjs': 'export {}\n'}, verification}],
  });
  assert.equal(valid.tasks[0].verification.command, '$NODE');
  assert.deepEqual(valid.tasks[0].verification.args, ['$TASKS_DIR/grade.mjs', 'task-one']);

  assert.throws(() => validateTaskDocument({
    schemaVersion: 'paired-codex-v1',
    tasks: [{id: 'task-one', prompt: 'Repair it.', files: {'../oracle.mjs': 'secret'}, verification}],
  }), /Unsafe fixture path/);
  assert.throws(() => validateTaskDocument({schemaVersion: 'paired-codex-v1', tasks: []}), /Task count/);
});

test('seeded plan is deterministic, paired, and counterbalanced', () => {
  const tasks = ['a', 'b', 'c', 'd'].map(id => ({id}));
  const plan = buildPlan(tasks, 2, 'pilot-seed') as PlanEntry[];
  assert.deepEqual(plan, buildPlan(tasks, 2, 'pilot-seed') as PlanEntry[]);
  assert.equal(plan.length, 16);
  assert.equal(plan.filter(entry => entry.arm === 'baseline').length, 8);
  assert.equal(plan.filter(entry => entry.arm === 'treatment').length, 8);
  for (let index = 0; index < plan.length; index += 2) {
    const first = plan[index]!;
    const second = plan[index + 1]!;
    assert.equal(first.taskId, second.taskId);
    assert.equal(first.repeat, second.repeat);
    assert.deepEqual(new Set([first.arm, second.arm]), new Set(['baseline', 'treatment']));
  }
  const firstArms = plan.filter(entry => entry.armPosition === 0).map(entry => entry.arm);
  assert.equal(firstArms.every((arm, index) => index === 0 || arm !== firstArms[index - 1]), true);
});

test('token telemetry keeps known numeric counts and discards secret-like fields', () => {
  assert.deepEqual(compactUsage({
    tokenUsage: {inputTokens: 12, cachedInputTokens: 3, outputTokens: 7, totalTokens: 19, apiKey: 999},
    last: {reasoningOutputTokens: 2, modelContextWindow: 200_000},
    bearerToken: 123,
    userId: 456,
  }), {
    tokenUsage: {inputTokens: 12, cachedInputTokens: 3, outputTokens: 7, totalTokens: 19},
    last: {reasoningOutputTokens: 2, modelContextWindow: 200_000},
  });
});

test('plugin discovery freezes runtime aliases absent from config', () => {
  const ids = collectPluginIds(
    ['creative-production@openai-curated', 'jev-workflows@personal'],
    {marketplaces: [{plugins: [{id: 'installed-extra@local', installed: true, enabled: false}, {id: 'catalog-only@remote', installed: false, enabled: false}]}]},
    [{name: 'creative_production_mcp', pluginId: 'creative-production@openai-curated-remote', runtimeStatus: 'connected'}],
  );
  assert.deepEqual(ids, [
    'creative-production@openai-curated',
    'creative-production@openai-curated-remote',
    'installed-extra@local',
    'jev-workflows@personal',
  ]);
  assert.deepEqual(collectRuntimeMcpServerNames([
    {name: 'creative_production_mcp', pluginId: 'creative-production@openai-curated-remote'},
    {name: 'creative_production_mcp', pluginId: 'creative-production@openai-curated-remote'},
    {name: 'github', runtimeStatus: 'disabled'},
  ]), ['creative_production_mcp']);
});

test('event reduction retains failed command count', () => {
  const summary = summarizeEvents([
    {threadId: 'thread-1', item: {type: 'commandExecution', status: 'failed'}},
    {threadId: 'thread-1', item: {type: 'commandExecution', status: 'completed'}},
    {threadId: 'other', item: {type: 'commandExecution', status: 'failed'}},
  ], 'thread-1');
  assert.equal(summary.failedCommandCount, 1);
  assert.equal(summary.toolCounts.commandExecution, 2);
});

test('startup isolation failures abort remaining trials while turn failures remain scored', () => {
  assert.equal(isInfrastructureFailure({failure: {stage: 'startup_or_preflight'}}), true);
  assert.equal(isInfrastructureFailure({failure: {stage: 'fixture_or_spawn'}}), true);
  assert.equal(isInfrastructureFailure({failure: {stage: 'turn_or_postflight'}}), false);
  assert.equal(isInfrastructureFailure({agentTurnSuccess: true}), false);
});
