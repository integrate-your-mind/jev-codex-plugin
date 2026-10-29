import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, readdir, unlink, link } from 'node:fs/promises';
import { join } from 'node:path';
import { acquireStateLock, releaseStateLock } from './state-lock.js';
import { MODEL } from './contracts.js';
import { decisionQuestions, decisionSchema, MAX_DECISION_CANDIDATES, MAX_DECISION_PAYLOAD_BYTES } from './decision.js';
import type { DecisionInput, DecisionAssessment, DecisionService } from './decision-hook.js';

export const CONSULTATION_FACT_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
export const PROVIDER_COOLDOWN_MS = 60_000;
export const CONSULTATION_METADATA_TTL_MS = 90 * 24 * 60 * 60 * 1_000;
export type CandidateCoverage = {
  inventoryCount: number;
  eligibleCount: number;
  comparedCount: number;
  pageCount: number;
  completedPages: number;
  complete: boolean;
  unavailableOutsideCatalog: 'unknown';
  catalogDigest: string;
  method: 'direct' | 'paged_reduction';
  receiptIds?: string[];
  factsProjection?: {complete: boolean; omittedFacts: 0 | 'unknown'};
};

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, canonical(item)]));
  return value;
}

/** Delivery IDs and timestamps do not change the facts being classified. */
export function consultationIdentity(input: DecisionInput, identity: unknown): string {
  let context: Record<string, unknown>;
  try { context = JSON.parse(input.context) as Record<string, unknown>; }
  catch { context = {text: input.context}; }
  const {event: _event, taskContext, ...facts} = context;
  if (taskContext && typeof taskContext === 'object' && !Array.isArray(taskContext)) {
    const {version: _version, updatedAt: _updatedAt, ...taskFacts} = taskContext as Record<string, unknown>;
    facts.taskContext = taskFacts;
  }
  return digest(canonical({domain: input.domain, context: facts, candidates: input.candidates, evidence: input.evidence, identity}));
}

function packetFits(input: DecisionInput): boolean {
  const parsed = decisionSchema.safeParse(input);
  if (!parsed.success) return false;
  const {mode: _mode, ...state} = parsed.data;
  const questions = decisionQuestions(parsed.data);
  return Buffer.byteLength(JSON.stringify({state, questions, model: MODEL})) <= MAX_DECISION_PAYLOAD_BYTES;
}

/** Every page observes the real choice and payload limits. The registry has no count limit. */
export function candidatePages(input: DecisionInput, deadline = Number.POSITIVE_INFINITY): DecisionInput['candidates'][] | undefined {
  const pages: DecisionInput['candidates'][] = [];
  let page: DecisionInput['candidates'] = [];
  for (const candidate of input.candidates.filter(item => item.available !== false)) {
    if (Date.now() >= deadline) return undefined;
    const next = [...page, candidate];
    if (next.length <= MAX_DECISION_CANDIDATES && packetFits({...input, candidates: next})) { page = next; continue; }
    if (!page.length || !packetFits({...input, candidates: [candidate]})) return undefined;
    pages.push(page);
    page = [candidate];
  }
  if (page.length) pages.push(page);
  return pages;
}

