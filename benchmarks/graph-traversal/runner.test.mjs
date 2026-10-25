import test, {before, after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, writeFile, readdir, rm, stat} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import * as runner from './runner.mjs';

let root;
before(async () => { root = await mkdtemp(join(tmpdir(), 'jev-graph-runner-review-')); });
after(async () => {
  if (!root) return;
  await rm(root, {recursive: true, force: true});
  await assert.rejects(stat(root), {code: 'ENOENT'});
});
const arms = ['graph', 'cheap', 'jev'];
const hash = character => character.repeat(64);
async function directory() { return mkdtemp(join(root, 'case-')); }
async function json(file, value) {
  await mkdir(join(file, '..'), {recursive: true});
  await writeFile(file, JSON.stringify(value) + '\n', {mode: 0o600});
}
function plan({repetitions = 1, bugs = ['alpha']} = {}) {
  const definitions = bugs.map((id, index) => ({id, promptHash: hash(String(index + 1)), prefixSha: 'a'.repeat(40), fixSha: 'b'.repeat(40)}));
  const schedule = definitions.flatMap(bug => Array.from({length: repetitions}, (_, repetition) => arms.map(arm => ({
    id: `${bug.id}-${repetition}-${arm}`, host: 'codex', bugId: bug.id,
    repetition, arm, model: 'gpt-6-astra', effort: 'high',
    promptHash: bug.promptHash, prefixSha: bug.prefixSha, fixSha: bug.fixSha,
  }))).flat());
  return {schema: 'jev-project-graph-study-v1', phase: 'development', hosts: ['codex'], arms,
    repetitions, timeoutMs: 1000, bugs: definitions, schedule, identity: {runner: hash('c')}};
}
function nativeReceipt(overrides = {}) {
  return {requestedModel: 'gpt-6-astra', resolvedModel: 'gpt-6-astra', requestedEffort: 'high',
    resolvedEffort: 'high', completion: true, cleanupRequired: false,
    cost: {reportedUsd: null, estimatedUsd: null, billedUsd: null}, ...overrides};
}
function graphEvidence(overrides = {}) {
  return {traceEvents: 3, nodeExpansions: 1, nodeReads: 1, jev: {
    accountingKnown: true, fetches: 0, validatedResponses: 0, requestIds: [],
    inputTokensKnownSubtotal: 0, inputUsageKnown: 0, receipts: 0,
    listPriceEstimateKnownUsd: 0, billedUsd: null, ...overrides,
  }};
}
function result(row, overrides = {}) {
  return {...row, phase: 'development', receipt: nativeReceipt(), graph: graphEvidence(),
    grade: {passed: true}, completedFix: true, artifactCorrect: true, hostCompleted: true,
    configurationValid: true, configurationDiagnostics: [], traversalUsed: true,
    totalWallMs: 100, workspaceRemoved: true, cleanupError: null, error: null, ...overrides};
}
async function summaryFixture(options) {
  const output = await directory();
  const frozen = plan(options);
  await json(join(output, 'plan.json'), frozen);
  return {output, frozen, save: (row, overrides) => json(join(output, 'runs', row.id, 'result.json'), result(row, overrides))};
}
function event(type, extra = {}) {
  return {type, atMonotonicNs: '100', durationNs: '10', graphVersion: hash('d'),
    packetHash: hash('e'), nodeIds: ['src/index.ts'], providerReceiptIds: [], ...extra};
}
async function trace(path, events) {
  await mkdir(path, {recursive: true});
  await writeFile(join(path, 'trace.jsonl'), events.map(value => typeof value === 'string' ? value : JSON.stringify(value)).join('\n') + '\n');
}

test('missing graph evidence is unknown contact rather than a clean control', async () => {
  const facts = await runner.graphFacts(await directory());
  assert.equal(facts.jev.accountingKnown, false);
  const classification = runner.classifyTrial(plan().schedule[0], nativeReceipt(), facts);
  assert.equal(classification.configurationValid, false);
});

test('malformed graph evidence cannot certify zero provider contact', async () => {
  const trial = await directory();
  await trace(join(trial, 'graph'), [event('graph_built'), '{"type":"rank"']);
  assert.equal((await runner.graphFacts(trial)).jev.accountingKnown, false);
});

test('valid graph and rank trace can establish a zero-contact control', async () => {
  const trial = await directory();
  await trace(join(trial, 'graph'), [event('graph_built'), event('rank', {requestedArm: 'graph', appliedArm: 'graph'}), event('expand'), event('read')]);
  const facts = await runner.graphFacts(trial);
  assert.equal(facts.jev.accountingKnown, true);
  assert.equal(facts.jev.fetches, 0);
  assert.equal(facts.nodeExpansions, 1);
  assert.equal(facts.nodeReads, 1);
  assert.equal(runner.classifyTrial(plan().schedule[0], nativeReceipt(), facts).configurationValid, true);
});

