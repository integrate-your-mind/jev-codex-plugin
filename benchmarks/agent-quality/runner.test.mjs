import test, {after, before} from 'node:test';
import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {mkdtemp, mkdir, readFile, writeFile, rm, stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {run, summarize, validity} from './runner.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const digest = value => createHash('sha256').update(value).digest('hex');
let temporaryRoot;

before(async () => {
  temporaryRoot = await mkdtemp(join(tmpdir(), 'jev-runner-review-'));
});

after(async () => {
  if (!temporaryRoot) return;
  await rm(temporaryRoot, {recursive: true, force: true});
  await assert.rejects(stat(temporaryRoot), {code: 'ENOENT'});
});

async function writeJson(path, value) {
  await mkdir(dirname(path), {recursive: true});
  await writeFile(path, JSON.stringify(value) + '\n', {mode: 0o600});
}

async function fixture({repetitions = 1, scheduled = true} = {}) {
  const output = await mkdtemp(join(temporaryRoot, 'case-'));
  const engine = join(output, 'engines', 'codex');
  await mkdir(engine, {recursive: true});
  const settings = {model: 'gpt-6-astra', effort: 'ultra', pluginRoot: engine};
  const identity = {};
  for (const name of ['SPEC.md', 'corpus.mjs', 'runner.mjs', 'adapters/codex.mjs']) {
    identity[name] = digest(await readFile(join(here, name)));
  }
  const schedule = [];
  if (scheduled) {
    for (let repetition = 0; repetition < repetitions; repetition++) {
      for (const arm of ['off', 'on']) {
        schedule.push({
          id: randomUUID(), host: 'codex', taskId: 'cedar', repetition, arm,
          settings: {...settings}, promptHash: digest('Repair the record parser.'),
          fixtureHash: digest('{"index.js":"export const ready = false;"}'),
        });
      }
    }
  }
  const plan = {
    schemaVersion: 'jev-agent-quality-v1', phase: 'development',
    repetitions, hosts: ['codex'], tasks: ['cedar'], identity,
    pluginIdentity: {codex: {}}, hostConfigurations: {codex: settings},
    schedule, timeoutMs: 1000,
  };
  await writeJson(join(output, 'plan.json'), plan);
  return {output, engine, plan};
}

function receipt(row, overrides = {}) {
  return {
    requestedModel: row.settings.model, resolvedModel: row.settings.model,
    requestedEffort: row.settings.effort, resolvedEffort: row.settings.effort,
    completion: true, wallMs: 9999,
    jev: {
      attempts: row.arm === 'on' ? 1 : 0,
      adviceDeliveries: row.arm === 'on' ? 1 : 0,
      requestIds: row.arm === 'on' ? ['req_fixture_provider_contact'] : [],
    },
    cost: {reportedUsd: null, estimatedUsd: null, billedUsd: null},
    ...overrides,
  };
}

function result(row, overrides = {}) {
  const observed = receipt(row);
  return {
    ...row, phase: 'development', receipt: observed,
    grade: {passed: true}, artifactCorrect: true, hostCompleted: true,
    completedCorrectly: true, validity: validity(row, observed),
    totalWallMs: 25, finishedAt: '2026-10-16T04:00:00.000Z',
    workspaceRemoved: true, cleanupError: null, error: null,
    ...overrides,
  };
}

async function saveResult(output, row, overrides = {}) {
  const value = result(row, overrides);
  await writeJson(join(output, 'trials', row.id, 'result.json'), value);
  return value;
}

test('matching frozen source and empty engine identities perform no trials at max zero', async () => {
  const {output} = await fixture();
  assert.deepEqual(await run({out: output, 'max-trials': '0'}), {executed: 0});
  await assert.rejects(stat(join(output, 'trials')), {code: 'ENOENT'});
});

test('engine drift is rejected before a scheduled adapter can execute', async () => {
  const {output, engine} = await fixture();
  await writeFile(join(engine, 'changed.mjs'), 'export const changed = true;\n');
  await assert.rejects(run({out: output, 'max-trials': '0'}), /Frozen engine bytes changed/);
});

test('source fingerprint drift is rejected without provider execution', async () => {
  const {output, plan} = await fixture();
  plan.identity['runner.mjs'] = '0'.repeat(64);
  await writeJson(join(output, 'plan.json'), plan);
  await assert.rejects(run({out: output, 'max-trials': '0'}), /Frozen source identities changed/);
});

test('per-row results remain authoritative when the journal is absent or torn', async () => {
  const {output, plan} = await fixture();
  for (const row of plan.schedule) await saveResult(output, row);
  const withoutJournal = await summarize({out: output});
  await writeFile(join(output, 'trials.jsonl'), '{"id":"torn');
  const tornJournal = await summarize({out: output});
  assert.deepEqual(tornJournal, withoutJournal);
  assert.equal(tornJournal.hosts.codex.off.artifactPasses, 1);
  assert.equal(tornJournal.hosts.codex.on.artifactPasses, 1);
  assert.equal(tornJournal.hosts.codex.off.wallMs.median, 25);
  assert.equal(tornJournal.paired.codex.allScheduledFinished, true);
});

test('duplicate scheduled IDs are rejected', async () => {
  const {output, plan} = await fixture();
  plan.schedule[1].id = plan.schedule[0].id;
  await writeJson(join(output, 'plan.json'), plan);
  await assert.rejects(summarize({out: output}), /Duplicate scheduled IDs|duplicate/i);
});

test('duplicate task repetition arm coordinates are rejected even with distinct IDs', async () => {
  const {output, plan} = await fixture();
  plan.schedule[1].arm = 'off';
  await writeJson(join(output, 'plan.json'), plan);
  for (const row of plan.schedule) await saveResult(output, row);
  await assert.rejects(summarize({out: output}), /duplicate|pair|schedule/i);
});

test('the frozen schedule cannot silently omit the opposite arm', async () => {
  const {output, plan} = await fixture();
  plan.schedule.pop();
  await writeJson(join(output, 'plan.json'), plan);
  await saveResult(output, plan.schedule[0]);
  await assert.rejects(summarize({out: output}), /pair|schedule|arm/i);
});

test('a result cannot substitute another arm identity', async () => {
  const {output, plan} = await fixture();
  const row = plan.schedule[0];
  await saveResult(output, row, {arm: 'on'});
  await assert.rejects(summarize({out: output}), /identity mismatch/i);
});

test('a result cannot substitute another frozen model configuration', async () => {
  const {output, plan} = await fixture();
  const row = plan.schedule[0];
  await saveResult(output, row, {settings: {...row.settings, model: 'different-model'}});
  await assert.rejects(summarize({out: output}), /configuration mismatch/i);
});

for (const field of ['promptHash', 'fixtureHash']) {
  test(`a result cannot substitute a different frozen ${field}`, async () => {
    const {output, plan} = await fixture();
    const row = plan.schedule[0];
    await saveResult(output, row, {[field]: '0'.repeat(64)});
    await assert.rejects(summarize({out: output}), /hash|identity|input|fingerprint/i);
  });
}

test('all unknown cost observations yield null totals with zero known coverage', async () => {
  const {output, plan} = await fixture();
  for (const row of plan.schedule) await saveResult(output, row);
  const summary = await summarize({out: output});
  for (const arm of ['off', 'on']) {
    const group = summary.hosts.codex[arm];
    assert.equal(group.reportedUsd, null);
    assert.equal(group.estimatedUsd, null);
    assert.equal(group.billedUsd, null);
    assert.equal(group.costCoverage.reported, 0);
    assert.equal(group.costCoverage.estimated, 0);
    assert.equal(group.knownReportedSubtotalUsd, 0);
    assert.equal(group.knownEstimatedSubtotalUsd, 0);
  }
});

test('a known cost subtotal is not a complete total when a scheduled slot is missing', async () => {
  const {output, plan} = await fixture({repetitions: 2});
  const row = plan.schedule[0];
  await saveResult(output, row, {
    receipt: receipt(row, {cost: {reportedUsd: 0.25, estimatedUsd: 0.5, billedUsd: null}}),
  });
  const group = (await summarize({out: output})).hosts.codex.off;
  assert.equal(group.scheduled, 2);
  assert.equal(group.finished, 1);
  assert.equal(group.missing, 1);
  assert.equal(group.reportedUsd, null);
  assert.equal(group.estimatedUsd, null);
  assert.equal(group.knownReportedSubtotalUsd, 0.25);
  assert.equal(group.knownEstimatedSubtotalUsd, 0.5);
  assert.equal(group.costCoverage.reported, 1);
});

test('finished, started-without-result and unstarted slots all retain scheduled denominators', async () => {
  const {output, plan} = await fixture({repetitions: 2});
  await saveResult(output, plan.schedule[0]);
  await writeJson(join(output, 'trials', plan.schedule[1].id, 'started.json'), {
    ...plan.schedule[1], at: '2026-10-16T04:00:00.000Z',
  });
  const summary = await summarize({out: output});
  assert.deepEqual(summary.slotStates.map(row => row.state), [
    'finished', 'started_without_result', 'unstarted', 'unstarted',
  ]);
  assert.equal(summary.hosts.codex.off.scheduled, 2);
  assert.equal(summary.hosts.codex.off.finished, 1);
  assert.equal(summary.hosts.codex.on.scheduled, 2);
  assert.equal(summary.hosts.codex.on.missing, 2);
  assert.equal(summary.paired.codex.allScheduledFinished, false);
  assert.equal(summary.paired.codex.clusters[0].off, 0.5);
  assert.equal(summary.paired.codex.clusters[0].on, 0);
  assert.equal(summary.paired.codex.meanPairedDifference, -0.5);
});

test('a correctly assigned provider failure remains in the operational denominator', async () => {
  const {output, plan} = await fixture();
  const on = plan.schedule[1];
  const failed = receipt(on, {
    completion: false, error: 'provider unavailable',
    jev: {attempts: 0, adviceDeliveries: 0},
  });
  const classification = validity(on, failed);
  assert.equal(classification.valid, true);
  assert.equal(classification.intentionToTreatRetained, true);
  assert.equal(classification.plumbingVerified, false);
  await saveResult(output, on, {
    receipt: failed, validity: classification, artifactCorrect: false,
    grade: {passed: false}, hostCompleted: false, completedCorrectly: false,
    totalWallMs: 1000,
  });
  const group = (await summarize({out: output})).hosts.codex.on;
  assert.equal(group.scheduled, 1);
  assert.equal(group.finished, 1);
  assert.equal(group.artifactPasses, 0);
  assert.equal(group.wallMs.median, 1000);
});

test('arbitrary alias labels cannot bypass the pinned resolved model', async () => {
  const {plan} = await fixture();
  const row = plan.schedule[0];
  assert.equal(validity(row, receipt(row, {
    resolvedModel: 'unrelated-coding-model', modelResolution: 'alias',
  })).valid, false);
});

test('injected control advice is contamination even without a provider request', async () => {
  const {plan} = await fixture();
  const row = plan.schedule[0];
  assert.equal(validity(row, receipt(row, {
    jev: {attempts: 0, adviceDeliveries: 1},
  })).valid, false);
});

test('every supported provider-contact field also detects control contamination', async () => {
  const {plan} = await fixture();
  const row = plan.schedule[0];
  for (const contact of [
    {requestIds: ['req_fixture_provider_contact']},
    {fetchInvoked: 1},
    {providerRequests: 1},
    {providerContacted: true},
  ]) {
    assert.equal(validity(row, receipt(row, {jev: contact})).valid, false, JSON.stringify(contact));
  }
});

test('local hook attempts alone do not prove on-arm provider plumbing', async () => {
  const {plan} = await fixture();
  const row = plan.schedule[1];
  const classification = validity(row, receipt(row, {
    jev: {attempts: 7, adviceDeliveries: 1, requestIds: []},
  }));
  assert.equal(classification.valid, true);
  assert.equal(classification.intentionToTreatRetained, true);
  assert.equal(classification.plumbingVerified, false);
  assert.ok(classification.deliveryDiagnostics.length > 0);
});

test('provider contact without observed advice delivery is not proved on-arm plumbing', async () => {
  const {plan} = await fixture();
  const row = plan.schedule[1];
  const classification = validity(row, receipt(row, {
    jev: {attempts: 1, requestIds: ['req_fixture_provider_contact']},
  }));
  assert.equal(classification.valid, true);
  assert.equal(classification.plumbingVerified, false);
});

test('completed on-arm plumbing requires actual provider identity and delivered advice evidence', async () => {
  const {plan} = await fixture();
  const row = plan.schedule[1];
  const classification = validity(row, receipt(row));
  assert.equal(classification.valid, true);
  assert.equal(classification.plumbingVerified, true);
  assert.deepEqual(classification.deliveryDiagnostics, []);
});