/** Paged reduction is advisory. Page-local probabilities are never compared across pages. */
export async function consultCandidateCatalog(input: DecisionInput, service: DecisionService, signal: AbortSignal, deadline = Date.now() + 5_000): Promise<DecisionAssessment> {
  const eligible = input.candidates.filter(candidate => candidate.available !== false);
  const coverage: CandidateCoverage = {
    inventoryCount: input.candidates.length, eligibleCount: eligible.length, comparedCount: 0,
    pageCount: 0, completedPages: 0, complete: false, unavailableOutsideCatalog: 'unknown',
    catalogDigest: digest(canonical(input.candidates)), method: 'direct', receiptIds: [],
  };
  const compared = new Set<string>();
  const unavailable = (reasonCode: string): DecisionAssessment => ({status: 'unavailable', reasonCode, coverage: {...coverage}});
  let remaining = eligible;
  if (!remaining.length) return {...unavailable('insufficient_available_candidates'), status: 'abstained'};
  while (remaining.length) {
    const pages = candidatePages({...input, candidates: remaining}, deadline);
    if (Date.now() >= deadline) return unavailable('hook_timeout');
    if (!pages) return unavailable('comparison_packet_too_large');
    coverage.pageCount += pages.length;
    if (pages.length > 1) coverage.method = 'paged_reduction';
    const winners: DecisionInput['candidates'] = [];
    const winnerResults = new Map<string, DecisionAssessment>();
    let last: DecisionAssessment = {status: 'abstained', reasonCode: 'insufficient_evidence'};
    for (const candidates of pages) {
      if (signal.aborted) return unavailable('cancelled');
      if (Date.now() >= deadline) return unavailable('hook_timeout');
      const result = await service.classifyDecision({...input, candidates}, signal);
      if (signal.aborted) return unavailable('cancelled');
      if (Date.now() >= deadline) return unavailable('hook_timeout');
      if (result.receiptPersisted === true && typeof result.receiptId === 'string' && /^[a-f0-9-]{1,80}$/.test(result.receiptId)) coverage.receiptIds?.push(result.receiptId);
      if (result.status !== 'assessed' && result.status !== 'abstained') return {...result, coverage: {...coverage}};
      coverage.completedPages += 1;
      for (const candidate of candidates) compared.add(candidate.id);
      coverage.comparedCount = compared.size;
      if (result.status === 'assessed') {
        const selected = candidates.find(candidate => candidate.id === result.choice);
        if (!selected) return unavailable('invalid_choice');
        winners.push(selected);
        winnerResults.set(selected.id, result);
      }
      last = result;
    }
    if (pages.length === 1 || winners.length <= 1) {
      coverage.complete = coverage.comparedCount === coverage.eligibleCount;
      return {...(winners.length === 1 ? winnerResults.get(winners[0]!.id)! : last), coverage: {...coverage}};
    }
    if (winners.length >= remaining.length) return unavailable('comparison_packet_too_large');
    remaining = winners;
  }
  return unavailable('insufficient_available_candidates');
}

export type ConsultationClaim = {complete(): Promise<void>; release(): Promise<void>};
export async function claimConsultation(directory: string, semanticId: string, now = Date.now()): Promise<ConsultationClaim | undefined> {
  await mkdir(directory, {recursive: true, mode: 0o700});
  await pruneConsultationMetadata(directory, 'claim', now);
  const path = join(directory, `${semanticId}-${Math.floor(now / CONSULTATION_FACT_TTL_MS)}.complete.json`);
  const lockPath = join(directory, `${semanticId}.lock`);
  let lock;
  try { lock = await acquireStateLock(lockPath, 1); }
  catch (error) { if ((error as Error).message === 'budget_busy') return undefined; throw error; }
  try {
    let completed = false;
    try {
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const info = await handle.stat();
        if (!info.isFile() || info.size > 512) throw new Error('invalid_consultation_marker');
        const marker = JSON.parse(await handle.readFile('utf8')) as {semanticId?: unknown; createdAt?: unknown};
        completed = marker.semanticId === semanticId && typeof marker.createdAt === 'string' && Date.parse(marker.createdAt) > now - CONSULTATION_FACT_TTL_MS;
        if (!completed) throw new Error('invalid_consultation_marker');
      } finally { await handle.close(); }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (completed) { await releaseStateLock(lockPath, lock.handle, lock.token); return undefined; }
  } catch (error) { await releaseStateLock(lockPath, lock.handle, lock.token); throw error; }
  let released = false;
  let completed = false;
  return {
    async complete() {
      if (released) throw new Error('consultation_claim_released');
      if (completed) return;
      const temporary = join(directory, `.consultation-${randomUUID()}.tmp`);
      try {
        const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
        try {
          await handle.writeFile(JSON.stringify({semanticId, createdAt: new Date(now).toISOString()}) + '\n');
          await handle.sync();
        } finally { await handle.close(); }
        await link(temporary, path);
        completed = true;
      } finally { await unlink(temporary).catch(() => {}); }
    },
    async release() {
      if (released) return;
      released = true;
      await releaseStateLock(lockPath, lock.handle, lock.token);
    },
  };
}