test('a referenced but missing provider receipt leaves accounting incomplete', async () => {
  const trial = await directory();
  await trace(join(trial, 'graph'), [event('graph_built'), event('rank', {requestedArm: 'jev', appliedArm: 'jev', providerReceiptIds: ['missing-receipt'], providerTransports: []})]);
  assert.equal((await runner.graphFacts(trial)).jev.accountingKnown, false);
});

test('custom adapter evidence paths are consumed and duplicate receipts count once', async () => {
  const trial = await directory(), graphStateDir = join(trial, 'native', 'graph-state'), jevStateDir = join(trial, 'native', 'jev-state');
  const provider = {receiptId: 'receipt-one', transport: {fetchInvoked: true, validatedResponse: true, providerRequestId: 'req_one'}, usage: {input_tokens: 40, output_tokens: null}};
  await trace(graphStateDir, [event('graph_built'), event('rank', {requestedArm: 'jev', appliedArm: 'jev', providerReceiptIds: ['receipt-one'], providerTransports: [provider.transport], providerUsage: [provider.usage]})]);
  await json(join(jevStateDir, 'receipts', 'first.json'), provider);
  await json(join(jevStateDir, 'receipts', 'duplicate.json'), provider);
  const facts = await runner.graphFacts(trial, {graphStateDir, jevStateDir});
  assert.equal(facts.jev.accountingKnown, true);
  assert.equal(facts.jev.fetches, 1);
  assert.deepEqual(facts.jev.requestIds, ['req_one']);
  assert.equal(facts.jev.inputTokensKnownSubtotal, 40);
  assert.equal(facts.jev.inputUsageKnown, 1);
});

test('malformed provider receipts are not silently counted as no contact', async () => {
  const trial = await directory();
  await trace(join(trial, 'graph'), [event('graph_built'), event('rank', {providerReceiptIds: ['broken']})]);
  await mkdir(join(trial, 'jev', 'receipts'), {recursive: true});
  await writeFile(join(trial, 'jev', 'receipts', 'broken.json'), '{');
  assert.equal((await runner.graphFacts(trial)).jev.accountingKnown, false);
});

test('transport-only rank evidence preserves failed-call cost and unknown usage coverage', async () => {
  const trial = await directory();
  await trace(join(trial, 'graph'), [event('graph_built'), event('rank', {
    requestedArm: 'jev', appliedArm: 'cheap', fallbackReason: 'provider_error',
    providerReceiptIds: ['first', 'second'],
    providerTransports: [
      {fetchInvoked: true, validatedResponse: true, providerRequestId: 'req_first'},
      {fetchInvoked: true, validatedResponse: false, providerRequestId: 'req_second'},
    ],
    providerUsage: [{input_tokens: 40, output_tokens: 2}, {input_tokens: null, output_tokens: null}],
  })]);
  const facts = await runner.graphFacts(trial);
  assert.equal(facts.jev.accountingKnown, true);
  assert.equal(facts.jev.fetches, 2);
  assert.equal(facts.jev.validatedResponses, 1);
  assert.equal(facts.jev.inputUsageKnown, 1);
  assert.equal(facts.jev.inputTokensKnownSubtotal, 40);
  assert.equal(facts.jev.billedUsd, null);
  assert.equal(facts.fallbackRanks, 1);
});

test('an explicit pre-contact refusal remains zero fetches without invented token usage', async () => {
  const trial = await directory();
  await trace(join(trial, 'graph'), [event('graph_built'), event('rank', {
    requestedArm: 'jev', appliedArm: 'cheap', fallbackReason: 'local_unavailable',
    providerReceiptIds: ['local-only'], providerTransports: [{fetchInvoked: false}], providerUsage: [],
  })]);
  const facts = await runner.graphFacts(trial);
  assert.equal(facts.jev.accountingKnown, true);
  assert.equal(facts.jev.fetches, 0);
  assert.equal(facts.jev.inputUsageKnown, 0);
  assert.equal(facts.jev.inputTokensKnownSubtotal, null);
  assert.equal(facts.jev.listPriceEstimateKnownUsd, null);
});

for (const [field, value] of [['resolvedModel', null], ['resolvedEffort', null], ['resolvedModel', 'other-model'], ['resolvedEffort', 'low']]) {
  test(`${field}=${value} cannot pass frozen model configuration`, () => {
    assert.equal(runner.classifyTrial(plan().schedule[0], nativeReceipt({[field]: value}), graphEvidence()).configurationValid, false);
  });
}

test('a provider call contaminates both graph-only and cheap controls', () => {
  for (const row of plan().schedule.filter(row => row.arm !== 'jev')) {
    assert.equal(runner.classifyTrial(row, nativeReceipt(), graphEvidence({fetches: 1, requestIds: ['req_unexpected']})).configurationValid, false);
  }
});

