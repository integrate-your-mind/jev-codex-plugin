import assert from 'node:assert/strict';
import test from 'node:test';
import {formatRecord} from '../lib/api.mjs';

test('uses the current two-argument signature', () => assert.equal(formatRecord('mode', 'audit'), 'mode=audit'));
