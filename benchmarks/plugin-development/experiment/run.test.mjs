import assert from 'node:assert/strict';
import test from 'node:test';

import {providerInput} from './adapter.mjs';
import {buildReviewPacket} from './run.mjs';

test('review packet binds a runnable 16-row slice without making live claims', async () => {
  const result = await buildReviewPacket();
  assert.equal(result.status, 'ready-for-root-review');
  assert.equal(result.fixtureCheck.status, 'passed');
  assert.equal(result.externalProviderCalls, false);
  assert.equal(result.liveRunInvoked, false);
  assert.equal(result.manifest.review.status, 'unreviewed');
  assert.equal(result.manifest.experiment.scheduledRows, 16);
  assert.equal(result.manifest.providerContract.expectedResponseModelVersion, 'jev-1.13.0');
  assert.equal(result.manifest.providerContract.expectedPluginRuntimeVersion, '0.4.0');
  assert.equal(result.manifest.sourceIdentity.trees['control-released'].files.length, 16);
  assert.equal(result.manifest.sourceIdentity.trees['candidate-bundled-repair'].files.length, 16);
});

test('provider projection is allowlisted and rejects nested truth', () => {
  const input = {
    id: 'x',
    task: 'bounded task',
    state: {facts: ['one']},
    candidates: [{id: 'proceed', available: true, description: 'Proceed.'}],
    question: 'Which?',
    actionPlan: {proceed: {command: 'not provider visible'}},
    outcomePayload: {status: 'not provider visible'},
    surface: 'native_hook',
  };
  assert.deepEqual(providerInput(input), {
    id: 'x',
    task: 'bounded task',
    state: {facts: ['one']},
    candidates: [{id: 'proceed', available: true, description: 'Proceed.'}],
    question: 'Which?',
  });
  assert.throws(() => providerInput({...input, state: {nested: {postconditions: ['secret oracle']}}}), /truth field leaked/);
});
