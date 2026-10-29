import {test} from 'node:test';
import assert from 'node:assert/strict';
import {checkCorpus} from './corpus.mjs';
import {hash} from './pilot.mjs';

const sha = '1'.repeat(40);
const digest = hash('synthetic-corpus-fixture-not-benchmark-evidence');
function fixture() {
  return {catalog: {schemaVersion: 'desktop-pilot-corpus-v1', source: {revision: sha, artifactHash: digest},
    tasks: Array.from({length: 6}, (_, index) => ({id: `synthetic-task-${index}`, repository: `synthetic/repo${index % 2}`,
      baseRevision: String(index + 2).repeat(40), taskType: index % 2 ? 'parser' : 'serialization',
      classification: {kind: 'bug', reviewed: true, evidence: 'Synthetic bug report fixture'},
      issues: [`https://github.com/synthetic/repo${index % 2}/issues/${index + 1}`], problemStatementHash: digest, referencePatchHash: hash(`synthetic-repair-${index}`), testPatchHash: digest}))},
    reservations: {sourceHash: digest, tasks: [{id: 'synthetic-old', repository: 'other/repo', baseRevision: sha, issues: []}]}};
}

test('new real-bug metadata is independently eligible without claiming grader or native acceptance', () => {
  const {catalog, reservations} = fixture();
  const result = checkCorpus(catalog, reservations);
  assert.equal(result.eligibleMetadata, true);
  assert.equal(result.codingReady, false);
  assert.equal(result.tasks, 6);
});

test('reservations collide by repository/base or issue even when task IDs differ', () => {
  for (const collision of ['base', 'issue']) {
    const {catalog, reservations} = fixture();
    reservations.tasks.push({id: 'different-id', repository: catalog.tasks[0].repository,
      baseRevision: collision === 'base' ? catalog.tasks[0].baseRevision : sha,
      issues: collision === 'issue' ? catalog.tasks[0].issues : []});
    assert.throws(() => checkCorpus(catalog, reservations), /Old reservation overlaps/);
  }
});

test('feature requests and incomplete provenance are rejected before runtime preparation', () => {
  for (const mutate of [
    value => { value.tasks[0].classification.kind = 'feature_request'; },
    value => { value.tasks[0].classification.reviewed = false; },
    value => { value.source.revision = 'main'; },
    value => { value.tasks[0].testPatchHash = null; },
    value => { value.tasks[0].issues = []; },
  ]) {
    const {catalog, reservations} = fixture(); mutate(catalog); assert.throws(() => checkCorpus(catalog, reservations));
  }
});

test('one real source bug cannot count twice under different task IDs', () => {
  for (const identity of ['base', 'issue', 'repair']) {
    const {catalog, reservations} = fixture();
    const first = catalog.tasks[0];
    const second = catalog.tasks[2];
    if (identity === 'base') second.baseRevision = first.baseRevision;
    if (identity === 'issue') second.issues = first.issues;
    if (identity === 'repair') second.referencePatchHash = first.referencePatchHash;
    assert.throws(() => checkCorpus(catalog, reservations), /Duplicate source bug/);
  }
});
