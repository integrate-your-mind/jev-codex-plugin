import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ARMS, CODING_MS, TOTAL_MS, freezeStudy, hash, plannedSlots, reduceEvent, renderObservedSvg, summarizeStudy} from './pilot.mjs';

import {evidence, fixture, freeze, event, finish} from './test-fixture.mjs';

test('synthetic schedule contains exactly eighteen slots and all six balanced arm orders', () => {
  const state = freeze(fixture());
  assert.equal(state.slots.length, 18);
  assert.equal(new Set(Array.from({length: 6}, (_, index) => state.slots.slice(index * 3, index * 3 + 3).map(slot => slot.arm).join(','))).size, 6);
  for (const arm of ARMS) assert.equal(state.slots.filter(slot => slot.arm === arm).length, 6);
  assert.equal(Object.isFrozen(state.manifest.tasks[0]), true);
  assert.equal(plannedSlots().every(slot => slot.status === 'NOTSTARTED'), true);
});

test('unproved isolation, CLI substitution, old reservations and unhealthy controls cannot freeze', () => {
  for (const mutate of [
    value => { value.qualification.baselineIsolation.instructions = {status: 'unverified', evidence: []}; },
    value => { value.manifest.runtime.host = 'codex-cli'; },
    value => { value.manifest.reservations.tasks.push({id: value.manifest.tasks[0].id}); },
    value => { value.preflights[0].controls.wrong.healthy = false; },
    value => { value.preflights[0].controls.reference.verdict = 'fail'; },
    value => { value.preflights[0].controls.broken.durationMs = 600001; },
    value => { value.manifest.tasks[0].packet.providerOptionLimit = 3; },
    value => { value.manifest.runtime.automaticHooks = true; },
    value => { value.manifest.tasks[0].publicFailureObserved = false; },
  ]) {
    const input = fixture(); mutate(input); assert.throws(() => freeze(input));
  }
});

test('a failed first integration attempt consumes its assigned slot with no retry or replacement', () => {
  let state = freeze(fixture());
  assert.throws(() => reduceEvent(state, event(state, 'start', 0, {slotId: state.slots[1].id})), /balanced arm order/);
  state = reduceEvent(state, event(state, 'start', 0));
  assert.throws(() => reduceEvent(state, event(state, 'start', 1)), /single-use/);
  state = reduceEvent(state, event(state, 'identity', 2, {identityHash: hash(state.manifest.runtime), evidenceHash: evidence}));
  state = reduceEvent(state, event(state, 'coding_ended', 20, {patchHash: evidence, reason: 'failed', evidenceHash: evidence}));
  state = reduceEvent(state, event(state, 'graded', 30, {patchHash: evidence, verdict: 'not-fixed', healthy: true, graderHash: evidence, evidenceHash: evidence}));
  assert.equal(state.slots[0].verdict, 'not-fixed');
  assert.throws(() => reduceEvent(state, event(state, 'start', 31, {slotId: state.slots[0].id})), /single-use/);
  assert.throws(() => reduceEvent(state, event(state, 'start', 31, {slotId: 'replacement-slot'})), /additional attempts/);
});

test('coding and independent grading clocks include all startup and wait time', () => {
  let state = freeze(fixture());
  state = reduceEvent(state, event(state, 'start', 0));
  state = reduceEvent(state, event(state, 'approval', CODING_MS - 1, {evidenceHash: evidence}));
  state = reduceEvent(state, event(state, 'tick', CODING_MS + 1));
  assert.equal(state.halted.reason, 'clock-limit-breached');
  assert.equal(state.slots[0].status, 'INFRASTRUCTURE_INVALID');
  assert.throws(() => reduceEvent(state, event(state, 'start', TOTAL_MS)), /cannot resume/);
  let grading = freeze(fixture());
  grading = reduceEvent(grading, event(grading, 'start', 0));
  grading = reduceEvent(grading, event(grading, 'coding_ended', CODING_MS, {patchHash: evidence, reason: 'timeout', evidenceHash: evidence}));
  grading = reduceEvent(grading, event(grading, 'graded', TOTAL_MS + 1, {patchHash: evidence, verdict: 'verified-fix', healthy: true, evidenceHash: evidence}));
  assert.equal(grading.halted.reason, 'clock-limit-breached');
});

