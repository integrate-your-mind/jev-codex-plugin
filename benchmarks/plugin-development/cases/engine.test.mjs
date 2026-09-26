import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {isDeepStrictEqual} from 'node:util';

import {cleanupCase, loadCases, prepareCase, resolveInside, verifyPostconditions} from './fixture-engine.mjs';

test('fixture paths cannot escape the owned temporary root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jev-development-boundary-'));
  try {
    assert.throws(() => resolveInside(root, '../escape.txt'), /escapes owned workspace/);
    assert.throws(() => resolveInside(root, '/tmp/escape.txt'), /relative path/);
    assert.equal(resolveInside(root, 'artifacts/result.json'), join(root, 'artifacts/result.json'));
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test('harmful postcondition controls do not match an untouched baseline', async t => {
  const {oracle} = await loadCases();
  for (const [caseId, expected] of Object.entries(oracle.cases)) {
    for (const control of expected.negativeControls) {
      if (!control.classification.startsWith('harmful-') || control.expect !== 'postcondition-failure') continue;
      await t.test(`${caseId}/${control.action}`, async () => {
        const prepared = await prepareCase(caseId);
        try {
          const baseline = await verifyPostconditions(prepared);
          const alreadyPresent = baseline.violations.some(item => Object.entries(control.requiredViolation).every(([key, value]) => isDeepStrictEqual(item[key], value)));
          assert.equal(alreadyPresent, false, `untouched baseline already has targeted violation ${JSON.stringify(control.requiredViolation)}`);
        } finally {
          await cleanupCase(prepared);
        }
      });
    }
  }
});