test('a same-hash output with changed graph identity or card order is not ranked delivery', async () => {
  for (const changed of [{graphVersion: hash('f')}, {nodeIds: ['second', 'first']}]) {
    const trial = await directory();
    await trace(join(trial, 'graph'), [
      event('graph_built'),
      event('rank', {nodeIds: ['first', 'second'], orderedNodeIds: ['first', 'second'], requestedArm: 'graph'}),
      event('expand', {nodeIds: ['first', 'second'], atMonotonicNs: '200'}),
      event('tool_output', {nodeIds: ['first', 'second'], operation: 'expand', atMonotonicNs: '300', ...changed}),
    ]);
    assert.equal((await runner.graphFacts(trial)).rankedPacketsDelivered, 0);
  }
});

test('delivery and later source read must refer to the same graph node identity', async () => {
  const trial = await directory();
  await trace(join(trial, 'graph'), [
    event('graph_built'),
    event('rank', {nodeIds: ['first'], orderedNodeIds: ['first'], requestedArm: 'graph'}),
    event('expand', {nodeIds: ['first'], atMonotonicNs: '200'}),
    event('tool_output', {nodeIds: ['first'], operation: 'expand', atMonotonicNs: '300'}),
    event('read', {nodeIds: ['first'], graphVersion: hash('f'), atMonotonicNs: '400'}),
  ]);
  const facts = await runner.graphFacts(trial);
  assert.equal(facts.rankedPacketsDelivered, 1);
  assert.equal(facts.subsequentReadsOfDeliveredNodes, 0);
  assert.equal(runner.classifyTrial(plan().schedule[0], nativeReceipt(), facts).traversalUsed, false);
});

test('matching delivered ordering followed by a current node read proves traversal use', async () => {
  const trial = await directory();
  await trace(join(trial, 'graph'), [
    event('graph_built'),
    event('rank', {nodeIds: ['first'], orderedNodeIds: ['first'], requestedArm: 'graph'}),
    event('expand', {nodeIds: ['first'], atMonotonicNs: '200'}),
    event('tool_output', {nodeIds: ['first'], operation: 'expand', atMonotonicNs: '300'}),
    event('read', {nodeIds: ['first'], atMonotonicNs: '400'}),
  ]);
  const facts = await runner.graphFacts(trial);
  assert.equal(facts.rankedPacketsDelivered, 1);
  assert.equal(facts.subsequentReadsOfDeliveredNodes, 1);
  assert.equal(runner.classifyTrial(plan().schedule[0], nativeReceipt(), facts).traversalUsed, true);
});

test('unconfirmed native cleanup retains the workspace and lease', async () => {
  for (const receipt of [{cleanupRequired: true}, {isolation: {cleanupRequired: true}}]) {
    const workspace = await directory();
    await writeFile(join(workspace, 'owned.txt'), 'still owned');
    let released = false;
    const outcome = await runner.cleanupOwnedTrial({receipt, workspace, release: async () => { released = true; }});
    assert.equal(released, false);
    assert.equal(outcome.leaseReleased, false);
    assert.equal(outcome.workspaceRemoved, false);
    assert.ok(outcome.cleanupError);
    assert.equal(await readFile(join(workspace, 'owned.txt'), 'utf8'), 'still owned');
  }
});

test('confirmed cleanup removes only its workspace and releases once', async () => {
  const workspace = await directory(), neighbor = await directory();
  await writeFile(join(neighbor, 'preserve.txt'), 'other owned artifact');
  let releases = 0;
  const outcome = await runner.cleanupOwnedTrial({receipt: nativeReceipt(), workspace, release: async () => { releases++; }});
  assert.equal(outcome.workspaceRemoved, true);
  assert.equal(outcome.leaseReleased, true);
  assert.equal(releases, 1);
  await assert.rejects(stat(workspace), {code: 'ENOENT'});
  assert.equal(await readFile(join(neighbor, 'preserve.txt'), 'utf8'), 'other owned artifact');
});

test('a failed lease release is recorded instead of throwing away trial evidence', async () => {
  const workspace = await directory();
  const outcome = await runner.cleanupOwnedTrial({receipt: nativeReceipt(), workspace, release: async () => { throw Error('lease owner mismatch'); }});
  assert.equal(outcome.leaseReleased, false);
  assert.ok(outcome.cleanupError);
  assert.match(JSON.stringify(outcome.cleanupError), /lease owner mismatch/);
});

