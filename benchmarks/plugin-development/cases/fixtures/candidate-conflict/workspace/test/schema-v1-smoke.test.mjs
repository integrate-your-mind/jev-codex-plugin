import assert from 'node:assert/strict';
import test from 'node:test';

test('stale schema-v1 fixture still passes but says nothing about v2', () => {
  assert.deepEqual(JSON.parse('{"schema":1,"record":{"id":7}}'), {schema: 1, record: {id: 7}});
});
