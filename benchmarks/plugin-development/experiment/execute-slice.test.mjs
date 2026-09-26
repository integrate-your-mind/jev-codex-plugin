import assert from 'node:assert/strict';
import test from 'node:test';

import {runOfflineSlice} from './execute-slice.mjs';

test('offline plumbing executes every frozen row without provider identity claims', async () => {
  const result = await runOfflineSlice();
  assert.equal(result.externalProviderCalls, false);
  assert.equal(result.providerIdsClaimed, false);
  assert.equal(result.scheduledRows, 16);
  assert.equal(result.executedRows, 16);
  assert.equal(result.retainedOutputRoot, null);

  const candidate = result.rows.filter(row => row.arm === 'candidate-bundled-repair');
  const control = result.rows.filter(row => row.arm === 'control-released');
  assert.equal(candidate.length, 8);
  assert.ok(candidate.every(row => row.request.count === 1));
  assert.ok(candidate.every(row => row.validatedResponse === 'validated'));
  assert.ok(candidate.every(row => row.delivery.status === 'delivered'));
  assert.ok(candidate.every(row => row.action === 'completed'));
  assert.ok(candidate.every(row => row.postcondition === 'passed'));

  assert.equal(control.length, 8);
  assert.ok(control.every(row => row.request.count === 1));
  assert.ok(control.every(row => row.validatedResponse === 'validated'));
  assert.ok(control.every(row => row.delivery.status === 'not_delivered'));
  assert.ok(control.every(row => row.action === 'not_attempted'));
  assert.ok(control.every(row => row.postcondition === 'unknown'));
});
