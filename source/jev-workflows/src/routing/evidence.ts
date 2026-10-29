import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {open, realpath} from 'node:fs/promises';
import {constants} from 'node:fs';
import {resolve, sep} from 'node:path';
import {redactText} from '../redact.js';

const run = promisify(execFile);
const K1 = 1.2;
const B = 0.75;
const MAX_PACKET_BYTES = 16 * 1024;
const MAX_REAL_CHOICES = 254;
const NONE = 'insufficient_evidence';
export interface EvidenceCard {readonly id: string; readonly path: string; readonly text: string; readonly sourceHash: string}
export interface EvidencePacket {
  readonly id: string;
  readonly query: string;
  readonly cards: readonly EvidenceCard[];
  readonly coverage: Readonly<{inventoryCount: number; includedCount: number; omittedCount: number; inventoryDigest: string}>;
  readonly bytes: number;
}
export interface DecisionAssessment {readonly status: string; readonly choice?: string; readonly recommendation?: string; readonly reasonCode?: string; readonly receiptId?: string; readonly model?: string}
export type ClassifyEvidence = (input: unknown, signal?: AbortSignal) => Promise<DecisionAssessment>;
export interface EvidenceRanking {
  readonly packet: EvidencePacket;
  readonly audit: Readonly<{requestedArm: 'cheap' | 'jev'; appliedArm: 'cheap' | 'jev'; selectedId?: string; fallbackReason?: string; receiptId?: string; providerModel?: string}>;
}

function stableCompare(left: string, right: string): number { return Buffer.compare(Buffer.from(left), Buffer.from(right)); }
function digest(value: string | Uint8Array): string { return createHash('sha256').update(value).digest('hex'); }
function tokens(value: string): string[] { return value.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9_]+/).filter(token => token.length > 1); }

export function bm25EvidenceScores(query: string, cards: readonly EvidenceCard[]): ReadonlyMap<string, number> {
  const terms = [...new Set(tokens(query))];
  const documents = cards.map(card => tokens(`${card.path} ${card.text}`));
  const average = documents.reduce((sum, words) => sum + words.length, 0) / Math.max(documents.length, 1);
  const frequencies = new Map(terms.map(term => [term, documents.filter(words => words.includes(term)).length]));
  return new Map(cards.map((card, index) => {
    const words = documents[index]!;
    const counts = new Map<string, number>();
    for (const word of words) counts.set(word, (counts.get(word) ?? 0) + 1);
    let score = 0;
    for (const term of terms) {
      const count = counts.get(term) ?? 0;
      if (!count) continue;
      const frequency = frequencies.get(term)!;
      const idf = Math.log(1 + (cards.length - frequency + 0.5) / (frequency + 0.5));
      score += idf * count * (K1 + 1) / (count + K1 * (1 - B + B * words.length / Math.max(average, 1)));
    }
    return [card.id, score];
  }));
}

function packetFor(query: string, cards: readonly EvidenceCard[], inventory: readonly EvidenceCard[]): EvidencePacket {
  const content = {query, cards, coverage: {inventoryCount: inventory.length, includedCount: cards.length, omittedCount: inventory.length - cards.length, inventoryDigest: digest(JSON.stringify(inventory))}};
  const id = digest(JSON.stringify(content));
  let bytes = 0;
  for (;;) {
    const packet = {id, ...content, bytes};
    const measured = Math.max(Buffer.byteLength(JSON.stringify(packet)), Buffer.byteLength(JSON.stringify(choiceInput(packet))));
    if (bytes === measured) break;
    bytes = measured;
  }
  return {id, ...content, bytes};
}

function choiceInput(packet: EvidencePacket): unknown {
  return {domain: 'context', question: 'Choose the first evidence target for the current coding objective. Select insufficient_evidence when the supplied cards do not distinguish a target.', context: JSON.stringify({query: packet.query, coverage: packet.coverage, packetId: packet.id}), candidates: packet.cards.map(card => ({id: card.id, description: JSON.stringify({path: card.path, text: card.text, sourceHash: card.sourceHash}), available: true})), policy: {mode: 'ranking'}, mode: 'evaluate'};
}

