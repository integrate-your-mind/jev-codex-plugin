import {mkdtemp, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {after, before, describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {loadTaskContext, resetTaskContext, taskContextRecordSchema, updateTaskContext} from '../src/task-context.js';

let root: string;
let cwd: string;

before(async () => {
  root = await mkdtemp(join(process.cwd(), 'work', 'task-context-'));
  cwd = process.cwd();
});

after(async () => {
  await rm(root, {recursive: true, force: true});
});

function environment(): NodeJS.ProcessEnv {
  return {JEV_STATE_DIRECTORY: root, TYPESAFE_API_KEY: 'local-current-secret'};
}

function scope(sessionId: string) {
  return {cwd, sessionId};
}

describe('versioned task context', () => {
  it('retains the root objective while Continue adds bounded follow-up history', async () => {
    const testScope = scope('session-continue');
    const first = await updateTaskContext(testScope, {
      rootObjective: 'Build the context-aware hook.',
      latestStep: 'Inspect the adapter probe.',
      constraints: ['Keep local usage unlimited.'],
      criteria: ['Preserve evidence IDs.'],
      candidateCatalogs: {tool: [
        {id: 'read_thread', description: 'Read the supplied thread.'},
        {id: 'run_tests', description: 'Run focused tests.'},
      ]},
      provenance: {source: 'user_prompt', eventId: 'event-1', turnId: 'turn-1'},
    }, {env: environment(), now: new Date('2026-09-26T12:00:00.000Z')});
    assert.ok(first);
    const continued = await updateTaskContext(testScope, {
      latestStep: 'Continue.',
      followUp: 'Continue.',
      corrections: ['Keep the final answer neutral on abstention.'],
      provenance: {source: 'user_prompt', eventId: 'event-2', turnId: 'turn-2'},
    }, {env: environment(), now: new Date('2026-09-26T12:01:00.000Z')});
    assert.ok(continued);
    assert.equal(continued.rootObjective?.value, 'Build the context-aware hook.');
    assert.equal(continued.latestStep?.value, 'Continue.');
    assert.deepEqual(continued.followUps.map(item => item.value), ['Continue.']);
    assert.equal(continued.corrections[0]?.value, 'Keep the final answer neutral on abstention.');
    assert.deepEqual(continued.candidateCatalogs.tool?.map(candidate => candidate.id), ['read_thread', 'run_tests']);
    assert.equal(continued.provenance.eventId, 'event-2');
    assert.equal(continued.provenance.timestamp, '2026-09-26T12:01:00.000Z');
    assert.equal(taskContextRecordSchema.safeParse(continued).success, true);
  });

  it('replaces and resets explicitly instead of inheriting a parent or prior goal', async () => {
    const testScope = scope('session-replace');
    await updateTaskContext(testScope, {
      rootObjective: 'Old goal',
      constraints: ['Old constraint'],
      provenance: {source: 'user_prompt'},
    }, {env: environment()});
    const replacement = await updateTaskContext(testScope, {
      operation: 'replace',
      rootObjective: 'New goal',
      provenance: {source: 'mcp', eventId: 'replace-1'},
    }, {env: environment()});
    assert.equal(replacement?.rootObjective?.value, 'New goal');
    assert.deepEqual(replacement?.constraints, []);
    assert.equal(replacement?.history.at(-1)?.value, 'Old goal');
    const reset = await resetTaskContext(testScope, {env: environment()});
    assert.equal(reset?.rootObjective, null);
    assert.deepEqual(reset?.followUps, []);
    assert.equal(reset?.provenance.operation, 'reset');
  });

  it('scopes records by agent and redacts bounded values while retaining the tail', async () => {
    const secret = 'SECRET=do-not-store';
    const longTail = `${'a'.repeat(1_700)}TAIL_CONSTRAINT_KEEP`;
    const testScope = scope('session-agent');
    const agent = await updateTaskContext({...testScope, agentId: 'worker-a'}, {
      rootObjective: `${secret} local-current-secret ${longTail}`,
      evidenceRefs: [{id: 'evidence-1', source: 'test', summary: `${secret} local-current-secret`}],
      provenance: {source: 'agent', agentId: 'worker-a'},
    }, {env: environment()});
    const rootContext = await loadTaskContext(testScope, {env: environment()});
    const agentContext = await loadTaskContext({...testScope, agentId: 'worker-a'}, {env: environment()});
    const otherAgent = await loadTaskContext({...testScope, agentId: 'worker-b'}, {env: environment()});
    assert.equal(rootContext, undefined);
    assert.ok(agentContext);
    assert.equal(otherAgent, undefined);
    assert.match(agentContext.rootObjective?.value ?? '', /\[REDACTED\]/);
    assert.doesNotMatch(JSON.stringify(agentContext), /local-current-secret/);
    assert.match(agentContext.rootObjective?.value ?? '', /TAIL_CONSTRAINT_KEEP/);
    assert.doesNotMatch(JSON.stringify(agent), /SECRET=do-not-store/);
  });

  it('clips UTF-8 by code-point boundaries without replacement characters', async () => {
    const testScope = scope('session-unicode');
    const value = `${'é'.repeat(900)}UNICODE_TAIL_KEEP`;
    const record = await updateTaskContext(testScope, {
      rootObjective: value,
      provenance: {source: 'user_prompt'},
    }, {env: environment()});
    assert.ok(record);
    const clipped = record.rootObjective?.value ?? '';
    assert.ok(Buffer.byteLength(clipped) <= 1_500);
    assert.doesNotMatch(clipped, /\uFFFD/);
    assert.match(clipped, /UNICODE_TAIL_KEEP/);
  });

  it('serializes concurrent merges without dropping constraints', async () => {
    const testScope = scope('session-concurrent');
    const updates = await Promise.all(Array.from({length: 8}, (_, index) => updateTaskContext(testScope, {
      constraints: [`constraint-${index}`],
      provenance: {source: 'agent', agentId: `worker-${index}`},
    }, {env: environment()})));
    assert.ok(updates.every(Boolean));
    const saved = await loadTaskContext(testScope, {env: environment()});
    assert.ok(saved);
    assert.deepEqual(new Set(saved.constraints.map(item => item.value)), new Set(Array.from({length: 8}, (_, index) => `constraint-${index}`)));
  });
});
