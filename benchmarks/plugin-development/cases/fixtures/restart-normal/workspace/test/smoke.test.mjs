import assert from 'node:assert/strict';
import test from 'node:test';
import {fixtureStatus} from '../lib/smoke.mjs';

test('current local smoke state is ready', () => assert.equal(fixtureStatus, 'ready'));
