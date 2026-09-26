import assert from 'node:assert/strict';
import test from 'node:test';

import {DEFAULT_BOOTSTRAP_SAMPLES, analyzePairs} from './paired-statistics.mjs';

test('all-ties complete pairs produce p=1 and a documented degenerate bootstrap interval', () => {
  const result = analyzePairs([
    {taskId: 'a', controlPassed: true, treatmentPassed: true},
    {taskId: 'b', controlPassed: false, treatmentPassed: false},
    {taskId: 'c', controlPassed: true, treatmentPassed: true},
  ], {bootstrapSamples: 1_000, bootstrapSeed: 'test-all-ties'});
  assert.equal(result.scheduled, 3);
  assert.equal(result.valid, 3);
  assert.equal(result.missing, 0);
  assert.deepEqual(result.pairOutcomes, {bothPass: 2, controlOnly: 0, treatmentOnly: 0, neither: 1});
  assert.equal(result.mcnemarExact.pValue, 1);
  assert.equal(result.bootstrap95Percentile.lower, 0);
  assert.equal(result.bootstrap95Percentile.upper, 0);
  assert.equal(result.bootstrap95Percentile.allTies, true);
  assert.equal(result.bootstrap95Percentile.degeneracyReason, 'all_bootstrap_statistics_tied');
  assert.match(result.bootstrap95Percentile.interpretation, /not evidence of equivalence or zero uncertainty/);
});

test('asymmetric discordance uses the exact two-sided binomial McNemar p-value', () => {
  const rows = [
    {taskId: 'a', controlPassed: true, treatmentPassed: false},
    {taskId: 'b', controlPassed: true, treatmentPassed: false},
    {taskId: 'c', controlPassed: true, treatmentPassed: false},
    {taskId: 'd', controlPassed: false, treatmentPassed: true},
  ];
  const result = analyzePairs(rows, {bootstrapSamples: 100});
  assert.deepEqual(result.pairOutcomes, {bothPass: 0, controlOnly: 3, treatmentOnly: 1, neither: 0});
  assert.equal(result.mcnemarExact.discordant, 4);
  assert.ok(Math.abs(result.mcnemarExact.pValue - 0.625) < 1e-12);
  assert.equal(result.completePairDifference.treatmentMinusControl, -0.5);
  assert.equal(result.bootstrap95Percentile.samples, 100);
});

test('missing arm outcomes stay separate and yield extreme scheduled-denominator bounds', () => {
  const result = analyzePairs([
    {taskId: 'a', controlPassed: true, treatmentPassed: null},
    {taskId: 'b', controlPassed: false, treatmentPassed: true},
    {taskId: 'c', controlPassed: false, treatmentPassed: false},
    {taskId: 'd', controlPassed: null, treatmentPassed: true},
  ]);
  assert.equal(result.scheduled, 4);
  assert.equal(result.valid, 2);
  assert.equal(result.missing, 2);
  assert.deepEqual(result.operationalPasses.control, {
    passes: 1,
    scheduled: 4,
    known: 3,
    missing: 1,
    passesOverScheduled: 0.25,
    knownPassRate: 1 / 3,
  });
  assert.deepEqual(result.operationalPasses.treatment, {
    passes: 2,
    scheduled: 4,
    known: 3,
    missing: 1,
    passesOverScheduled: 0.5,
    knownPassRate: 2 / 3,
  });
  assert.deepEqual(result.missingnessBounds.treatmentMinusControl, {lower: 0, upper: 0.5});
  assert.equal(result.bootstrap95Percentile.exploratorySmallN, true);
  assert.equal(result.bootstrap95Percentile.smallNSampleThreshold, 30);
  assert.equal(result.bootstrap95Percentile.samples, DEFAULT_BOOTSTRAP_SAMPLES);
});

test('all-missing pairs are not testable and do not receive a zero p-value', () => {
  const result = analyzePairs([
    {taskId: 'a', controlPassed: null, treatmentPassed: null},
    {taskId: 'b', controlPassed: null, treatmentPassed: null},
  ], {bootstrapSamples: 100});
  assert.equal(result.valid, 0);
  assert.equal(result.missing, 2);
  assert.equal(result.mcnemarExact.status, 'not_testable');
  assert.equal(result.mcnemarExact.notTestableReason, 'no_complete_pairs');
  assert.equal(result.mcnemarExact.pValue, null);
  assert.equal(result.bootstrap95Percentile.lower, null);
  assert.equal(result.bootstrap95Percentile.upper, null);
  assert.match(result.bootstrap95Percentile.interpretation, /not estimable/);
});

test('same bootstrap seed and task pairs produce identical percentile bounds', () => {
  const rows = [
    {taskId: 'a', controlPassed: true, treatmentPassed: false},
    {taskId: 'b', controlPassed: false, treatmentPassed: true},
    {taskId: 'c', controlPassed: true, treatmentPassed: true},
    {taskId: 'd', controlPassed: false, treatmentPassed: false},
  ];
  const first = analyzePairs(rows, {bootstrapSamples: 2_000, bootstrapSeed: 'repeatable'});
  const second = analyzePairs(rows, {bootstrapSamples: 2_000, bootstrapSeed: 'repeatable'});
  assert.deepEqual(first.bootstrap95Percentile, second.bootstrap95Percentile);
});

test('invalid inputs reject empty schedules, duplicate tasks, and non-null booleans', () => {
  assert.throws(() => analyzePairs([]), /non-empty array/);
  assert.throws(() => analyzePairs([
    {taskId: 'same', controlPassed: true, treatmentPassed: false},
    {taskId: 'same', controlPassed: false, treatmentPassed: true},
  ]), /duplicate taskId/);
  assert.throws(() => analyzePairs([{taskId: 'bad', controlPassed: 1, treatmentPassed: null}]), /boolean or null/);
  assert.throws(() => analyzePairs([{taskId: 'bad', controlPassed: null, treatmentPassed: null}], {bootstrapSamples: 0}), /positive safe integer/);
});
