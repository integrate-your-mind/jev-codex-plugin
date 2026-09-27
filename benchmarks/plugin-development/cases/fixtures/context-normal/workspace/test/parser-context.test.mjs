import assert from 'node:assert/strict';
import test from 'node:test';
import {parseRecord} from '../lib/parser.mjs';

test('implements the current vertical-bar delimiter', () => assert.deepEqual(parseRecord('a|b'), ['a', 'b']));
