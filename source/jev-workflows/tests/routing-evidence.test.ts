import {it} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {resolve, join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {bm25EvidenceScores, createEvidencePacket, inventoryEvidenceFiles, rankEvidencePacket, type EvidenceCard} from '../src/routing/evidence.js';
import {discoverCatalog, shortlistCatalog} from '../src/routing/catalog.js';
import {evaluateProfileProposal} from '../src/routing/profiles.js';
import type {DecisionProposal, HostCapabilities, TaskRevision} from '../src/routing/contracts.js';

const scope = {hostId: 'future-host', accountId: 'account', workspaceId: 'workspace', sessionId: 'session', agentId: 'agent'};
const base = {schemaVersion: 'routing-v1' as const, id: 'id', scope, createdAt: '2026-10-28T00:00:00Z', retention: 'facts' as const};
const card = (id: string, text = ''): EvidenceCard => ({id, text, path: `${id}.ts`, sourceHash: 'source'});

it('retains every discovered page, including a later candidate and inaccessible categories', async () => {
  const seen: Array<string | undefined> = [];
  const snapshot = await discoverCatalog({scope, sourceRevision: 'catalog-v1', readPage: async cursor => {
    seen.push(cursor);
    return {entries: Array.from({length: 20}, (_, i) => ({id: `entry-${cursor ? i + 20 : i}`, description: '', category: 'tool', source: 'host', available: true})), ...(cursor ? {inaccessibleCategories: ['private']} : {nextCursor: 'page-two'})};
  }});
  assert.deepEqual(seen, [undefined, 'page-two']);
  assert.equal(snapshot.entries.length, 40);
  assert.equal(snapshot.coverage.discovery, 'complete_supported_inventory');
  assert.deepEqual(snapshot.coverage.inaccessibleCategories, ['private']);
  assert.equal(Object.isFrozen(snapshot.entries), true);
  const shortlist = shortlistCatalog(snapshot, ['entry-39']);
  assert.equal(shortlist.entries[0]?.id, 'entry-39');
  assert.equal(shortlist.coverage.omittedIds.length, 39);
  await assert.rejects(discoverCatalog({scope, sourceRevision: 'v', readPage: async () => ({entries: [], nextCursor: 'again'})}), /cursor_cycle/);
});

it('BM25 considers the last inventory entry and uses stable UTF-8 ID ties', () => {
  const cards = Array.from({length: 100}, (_, i) => card(`c${i.toString().padStart(3, '0')}`, i === 99 ? 'ownership lock recovery' : 'unrelated'));
  const packet = createEvidencePacket({query: 'ownership lock', cards});
  assert.equal(packet.cards[0]?.id, 'c099');
  assert.equal(packet.coverage.inventoryCount, 100);
  const tied = createEvidencePacket({query: 'absent', cards: [card('z'), card('A'), card('a')]});
  assert.deepEqual(tied.cards.map(item => item.id), ['A', 'a', 'z']);
  const score = bm25EvidenceScores('ownership', [card('a', 'ownership'), card('b', 'elsewhere')]);
  assert.ok(score.get('a')! > score.get('b')!);
});

it('bounds the entire choice input and packet without dropping full inventory coverage', async () => {
  const packet = createEvidencePacket({query: 'needle', cards: Array.from({length: 400}, (_, i) => card(`e${i}`, 'needle '.repeat(130)))});
  assert.ok(packet.bytes <= 16 * 1024);
  assert.ok(Buffer.byteLength(JSON.stringify(packet)) <= 16 * 1024);
  assert.equal(packet.coverage.inventoryCount, 400);
  assert.equal(packet.coverage.includedCount + packet.coverage.omittedCount, 400);
  assert.ok(packet.cards.length < 254);
  await rankEvidencePacket(packet, {arm: 'jev', classify: async input => {
    assert.ok(Buffer.byteLength(JSON.stringify(input)) <= 16 * 1024);
    return {status: 'abstained'};
  }});
  assert.throws(() => createEvidencePacket({query: 'x'.repeat(17000), cards: []}), /query_exceeds_budget/);
  assert.throws(() => createEvidencePacket({query: '', cards: [], maxCandidates: 255}), /packet_limits/);
  assert.throws(() => createEvidencePacket({query: '', cards: [card('same'), card('same')]}), /invalid_evidence/);
  let oversizedCalls = 0;
  const oversized = await rankEvidencePacket({...packet, query: 'oversize'.repeat(10000)}, {arm: 'jev', classify: async () => { oversizedCalls += 1; return {status: 'assessed'}; }});
  assert.equal(oversizedCalls, 0);
  assert.equal(oversized.audit.fallbackReason, 'invalid_packet_limits');
});

it('redacts the frozen cards before either arm can expose credentials', async () => {
  const packet = createEvidencePacket({query: 'Bearer sensitive-query', cards: [card('file', 'api_key = "private-value"\nexplicit-private-value')], secrets: ['explicit-private-value']});
  assert.equal(JSON.stringify(packet).includes('private-value'), false);
  assert.equal(JSON.stringify(packet).includes('sensitive-query'), false);
  const catalog = await discoverCatalog({scope, sourceRevision: 'v', readPage: async () => ({entries: [{id: 'tool', category: 'tool', description: 'Bearer confidential', available: true, source: 'host', metadata: {apiKey: 'private-value', safe: 'public'}}]})});
  assert.equal(JSON.stringify(catalog).includes('confidential'), false);
  assert.deepEqual(catalog.entries[0]?.metadata, {safe: 'public'});
});

it('makes one Jev choice and only moves that same frozen card to the front', async () => {
  const packet = createEvidencePacket({query: 'alpha', cards: [card('a', 'alpha'), card('b', 'beta'), card('c', 'gamma')]});
  let calls = 0;
  const result = await rankEvidencePacket(packet, {arm: 'jev', classify: async input => {
    calls += 1;
    const request = input as {candidates: Array<{id: string}>};
    assert.deepEqual(request.candidates.map(candidate => candidate.id), packet.cards.map(item => item.id));
    return {status: 'assessed', choice: 'c', receiptId: 'receipt', model: 'observed-provider-model'};
  }});
  assert.equal(calls, 1);
  assert.deepEqual(result.packet.cards.map(item => item.id), ['c', 'a', 'b']);
  assert.equal(result.packet.cards[0], packet.cards[2]);
  assert.equal(result.audit.appliedArm, 'jev');
  assert.equal(result.packet.id, packet.id);
  assert.equal(Object.isFrozen(packet.cards), true);
  for (const classify of [async () => ({status: 'abstained', choice: 'insufficient_evidence'}), async () => {throw new Error('provider-down');}, async () => ({status: 'assessed', choice: 'unknown'})]) {
    const fallback = await rankEvidencePacket(packet, {arm: 'jev', classify});
    assert.equal(fallback.packet, packet);
    assert.equal(fallback.audit.appliedArm, 'cheap');
  }
});

it('inventories all tracked UTF-8 text files with stable IDs and no untracked or binary cards', async () => {
  const outputs = resolve('.agent-work');
  await mkdir(outputs, {recursive: true});
  const root = await mkdtemp(join(outputs, 'routing-inventory-'));
  const run = promisify(execFile);
  try {
    await run('git', ['init', root]);
    await writeFile(join(root, 'text.ts'), 'function routeModel() { return "café"; }');
    await writeFile(join(root, 'binary'), Buffer.from([0, 1]));
    await run('git', ['-C', root, 'add', 'text.ts', 'binary']);
    await writeFile(join(root, 'untracked.ts'), 'not candidate');
    const first = await inventoryEvidenceFiles(root);
    assert.equal(first.length, 1);
    assert.equal(first[0]?.path, 'text.ts');
    assert.match(first[0]!.text, /café/);
    assert.deepEqual(await inventoryEvidenceFiles(root), first);
  } finally { await rm(root, {recursive: true, force: true}); }
});

it('preserves settings for unknown capabilities, ties, stale evidence and unsafe downshifts', () => {
  const current = {providerId: 'provider-a', modelId: 'model-x', effort: 'custom'};
  const next = {providerId: 'provider-b', modelId: 'future-model', effort: 'future-effort'};
  const task: TaskRevision = {...base, kind: 'task_revision', revision: 3, factsRevision: 'facts-3', objective: 'task', subtask: 'subtask', sourceRevision: 'source', evidenceRevision: 'evidence', catalogId: 'catalog', observedFailureIds: [], pendingToolCycle: false, completedSubtask: true, unknowns: [], currentProfile: current};
  const capabilities: HostCapabilities = {...base, kind: 'host_capabilities', sourceRevision: 'cap-v1', status: 'known', profileSwitch: 'supported', orderedPreDispatch: true, eligibleProfiles: [current, next], inaccessibleCategories: []};
  const proposal: DecisionProposal = {...base, kind: 'decision_proposal', taskRevision: 3, factsRevision: 'facts-3', catalogId: 'catalog', capabilityRevision: 'cap-v1', recommendedProfile: next, targetIds: [], disposition: 'selected', transition: 'downshift'};
  const evaluate = (overrides: Partial<Parameters<typeof evaluateProfileProposal>[0]> = {}) => evaluateProfileProposal({task, capabilities, proposal, ...overrides});
  assert.equal(evaluate().action, 'apply');
  assert.equal(evaluate({capabilities: {...capabilities, status: 'unknown'}}).reason, 'unsupported_capability');
  assert.equal(evaluate({proposal: {...proposal, disposition: 'tie'}}).action, 'preserve');
  assert.equal(evaluate({proposal: {...proposal, taskRevision: 2}}).reason, 'stale_proposal');
  assert.equal(evaluate({task: {...task, completedSubtask: false}}).reason, 'subtask_in_progress');
  assert.equal(evaluate({task: {...task, pendingToolCycle: true}}).action, 'preserve');
  assert.equal(evaluate({proposal: {...proposal, recommendedProfile: {...next, effort: 'unsupported'}}}).reason, 'ineligible_profile');
  assert.equal(evaluate({previous: {...base, kind: 'apply_result', proposalId: 'previous', factsRevision: 'facts-3', status: 'applied', profile: current, reason: 'acknowledged'}}).reason, 'unchanged_facts');
  assert.equal(evaluate({task: {...task, pin: current}}).reason, 'current_profile');
  assert.equal(evaluate({capabilities: {...capabilities, expiresAt: '2020-01-01T00:00:00Z'}}).reason, 'expired_facts');
  assert.equal(evaluate({capabilities: {...capabilities, createdAt: '2020-01-01T00:00:00Z'}}).reason, 'expired_facts');
});
