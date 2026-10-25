import assert from 'node:assert/strict';
import test from 'node:test';
import {currentApi} from '../lib/api.mjs';

test('uses the renamed API', () => {
  assert.equal(currentApi('fixture'), 'current:fixture');
});
