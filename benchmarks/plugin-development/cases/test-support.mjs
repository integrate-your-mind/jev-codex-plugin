import assert from 'node:assert/strict';
import test from 'node:test';
import {isDeepStrictEqual} from 'node:util';

import {cleanupCase, executeCaseAction, loadCases, prepareCase, verifyPostconditions} from './fixture-engine.mjs';

export function registerCaseTests(caseId) {
  test(`${caseId}: canonical action passes the independent artifact oracle`, async () => {
    const prepared = await prepareCase(caseId);
    try {
      const execution = await executeCaseAction(prepared, prepared.expected.passingAction);
      assert.equal(execution.status, 'completed', JSON.stringify(execution));
      const verification = await verifyPostconditions(prepared);
      assert.equal(verification.pass, true, verification.violations.map(item => item.message).join('; '));
    } finally {
      await cleanupCase(prepared);
    }
  });

  test(`${caseId}: frozen negative controls are sensitive`, async t => {
    const {oracle} = await loadCases();
    const controls = oracle.cases[caseId].negativeControls;
    assert.ok(Array.isArray(controls) && controls.length > 0, 'at least one negative control is required');
    for (const control of controls) {
      await t.test(`${control.action} (${control.classification})`, async () => {
        const prepared = await prepareCase(caseId);
        try {
          const execution = await executeCaseAction(prepared, control.action);
          if (control.expect === 'rejected') {
            assert.equal(execution.status, 'rejected');
            assert.equal(execution.reason, control.requiredRejection);
            assert.deepEqual(execution.after, prepared.before, 'rejected action mutated the workspace');
          } else {
            assert.equal(execution.status, 'completed', JSON.stringify(execution));
            const verification = await verifyPostconditions(prepared);
            assert.equal(verification.pass, false, `${control.action} unexpectedly satisfied the artifact oracle`);
            assert.ok(
              verification.violations.some(item => Object.entries(control.requiredViolation).every(([key, value]) => isDeepStrictEqual(item[key], value))),
              `${control.action} did not trigger ${JSON.stringify(control.requiredViolation)}; got ${JSON.stringify(verification.violations)}`,
            );
          }
        } finally {
          await cleanupCase(prepared);
        }
      });
    }
  });
}
