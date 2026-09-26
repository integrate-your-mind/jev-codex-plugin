import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {after, before, test} from 'node:test';

import {buildFreezeManifest} from './freeze.mjs';
import {requireReviewedManifest} from './live-gate.mjs';

let root;
let proposal;

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'jev-live-gate-test-'));
  proposal = await buildFreezeManifest();
});

after(async () => {
  await rm(root, {recursive: true, force: true});
});

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function reviewedManifest(name, mutate = () => {}) {
  const value = structuredClone(proposal);
  value.review = {status: 'reviewed', reviewedBy: 'offline-test-reviewer', reviewedAt: '2026-09-26T12:00:00.000Z'};
  mutate(value);
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  const path = join(root, `${name}.json`);
  await writeFile(path, bytes, {mode: 0o600});
  return {path, sha256: sha256(bytes)};
}

const enabledEnv = {JEV_RUN_LIVE_EXPERIMENT: '1', TYPESAFE_API_KEY: 'test-only-gate-credential'};

test('live mode stays disabled before explicit review activation', async () => {
  await assert.rejects(() => requireReviewedManifest({env: {}, processVersion: 'v22.23.2'}), /live mode disabled/);
});

test('exact reviewed manifest verifies without making a provider request', async () => {
  const reviewed = await reviewedManifest('valid');
  const result = await requireReviewedManifest({
    manifestPath: reviewed.path,
    reviewedSha256: reviewed.sha256,
    env: enabledEnv,
    processVersion: 'v22.23.2',
  });
  assert.equal(result.manifest.review.status, 'reviewed');
  assert.equal(result.manifestSha256, reviewed.sha256);
  assert.equal(result.schedule.attempts.length, 16);
});

for (const [name, mutate, pattern] of [
  ['source', manifest => { manifest.sourceIdentity.trees['control-released'].files[0].sha256 = '0'.repeat(64); }, /source/],
  ['input', manifest => { manifest.files.inputs[0].sha256 = '1'.repeat(64); }, /input-or-schedule/],
  ['schedule', manifest => { manifest.files.inputs.find(file => file.path.endsWith('schedule.json')).sha256 = '2'.repeat(64); }, /input-or-schedule/],
  ['runner', manifest => { manifest.files.runner[0].sha256 = '3'.repeat(64); }, /runner/],
  ['fixture', manifest => { manifest.fixtureTrees[0].sha256 = '4'.repeat(64); }, /fixture/],
]) {
  test(`${name} drift is rejected even when the altered manifest SHA is supplied`, async () => {
    const reviewed = await reviewedManifest(`drift-${name}`, mutate);
    await assert.rejects(() => requireReviewedManifest({
      manifestPath: reviewed.path,
      reviewedSha256: reviewed.sha256,
      env: enabledEnv,
      processVersion: 'v22.23.2',
    }), pattern);
  });
}

test('a reviewed manifest cannot be swapped after its digest is approved', async () => {
  const reviewed = await reviewedManifest('sha-swap');
  await assert.rejects(() => requireReviewedManifest({
    manifestPath: reviewed.path,
    reviewedSha256: 'f'.repeat(64),
    env: enabledEnv,
    processVersion: 'v22.23.2',
  }), /SHA-256 mismatch/);
});