test('parallel claims for one trial produce one immutable owner', async () => {
  const trial = await directory(), path = join(trial, 'started.json');
  const contenders = [{owner: 'first'}, {owner: 'second'}];
  const claims = await Promise.all(contenders.map(value => runner.claimTrial(path, value)));
  assert.equal(claims.filter(Boolean).length, 1);
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), contenders[claims.findIndex(Boolean)]);
  const acceptedBytes = await readFile(path);
  assert.equal(await runner.claimTrial(path, {owner: 'later-resume'}), false);
  assert.deepEqual(await readFile(path), acceptedBytes);
  assert.deepEqual(await readdir(trial), ['started.json']);
});

test('the complete three-arm schedule is accepted', () => {
  assert.doesNotThrow(() => runner.validatePlan(plan({repetitions: 2, bugs: ['alpha', 'beta']})));
});

for (const [name, mutate] of [
  ['missing arm', p => p.schedule.pop()],
  ['duplicate id', p => { p.schedule[1].id = p.schedule[0].id; }],
  ['duplicate coordinate', p => { p.schedule[1].arm = p.schedule[0].arm; }],
  ['extra bug coordinate', p => p.schedule.push({...p.schedule[0], id: 'extra', bugId: 'unknown'})],
  ['extra repetition', p => p.schedule.push({...p.schedule[0], id: 'extra', repetition: p.repetitions})],
  ['changed prompt', p => { p.schedule[0].promptHash = hash('f'); }],
  ['changed pre-fix source', p => { p.schedule[0].prefixSha = 'c'.repeat(40); }],
  ['changed fix provenance', p => { p.schedule[0].fixSha = 'c'.repeat(40); }],
]) {
  test(`rejects ${name} in frozen schedule`, () => {
    const frozen = plan(); mutate(frozen);
    assert.throws(() => runner.validatePlan(frozen));
  });
}

test('summary rejects a result with changed fix provenance', async () => {
  const {output, frozen, save} = await summaryFixture();
  await save(frozen.schedule[0], {fixSha: 'c'.repeat(40)});
  await assert.rejects(runner.summarize({out: output}), /identity|provenance|mismatch/i);
});

test('unknown costs stay null and incomplete observations are not complete totals', async () => {
  const {output, frozen, save} = await summaryFixture({repetitions: 2});
  const row = frozen.schedule.find(row => row.arm === 'jev');
  await save(row, {receipt: nativeReceipt({cost: {reportedUsd: 0.25, estimatedUsd: null, billedUsd: null}}), graph: graphEvidence({accountingKnown: false, fetches: null, inputTokensKnownSubtotal: null, inputUsageKnown: 0, receipts: 0, listPriceEstimateKnownUsd: null})});
  const group = (await runner.summarize({out: output})).hosts.codex.jev;
  assert.equal(group.scheduled, 2);
  assert.equal(group.recorded, 1);
  assert.equal(group.missing, 1);
  assert.equal(group.hostReportedCost.totalUsd, null);
  assert.equal(group.hostReportedCost.knownSubtotalUsd, 0.25);
  assert.equal(group.hostReportedCost.coverage, 1);
  assert.equal(group.hostReportedCost.billedUsd, null);
  assert.equal(group.jev.knownInputTokens, null);
  assert.equal(group.jev.knownListPriceEstimateUsd, null);
});

test('failure and missing slots remain in paired bug-weighted completion differences', async () => {
  const {output, frozen, save} = await summaryFixture({repetitions: 2, bugs: ['alpha', 'beta']});
  for (const row of frozen.schedule) {
    if (row.bugId === 'alpha' && row.arm === 'jev') continue;
    if (row.bugId === 'beta' && row.arm === 'cheap') continue;
    const failed = row.bugId === 'alpha' && row.arm === 'graph' && row.repetition === 1;
    await save(row, failed ? {completedFix: false, artifactCorrect: false, hostCompleted: false, error: {message: 'provider failed'}, totalWallMs: 500} : {});
  }
  await writeFile(join(output, 'journal.jsonl'), '{"torn');
  const summary = await runner.summarize({out: output});
  const host = summary.hosts.codex;
  assert.equal(host.graph.scheduled, 4);
  assert.equal(host.graph.recorded, 4);
  assert.equal(host.graph.completedFixes, 3);
  assert.equal(host.graph.wallMs.max, 500);
  assert.equal(host.jev.scheduled, 4);
  assert.equal(host.jev.recorded, 2);
  assert.equal(host.jev.missing, 2);
  assert.equal(host.paired.cheapMinusGraph.completedFixDifference, -0.25);
  assert.equal(host.paired.jevMinusGraph.completedFixDifference, -0.25);
  assert.equal(host.paired.jevMinusCheap.completedFixDifference, 0);
  assert.equal(host.paired.cheapMinusGraph.pairedWallMs.count, 2);
  assert.equal(host.paired.cheapMinusGraph.pairedWallMs.median, -200);
  assert.equal(host.paired.jevMinusCheap.pairedWallMs.count, 0);
  assert.equal(host.paired.jevMinusCheap.pairedWallMs.median, null);
});
