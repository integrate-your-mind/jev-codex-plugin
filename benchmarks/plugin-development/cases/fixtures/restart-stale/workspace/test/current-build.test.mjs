import assert from 'node:assert/strict';
import test from 'node:test';
import {buildRevision} from '../lib/current-build.mjs';

test('build source is the current revision', () => assert.equal(buildRevision, 'rev-18'));
