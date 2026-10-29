import {test} from 'node:test';
import assert from 'node:assert/strict';
import {prepareDispositions, renderPreparationSvg} from './preparation.mjs';
import {evidence, fixture} from './test-fixture.mjs';

test('qualified synthetic graders do not consume or score native coding slots', () => {
  const input = fixture();
  input.qualification.host.runtimeIdentity = {status: 'unverified', evidence: ['synthetic-unavailable-runtime']};
  input.qualification.baselineIsolation.instructions = {status: 'unverified', evidence: []};
  const result = prepareDispositions({catalog: input.manifest.corpus, reservations: input.manifest.reservations,
    qualification: input.qualification, preflights: input.preflights, graderHash: evidence});
  assert.equal(result.slots.length, 18);
  assert.equal(result.slots.every(slot => slot.status === 'NOTSTARTED'), true);
  assert.equal(result.codingAttempts, 0);
  assert.equal(result.codingOutcomes, null);
  assert.equal(result.codingReward, null);
  assert.equal(result.manifestFrozen, false);
  assert.equal(result.dependencies.includes('native-baseline-isolation.instructions'), true);
  assert.match(renderPreparationSvg(result, input.preflights), /No coding reward or fix rate was measured/);
});