test('terminal patch identity and independent grader health are enforced', () => {
  let state = freeze(fixture()); state = reduceEvent(state, event(state, 'start', 0));
  state = reduceEvent(state, event(state, 'identity', 1, {identityHash: hash(state.manifest.runtime), evidenceHash: evidence}));
  state = reduceEvent(state, event(state, 'coding_ended', 10, {patchHash: evidence, reason: 'completed', evidenceHash: evidence}));
  assert.throws(() => reduceEvent(state, event(state, 'graded', 20, {patchHash: hash('different'), verdict: 'verified-fix', healthy: true, evidenceHash: evidence})), /terminal patch/);
  assert.throws(() => reduceEvent(state, event(state, 'graded', 20, {patchHash: evidence, verdict: 'not-fixed', healthy: false, graderHash: evidence, evidenceHash: evidence})), /infrastructure/);
});

test('packet arms preserve content, cheap order, one choice, and abstention fallback', () => {
  let state = freeze(fixture()); state = reduceEvent(state, event(state, 'start', 0)); state = finish(state, 0);
  state = reduceEvent(state, event(state, 'start', 200));
  state = reduceEvent(state, event(state, 'packet', 201, {contentHash: evidence, order: ['first', 'second', 'third'], decision: 'cheap', choiceAttempts: 0, evidenceHash: evidence}));
  state = finish(state, 200);
  state = reduceEvent(state, event(state, 'start', 400));
  state = reduceEvent(state, event(state, 'packet', 401, {contentHash: evidence, order: ['first', 'second', 'third'], decision: 'abstained', choiceAttempts: 1,
    decisionModelVersion: null, promptHash: evidence, evidenceHash: evidence}));
  state = finish(state, 400, 'not-fixed');
  assert.equal(state.slots[2].packet.decision, 'abstained');
  let broken = freeze(fixture()); broken = reduceEvent(broken, event(broken, 'start', 0)); broken = finish(broken, 0);
  broken = reduceEvent(broken, event(broken, 'start', 200));
  broken = reduceEvent(broken, event(broken, 'packet', 201, {contentHash: hash('changed'), order: ['first', 'second', 'third'], decision: 'cheap', choiceAttempts: 0, evidenceHash: evidence}));
  assert.equal(broken.halted.reason, 'treatment-identity-broke');
  assert.equal(summarizeStudy(broken).byArm['model-alone'].verifiedFixes, null);
});

test('frozen runtime identity changes stop scoring and preserve partial evidence', () => {
  let state = freeze(fixture()); state = reduceEvent(state, event(state, 'start', 0));
  state = reduceEvent(state, event(state, 'identity', 1, {identityHash: hash('different-runtime'), evidenceHash: evidence}));
  assert.equal(state.halted.reason, 'runtime-identity-broke');
  assert.equal(state.events.length, 2);
  assert.equal(state.slots.filter(slot => slot.status === 'NOTSTARTED').length, 17);
});

test('synthetic report uses observed steps, preserves unknown billing, and never rewards zero fixes', () => {
  let state = freeze(fixture());
  const empty = summarizeStudy(state);
  assert.equal(empty.byArm['model-alone'].verifiedFixes, null);
  assert.equal(empty.byArm.cheap.stepCurve, null);
  assert.match(renderObservedSvg(empty), /No eligible observed fix curve/);
  state = reduceEvent(state, event(state, 'start', 0)); state = finish(state, 0);
  const report = summarizeStudy(state);
  assert.deepEqual(report.byArm['model-alone'].stepCurve, [{elapsedMs: 0, fixes: 0}, {elapsedMs: 150, fixes: 1}, {elapsedMs: 150, fixes: 1}]);
  assert.equal(report.byArm['model-alone'].billedUsd, null);
  assert.equal(report.byArm['model-alone'].fullTimePerFixMs, null);
  assert.match(renderObservedSvg(report), / H/);
  let failed = freeze(fixture()); failed = reduceEvent(failed, event(failed, 'start', 0)); failed = finish(failed, 0, 'not-fixed');
  assert.equal(summarizeStudy(failed).byArm['model-alone'].fullTimePerFixMs, null);
});

test('an active ungraded attempt has unknown outcomes and no performance curve', () => {
  let state = freeze(fixture());
  state = reduceEvent(state, event(state, 'start', 0));
  const report = summarizeStudy(state);
  assert.equal(report.byArm['model-alone'].verifiedFixes, null);
  assert.equal(report.byArm['model-alone'].stepCurve, null);
  assert.equal(report.byArm['model-alone'].observedThroughMs, null);
  assert.deepEqual(report.byArm['model-alone'].verifiedFixBounds, {lower: 0, upper: 6});
  assert.match(renderObservedSvg(report), /No eligible observed fix curve/);
});

