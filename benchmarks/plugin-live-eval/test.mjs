#!/usr/bin/env node
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm, stat, writeFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const dir = dirname(fileURLToPath(import.meta.url));
const repo = resolve(dir, '../..');
const node = process.execPath;
const run = join(dir, 'run.mjs');
const baseline = join(repo, 'source/jev-workflows');
const repair = process.env.JEV_REPAIRED_SOURCE_ROOT ? resolve(process.env.JEV_REPAIRED_SOURCE_ROOT) : null;

test('dry run imports distinct pinned arms and preserves native context/candidate projection', async (t) => {
  if (!repair) return t.skip('set JEV_REPAIRED_SOURCE_ROOT for the two-source comparison');
  const temp = await mkdtemp(join(tmpdir(), 'jev-live-eval-test-'));
  try {
    const output = join(temp, 'attempts.jsonl');
    const result = spawnSync(node, [run, '--dry-run', '--baseline-source', baseline, '--repair-source', repair, '--workspace', repo, '--out', output], {encoding: 'utf8'});
    assert.equal(result.status, 0, result.stderr);
    const lines = (await readFile(output, 'utf8')).trim().split('\n').map(JSON.parse);
    const header = lines.find(row => row.kind === 'header');
    const started = lines.filter(row => row.kind === 'attempt_started');
    const finished = lines.filter(row => row.kind === 'attempt_finished');
    assert.equal(header.plannedAttempts, 72);
    for (const order of Object.values(header.armOrder)) assert.deepEqual(order.repeat2, [...order.repeat1].reverse(), 'repeat two must reverse the scheduled arm order');
    assert.equal(started.length, 72);
    assert.equal(finished.length, 72);
    assert.equal(new Set(header.sourceRecords.map(row => row.sourceSha256)).size, 2, 'same source must never stand in for both arms');
    const sourceByArm = Object.fromEntries(header.sourceRecords.map(row => [row.arm, row.sourceSha256]));
    for (const row of finished) {
      assert.equal(row.status, 'completed');
      assert.equal(row.sourceSha256, sourceByArm[row.arm]);
      assert.equal(row.projection.rootObjectivePresent, true);
      assert.equal(row.projection.latestStepPresent, true);
      assert.equal(row.projection.candidateIdsMatch, true);
      assert.equal(row.projection.evidencePresent, true);
      assert.equal(row.projection.oracleAbsent, true);
      assert.equal(row.modelVisibleInput.state.candidates.length, 3);
      assert.equal(JSON.stringify(row.modelVisibleInput).includes('expectedChoice'), false);
    }
    const rootObjectives = new Set(finished.map(row => row.modelVisibleInput.state.context.match(/rootObjective[^,}]+/)?.[0]));
    assert.ok(rootObjectives.size > 1, 'episodes must carry case-specific objectives');
    const padded = finished.find(row => row.episodeId === 'distractor-01-truncated');
    assert.match(padded.modelVisibleInput.state.context, /contextTruncated/);
    const baselineQuestion = finished.find(row => row.arm === 'baseline' && row.episodeId === 'tool-01-lint').modelVisibleInput.questions.decision.instructions;
    const repairQuestion = finished.find(row => row.arm === 'repair' && row.episodeId === 'tool-01-lint').modelVisibleInput.questions.decision.instructions;
    assert.notEqual(baselineQuestion, repairQuestion, 'fixture must exercise each actual renderer/source independently');
    const mode = (await stat(output)).mode & 0o777;
    assert.equal(mode, 0o600);
  } finally {
    await rm(temp, {recursive: true, force: true});
  }
});

test('driver refuses to destroy an existing output', async (t) => {
  if (!repair) return t.skip('set JEV_REPAIRED_SOURCE_ROOT for the two-source comparison');
  const temp = await mkdtemp(join(tmpdir(), 'jev-live-eval-exclusive-'));
  try {
    const output = join(temp, 'attempts.jsonl');
    await writeFile(output, '{"sentinel":true}\n');
    const result = spawnSync(node, [run, '--dry-run', '--baseline-source', baseline, '--repair-source', repair, '--workspace', repo, '--out', output], {encoding: 'utf8'});
    assert.notEqual(result.status, 0);
    assert.equal(await readFile(output, 'utf8'), '{"sentinel":true}\n');
  } finally {
    await rm(temp, {recursive: true, force: true});
  }
});