const OUTAGE_REASONS = new Set(['timeout', 'hook_timeout', 'provider_unavailable', 'provider_overloaded', 'provider_error', 'rate_limited', 'request_timeout', 'authentication_failed', 'request_forbidden', 'network_policy_blocked']);
export function outageRetryAt(result: DecisionAssessment, now = Date.now()): number | undefined {
  if (result.status !== 'unavailable' || !OUTAGE_REASONS.has(result.reasonCode ?? '')) return undefined;
  const retryAfter = result.transport?.retryAfter;
  const requested = retryAfter && /^\d+$/.test(retryAfter) ? now + Number(retryAfter) * 1_000 : retryAfter ? Date.parse(retryAfter) : 0;
  return Math.max(now + PROVIDER_COOLDOWN_MS, Number.isFinite(requested) ? requested : 0);
}

/** Immutable outage observations avoid shortening another process's Retry-After. */
export async function recordProviderOutage(directory: string, result: DecisionAssessment, now = Date.now()): Promise<void> {
  const retryAt = outageRetryAt(result, now);
  if (retryAt === undefined) return;
  await mkdir(directory, {recursive: true, mode: 0o700});
  const handle = await open(join(directory, `${retryAt}-${randomUUID()}.json`), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(JSON.stringify({retryAt, reason: result.reasonCode}) + '\n'); }
  finally { await handle.close(); }
}

export async function providerCoolingDown(directory: string, now = Date.now()): Promise<boolean> {
  await pruneConsultationMetadata(directory, 'outage', now);
  try { return (await readdir(directory, {withFileTypes: true})).some(entry => entry.isFile() && /^\d+-[a-f0-9-]+\.json$/.test(entry.name) && Number(entry.name.split('-')[0]) > now); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}

export async function observeConsultationRevision(directory: string, semanticId: string, startedAt: number): Promise<void> {
  await mkdir(directory, {recursive: true, mode: 0o700});
  await pruneConsultationMetadata(directory, 'revision', startedAt);
  try {
    const handle = await open(join(directory, `${startedAt}-${semanticId}.json`), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile('{}\n'); } finally { await handle.close(); }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
}

export async function consultationRevisionCurrent(directory: string, semanticId: string, startedAt: number): Promise<boolean> {
  const observations = (await readdir(directory, {withFileTypes: true})).filter(entry => entry.isFile()).map(entry => /^(\d+)-([a-f0-9]{64})\.json$/.exec(entry.name)).filter((match): match is RegExpExecArray => match !== null);
  const latest = observations.reduce((latest, match) => Math.max(latest, Number(match[1])), startedAt);
  const identities = new Set(observations.filter(match => Number(match[1]) === latest).map(match => match[2]));
  return identities.size === 1 && identities.has(semanticId);
}


export async function pruneConsultationMetadata(directory: string, kind: 'claim' | 'revision' | 'outage', now = Date.now()): Promise<void> {
  const patterns = {claim: /^[a-f0-9]{64}-\d+(?:\.complete)?\.json$/, revision: /^\d+-[a-f0-9]{64}\.json$/, outage: /^\d+-[a-f0-9-]+\.json$/};
  let entries;
  try { entries = await readdir(directory, {withFileTypes: true}); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  for (const entry of entries) {
    if (!entry.isFile() || !patterns[kind].test(entry.name)) continue;
    if (kind === 'outage' && Number(entry.name.split('-')[0]) > now) continue;
    const path = join(directory, entry.name);
    try {
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      let expired: boolean;
      try { const info = await handle.stat(); expired = info.isFile() && info.mtimeMs < now - CONSULTATION_METADATA_TTL_MS; }
      finally { await handle.close(); }
      if (expired) await unlink(path);
    } catch {}
  }
}