test('a verified fix during a delivery outage stays in its assigned arm with missing delivery', () => {
  let state = freeze(fixture()); state = reduceEvent(state, event(state, 'start', 0)); state = finish(state, 0);
  state = reduceEvent(state, event(state, 'start', 200));
  state = reduceEvent(state, event(state, 'packet_unavailable', 201, {reason: 'outage', choiceAttempts: 0, evidenceHash: evidence}));
  state = finish(state, 200);
  const report = summarizeStudy(state);
  assert.equal(report.byArm.cheap.verifiedFixes, 1);
  assert.equal(report.byArm.cheap.packetDeliveries, 0);
  assert.equal(report.byArm.cheap.packetMissing, 1);
  assert.equal(report.byArm.cheap.uptake.observed, 0);
});

test('grading rejects an unobserved treatment configuration and a different grader', () => {
  let state = freeze(fixture()); state = reduceEvent(state, event(state, 'start', 0));
  state = reduceEvent(state, event(state, 'coding_ended', 10, {patchHash: evidence, reason: 'completed', evidenceHash: evidence}));
  assert.throws(() => reduceEvent(state, event(state, 'graded', 20, {patchHash: evidence, verdict: 'verified-fix', healthy: true, graderHash: evidence, evidenceHash: evidence})), /treatment configuration/);
  state = reduceEvent(state, event(state, 'identity', 21, {identityHash: hash(state.manifest.runtime), evidenceHash: evidence}));
  assert.throws(() => reduceEvent(state, event(state, 'graded', 22, {patchHash: evidence, verdict: 'verified-fix', healthy: true, graderHash: hash('other-grader'), evidenceHash: evidence})), /frozen independent grader/);
});

test('events cannot smuggle transcripts or replay with a different frozen subject', () => {
  const state = freeze(fixture());
  assert.throws(() => reduceEvent(state, event(state, 'start', 0, {transcript: 'private'})), /private fields/);
  assert.throws(() => reduceEvent(state, event(state, 'start', 0, {manifestHash: hash('other')})), /frozen manifest/);
});

test('the exploratory screen requires all eighteen valid attempts, delivery, uptake and a useful outcome', () => {
  const complete = (counts, addedApproval = false) => {
    let state = freeze(fixture());
    const seen = Object.fromEntries(ARMS.map(arm => [arm, 0]));
    for (let index = 0; index < 18; index += 1) {
      state = reduceEvent(state, event(state, 'start', index * 1000));
      const slot = state.slots[index];
      if (slot.arm !== 'model-alone') {
        state = reduceEvent(state, event(state, 'packet', index * 1000 + 1, {contentHash: evidence, order: ['first', 'second', 'third'],
          decision: slot.arm === 'cheap' ? 'cheap' : 'selected', choiceAttempts: slot.arm === 'cheap' ? 0 : 1,
          ...(slot.arm === 'jev-first' ? {decisionModelVersion: 'synthetic-choice-pinned', promptHash: evidence} : {}), evidenceHash: evidence}));
        state = reduceEvent(state, event(state, 'uptake', index * 1000 + 2, {value: 'observed', evidenceHash: evidence}));
      }
      if (addedApproval && slot.arm === 'jev-first') state = reduceEvent(state, event(state, 'approval', index * 1000 + 3, {evidenceHash: evidence}));
      state = finish(state, index * 1000, seen[slot.arm]++ < counts[slot.arm] ? 'verified-fix' : 'not-fixed');
    }
    return summarizeStudy(state);
  };
  const useful = complete({'model-alone': 4, cheap: 4, 'jev-first': 5});
  assert.equal(useful.exploratoryScreen.passed, true);
  assert.equal(useful.byArm['jev-first'].fullTimePerFixMs, 180);
  assert.equal(complete({'model-alone': 4, cheap: 4, 'jev-first': 5}, true).exploratoryScreen.passed, false);
  assert.equal(complete({'model-alone': 5, cheap: 5, 'jev-first': 5}).exploratoryScreen.passed, false);
  assert.equal(complete({'model-alone': 0, cheap: 0, 'jev-first': 0}).exploratoryScreen.passed, false);
});
