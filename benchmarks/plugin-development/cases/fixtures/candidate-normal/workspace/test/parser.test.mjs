import assert from 'node:assert/strict';
import test from 'node:test';
import {parseRecord} from '../lib/parser.mjs';

test('normalizes a CRLF record', () => {
  assert.deepEqual(parseRecord('mode=audit\r\n'), {key: 'mode', value: 'audit'});
});
