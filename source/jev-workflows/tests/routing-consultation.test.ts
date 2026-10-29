import { mkdir, mkdtemp, rm, writeFile, utimes, access, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { candidatePages, consultCandidateCatalog, consultationIdentity, claimConsultation, CONSULTATION_FACT_TTL_MS, providerCoolingDown, recordProviderOutage, observeConsultationRevision, consultationRevisionCurrent, outageRetryAt, pruneConsultationMetadata, CONSULTATION_METADATA_TTL_MS } from '../src/routing-consultation.js';
import type { DecisionInput, DecisionAssessment } from '../src/decision-hook.js';

let root: string;
before(async () => {
  await mkdir(join(process.cwd(), 'work'), {recursive: true});
  root = await mkdtemp(join(process.cwd(), 'work', 'routing-consultation-'));
});
after(async () => { if (root) await rm(root, {recursive: true, force: true}); });

function input(count = 2): DecisionInput {
  return {
    domain: 'tool', question: 'Select the best supported tool.', context: JSON.stringify({arguments: {query: 'build'}, taskContext: {rootObjective: 'Repair the build', latestStep: 'Read the error', version: 1, updatedAt: 'before'}}),
    candidates: Array.from({length: count}, (_, index) => ({id: `tool-${index}`, description: `Available tool ${index}`})),
    evidence: [{id: 'build-error', text: 'Missing export', source: 'public-test'}], mode: 'evaluate',
  };
}

function transport(retryAfter: string): DecisionAssessment['transport'] {
  return {requestStartedAt: '2026-10-28T00:00:00.000Z', fetchInvoked: true, responseReceivedAt: '2026-10-28T00:00:00.000Z', responseStatus: 429, validatedResponse: false, providerRequestId: null, providerRequestIdHeader: null, retryAfter, credentialFingerprint: 'test'};
}

describe('complete candidate consultation', () => {
  it('visits every eligible candidate past 12, 50 and 254, then compares page winners', async () => {
    const request = input(600);
    request.candidates[19]!.available = false;
    const seen: string[][] = [];
    const result = await consultCandidateCatalog(request, {async classifyDecision(packet) {
      seen.push(packet.candidates.map(candidate => candidate.id));
      return {status: 'assessed', choice: packet.candidates.at(-1)!.id, confidence: 0.9, receiptPersisted: true, receiptId: `00000000-0000-0000-0000-${String(seen.length).padStart(12, '0')}`};
    }}, new AbortController().signal);
    assert.equal(result.choice, 'tool-599');
    assert.equal(result.coverage?.inventoryCount, 600);
    assert.equal(result.coverage?.eligibleCount, 599);
    assert.equal(result.coverage?.comparedCount, 599);
    assert.equal(result.coverage?.complete, true);
    assert.equal(result.coverage?.method, 'paged_reduction');
    assert.equal(result.coverage?.unavailableOutsideCatalog, 'unknown');
    assert.equal(seen.every(page => page.length <= 254), true);
    assert.equal(new Set(seen.flat()).size, 599);
    assert.equal(seen.flat().includes('tool-19'), false);
    assert.equal(seen.length, 4);
    assert.equal(result.coverage?.receiptIds?.length, 4);
    assert.equal(new Set(result.coverage?.receiptIds).size, 4);
  });

  it('pages on payload bytes and never drops an oversized candidate silently', () => {
    const request = input(50);
    for (const candidate of request.candidates) candidate.description = 'x'.repeat(1_600);
    const pages = candidatePages(request)!;
    assert.ok(pages.length > 1);
    assert.equal(pages.flat().length, 50);
    assert.ok(pages.every(page => page.length < 254));
    assert.equal(candidatePages({...request, context: 'x'.repeat(60_000)}), undefined);
  });

  it('checks the shared deadline before dispatch even if the timer callback has not fired', async () => {
    let calls = 0;
    const result = await consultCandidateCatalog(input(), {async classifyDecision() { calls++; return {status: 'assessed', choice: 'tool-0'}; }}, new AbortController().signal, Date.now() - 1);
    assert.equal(result.reasonCode, 'hook_timeout');
    assert.equal(result.coverage?.complete, false);
    assert.equal(calls, 0);
  });

  it('preserves none when every page abstains', async () => {
    const result = await consultCandidateCatalog(input(600), {async classifyDecision() {
      return {status: 'abstained', choice: 'insufficient_evidence', reasonCode: 'insufficient_evidence'};
    }}, new AbortController().signal);
    assert.equal(result.status, 'abstained');
    assert.equal(result.choice, 'insufficient_evidence');
    assert.equal(result.coverage?.comparedCount, 600);
    assert.equal(result.coverage?.complete, true);
  });

  it('returns incomplete neutral failure if a later page fails', async () => {
    let calls = 0;
    const result = await consultCandidateCatalog(input(600), {async classifyDecision(packet) {
      calls++;
      return calls === 1 ? {status: 'assessed', choice: packet.candidates[0]!.id} : {status: 'unavailable', reasonCode: 'provider_overloaded'};
    }}, new AbortController().signal);
    assert.equal(result.status, 'unavailable');
    assert.equal(result.choice, undefined);
    assert.equal(result.coverage?.complete, false);
    assert.equal(calls, 2);
  });

  it('discards a late result after cancellation without dispatching another page', async () => {
    const controller = new AbortController();
    let calls = 0;
    const result = await consultCandidateCatalog(input(600), {async classifyDecision(packet) {
      calls++;
      controller.abort();
      return {status: 'assessed', choice: packet.candidates[0]!.id};
    }}, controller.signal);
    assert.equal(result.status, 'unavailable');
    assert.equal(result.reasonCode, 'cancelled');
    assert.equal(result.coverage?.complete, false);
    assert.equal(calls, 1);
  });
});

describe('semantic consultation state', () => {
  it('prunes only expired owned metadata and preserves unknown files and active Retry-After', async () => {
    const directory = join(root, 'retention');
    await mkdir(directory);
    const now = Date.now();
    const expired = new Date(now - CONSULTATION_METADATA_TTL_MS - 1_000);
    const old = join(directory, `${'a'.repeat(64)}-1.json`);
    const unknown = join(directory, 'retained-evidence.json');
    const target = join(directory, 'target.json');
    const link = join(directory, `${'b'.repeat(64)}-1.json`);
    const activeRetry = join(directory, `${now + 120_000}-aaaaaaaa.json`);
    for (const path of [old, unknown, target, activeRetry]) { await writeFile(path, '{}'); await utimes(path, expired, expired); }
    await symlink(target, link);
    await pruneConsultationMetadata(directory, 'claim', now);
    await assert.rejects(access(old));
    await access(unknown);
    await access(link);
    await pruneConsultationMetadata(directory, 'outage', now);
    await access(activeRetry);
  });

  it('ignores delivery timestamps but invalidates objective, evidence, sources, catalog and pins', () => {
    const original = input();
    const identity = {provider: 'one', pin: 'current', sources: {repo: 'a'}};
    const unchanged = {...original, context: JSON.stringify({...JSON.parse(original.context), event: 'PreToolUse', taskContext: {...JSON.parse(original.context).taskContext, updatedAt: 'later', version: 2}})};
    assert.equal(consultationIdentity(original, identity), consultationIdentity(unchanged, identity));
    assert.notEqual(consultationIdentity(original, identity), consultationIdentity({...original, evidence: [{id: 'build-error', text: 'Different error'}]}, identity));
    assert.notEqual(consultationIdentity(original, identity), consultationIdentity({...original, context: JSON.stringify({taskContext: {rootObjective: 'Other objective'}})}, identity));
    assert.notEqual(consultationIdentity(original, identity), consultationIdentity(input(3), identity));
    assert.notEqual(consultationIdentity(original, identity), consultationIdentity(original, {...identity, pin: 'changed'}));
    assert.notEqual(consultationIdentity(original, identity), consultationIdentity(original, {...identity, sources: {repo: 'b'}}));
    assert.notEqual(consultationIdentity(original, identity), consultationIdentity(original, {...identity, provider: 'two'}));
  });

  it('recovers an interrupted consultation instead of retaining a seven-day success marker', async () => {
    const directory = join(root, 'crashed-claim');
    await mkdir(directory);
    const semanticId = 'c'.repeat(64);
    await writeFile(join(directory, `${semanticId}-${Math.floor(Date.now() / CONSULTATION_FACT_TTL_MS)}.json`), JSON.stringify({semanticId, createdAt: new Date().toISOString()}));
    const lock = join(directory, `${semanticId}.lock`);
    await mkdir(lock);
    await writeFile(join(lock, 'owner-00000000-0000-0000-0000-000000000000.json'), JSON.stringify({pid: 2147483647, token: '00000000-0000-0000-0000-000000000000', createdAt: new Date(Date.now() - 60_000).toISOString()}));
    const old = new Date(Date.now() - 60_000);
    await utimes(lock, old, old);
    const interrupted = await claimConsultation(directory, semanticId);
    if (interrupted) await interrupted.release();
    const recovered = await claimConsultation(directory, semanticId);
    assert.ok(recovered);
    await recovered.release();
    const final = await claimConsultation(directory, semanticId);
    assert.ok(final);
    await final.release();
  });

  it('suppresses concurrent duplicates and allows expired facts or a failed claim to retry', async () => {
    const directory = join(root, 'claims');
    const now = CONSULTATION_FACT_TTL_MS * 100;
    const claims = await Promise.all(Array.from({length: 5}, () => claimConsultation(directory, 'abc', now)));
    assert.equal(claims.filter(Boolean).length, 1);
    await claims.find(Boolean)!.release();
    const retried = await claimConsultation(directory, 'abc', now);
    assert.ok(retried);
    await retried.complete();
    await retried.release();
    assert.equal(await claimConsultation(directory, 'abc', now + 1), undefined);
    const fresh = await claimConsultation(directory, 'abc', now + CONSULTATION_FACT_TTL_MS);
    assert.ok(fresh);
    await fresh.release();
  });

  it('rejects old results when a newer revision or ambiguous same-time revision arrives', async () => {
    const directory = join(root, 'revisions');
    const a = consultationIdentity(input(), 'a');
    const b = consultationIdentity(input(), 'b');
    await observeConsultationRevision(directory, a, 100);
    assert.equal(await consultationRevisionCurrent(directory, a, 100), true);
    await observeConsultationRevision(directory, b, 101);
    await observeConsultationRevision(directory, a, 99);
    assert.equal(await consultationRevisionCurrent(directory, a, 100), false);
    assert.equal(await consultationRevisionCurrent(directory, b, 101), true);
    await observeConsultationRevision(directory, a, 101);
    assert.equal(await consultationRevisionCurrent(directory, b, 101), false);
  });

  it('persists provider cooldown across callers and respects Retry-After without shortening it', async () => {
    const directory = join(root, 'cooldown');
    const now = Date.parse('2026-10-28T00:00:00Z');
    assert.equal(await providerCoolingDown(directory, now), false);
    const outage: DecisionAssessment = {status: 'unavailable', reasonCode: 'rate_limited', transport: transport('120')};
    assert.equal(outageRetryAt(outage, now), now + 120_000);
    assert.equal(outageRetryAt({...outage, transport: transport('Wed, 28 Oct 2026 00:03:00 GMT')}, now), now + 180_000);
    await recordProviderOutage(directory, outage, now);
    await recordProviderOutage(directory, {...outage, transport: transport('1')}, now);
    assert.equal(await providerCoolingDown(directory, now + 90_000), true);
    assert.equal(await providerCoolingDown(directory, now + 120_001), false);
    assert.equal(outageRetryAt({status: 'abstained', reasonCode: 'low_confidence'}, now), undefined);
    assert.equal(outageRetryAt({status: 'unavailable', reasonCode: 'cancelled'}, now), undefined);
  });
});