export function createEvidencePacket(input: {query: string; cards: readonly EvidenceCard[]; maxBytes?: number; maxCandidates?: number; secrets?: string[]}): EvidencePacket {
  const maxBytes = input.maxBytes ?? MAX_PACKET_BYTES;
  const maxCandidates = input.maxCandidates ?? MAX_REAL_CHOICES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_PACKET_BYTES || !Number.isSafeInteger(maxCandidates) || maxCandidates < 1 || maxCandidates > MAX_REAL_CHOICES) throw new Error('invalid_packet_limits');
  const inventory = input.cards.map(card => ({...card, path: redactText(card.path, input.secrets), text: redactText(card.text, input.secrets)}));
  const ids = new Set<string>();
  for (const card of inventory) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,79}$/.test(card.id) || [NONE, '__proto__', 'constructor', 'prototype'].includes(card.id) || ids.has(card.id) || typeof card.path !== 'string' || typeof card.text !== 'string' || typeof card.sourceHash !== 'string' || redactText(card.id, input.secrets) !== card.id || redactText(card.sourceHash, input.secrets) !== card.sourceHash) throw new Error('invalid_evidence_card');
    ids.add(card.id);
  }
  inventory.sort((a, b) => stableCompare(a.id, b.id));
  const query = redactText(input.query, input.secrets);
  const scores = bm25EvidenceScores(query, inventory);
  const ordered = [...inventory].sort((a, b) => scores.get(b.id)! - scores.get(a.id)! || stableCompare(a.id, b.id));
  let packet = packetFor(query, [], inventory);
  if (packet.bytes > maxBytes) throw new Error('packet_query_exceeds_budget');
  const selected: EvidenceCard[] = [];
  for (const card of ordered) {
    if (selected.length === maxCandidates) break;
    if (JSON.stringify({path: card.path, text: card.text, sourceHash: card.sourceHash}).length > 1600) continue;
    const candidate = packetFor(query, [...selected, card], inventory);
    if (candidate.bytes <= maxBytes) { selected.push(card); packet = candidate; }
  }
  return deepFreeze(packet);
}

export async function rankEvidencePacket(packet: EvidencePacket, input: {arm: 'cheap' | 'jev'; classify?: ClassifyEvidence}, signal?: AbortSignal): Promise<EvidenceRanking> {
  const fallback = (fallbackReason?: string): EvidenceRanking => ({packet, audit: {requestedArm: input.arm, appliedArm: 'cheap', ...(fallbackReason ? {fallbackReason} : {})}});
  if (input.arm === 'cheap' || packet.cards.length === 0) return fallback();
  if (!input.classify) return fallback('classifier_unavailable');
  if (packet.cards.length > MAX_REAL_CHOICES || Buffer.byteLength(JSON.stringify(packet)) > MAX_PACKET_BYTES || Buffer.byteLength(JSON.stringify(choiceInput(packet))) > MAX_PACKET_BYTES) return fallback('invalid_packet_limits');
  try {
    signal?.throwIfAborted();
    const result = await input.classify(choiceInput(packet), signal);
    signal?.throwIfAborted();
    const selectedId = result.choice ?? result.recommendation;
    const selected = result.status === 'assessed' ? packet.cards.find(card => card.id === selectedId) : undefined;
    if (!selected) return fallback(result.reasonCode ?? (selectedId === NONE ? 'none_selected' : `jev_${result.status}`));
    const cards = [selected, ...packet.cards.filter(card => card.id !== selected.id)];
    const ordered = {...packet, cards};
    return {packet: deepFreeze(ordered), audit: {requestedArm: input.arm, appliedArm: 'jev', selectedId: selected.id, ...(result.receiptId ? {receiptId: result.receiptId} : {}), ...(result.model ? {providerModel: result.model} : {})}};
  } catch (error) { return fallback(error instanceof Error ? error.message.slice(0, 160) : 'classifier_failed'); }
}

export async function inventoryEvidenceFiles(root: string, input: {secrets?: string[]} = {}): Promise<readonly EvidenceCard[]> {
  const base = await realpath(root);
  const {stdout} = await run('git', ['-C', base, 'ls-files', '-z'], {encoding: 'buffer', maxBuffer: 64 * 1024 * 1024});
  const paths = stdout.toString('utf8').split('\0').filter(Boolean).sort(stableCompare);
  const cards: EvidenceCard[] = [];
  for (const path of paths) {
    const absolute = resolve(base, path);
    if (!absolute.startsWith(`${base}${sep}`)) throw new Error('evidence_path_escape');
    try { if (await realpath(absolute) !== absolute) continue; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    let handle;
    try { handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch (error) { if (['ENOENT', 'ELOOP'].includes((error as NodeJS.ErrnoException).code ?? '')) continue; throw error; }
    try {
      const info = await handle.stat();
      if (!info.isFile()) continue;
      const content = await handle.readFile();
      if (content.includes(0)) continue;
      let text: string;
      try { text = new TextDecoder('utf-8', {fatal: true}).decode(content); } catch { continue; }
      let excerpt = '';
      for (const point of text) { if (Buffer.byteLength(excerpt + point) > 1000) break; excerpt += point; }
      cards.push({id: `file_${digest(path)}`, path: redactText(path, input.secrets), text: redactText(excerpt, input.secrets), sourceHash: digest(content)});
    } finally { await handle.close(); }
  }
  return deepFreeze(cards);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') { Object.freeze(value); for (const child of Object.values(value)) deepFreeze(child); }
  return value;
}
