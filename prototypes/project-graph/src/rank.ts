import {pinnedJevEvaluator} from './jev.js';
import {expectedRelevance} from './relevance.js';
import {type Arm, type GraphNode, type RankAudit, type RankContext, type RelevanceEvaluator} from './types.js';
export {pinnedJevEvaluator} from './jev.js';
export type {RelevanceEvaluator} from './types.js';

const BM25_K1 = 1.2;
const BM25_B = 0.75;

function tokens(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter(token => token.length > 1);
}

function document(node: GraphNode): string[] {
  return tokens(`${node.path} ${node.name} ${node.signature} ${node.excerpt}`);
}

export function bm25Scores(query: string, nodes: readonly GraphNode[]): Map<string, number> {
  const queryTerms = [...new Set(tokens(query))];
  const documents = nodes.map(document);
  const averageLength = documents.reduce((sum, words) => sum + words.length, 0) / Math.max(documents.length, 1);
  const frequencies = new Map<string, number>();
  for (const term of queryTerms) frequencies.set(term, documents.filter(words => words.includes(term)).length);
  const scores = new Map<string, number>();
  nodes.forEach((node, index) => {
    const words = documents[index]!;
    const counts = new Map<string, number>();
    for (const word of words) counts.set(word, (counts.get(word) ?? 0) + 1);
    let score = 0;
    for (const term of queryTerms) {
      const count = counts.get(term) ?? 0;
      if (!count) continue;
      const docsWithTerm = frequencies.get(term) ?? 0;
      const idf = Math.log(1 + (nodes.length - docsWithTerm + 0.5) / (docsWithTerm + 0.5));
      const normalization = count + BM25_K1 * (1 - BM25_B + BM25_B * words.length / Math.max(averageLength, 1));
      score += idf * count * (BM25_K1 + 1) / normalization;
    }
    scores.set(node.nodeId, score);
  });
  return scores;
}

export function lexicalCandidates(query: string, nodes: readonly GraphNode[], limit: number): GraphNode[] {
  const scores = bm25Scores(query, nodes);
  return [...nodes].sort((a, b) => (scores.get(b.nodeId)! - scores.get(a.nodeId)!) || a.nodeId.localeCompare(b.nodeId)).slice(0, limit);
}

function graphOrder(nodes: readonly GraphNode[]): GraphNode[] {
  return [...nodes].sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'file' ? -1 : 1) || a.nodeId.localeCompare(b.nodeId));
}

function cheapOrder(query: string, nodes: readonly GraphNode[]): GraphNode[] {
  const scores = bm25Scores(query, nodes);
  return [...nodes].sort((a, b) => (scores.get(b.nodeId)! - scores.get(a.nodeId)!) || a.nodeId.localeCompare(b.nodeId));
}

export class Ranker {
  readonly #arm: Arm;
  readonly #evaluate?: RelevanceEvaluator;

  constructor(arm: Arm, evaluate?: RelevanceEvaluator) {
    this.#arm = arm;
    this.#evaluate = evaluate ?? (arm === 'jev' ? pinnedJevEvaluator() : undefined);
  }

  async rank(nodes: readonly GraphNode[], context: RankContext, signal?: AbortSignal): Promise<{nodes: GraphNode[]; audit: RankAudit}> {
    const start = process.hrtime.bigint();
    const cheap = cheapOrder(context.query || context.objective, nodes);
    let ordered = this.#arm === 'graph' ? graphOrder(nodes) : cheap;
    let appliedArm: RankAudit['appliedArm'] = this.#arm === 'graph' ? 'graph' : 'cheap';
    let fallbackReason: string | undefined;
    let providerAttempts: RankAudit['providerAttempts'] = [];
    const providerRankings: RankAudit['providerRankings'] = [];
    if (this.#arm === 'jev' && nodes.length) {
      try {
        const result = await this.#evaluate!({cards: nodes.map(({key: _key, ...card}) => card), context}, signal);
        providerAttempts = result.attempts;
        if (result.status !== 'assessed') throw new Error(result.reasonCode);
        if (Object.keys(result.assessments).length !== nodes.length) throw new Error('incomplete_relevance_answers');
        const scores = new Map(nodes.map(node => [node.nodeId, expectedRelevance(result.assessments[node.nodeId]!)]));
        providerRankings.push({answers: result.assessments});
        ordered = [...nodes].sort((a, b) => scores.get(b.nodeId)! - scores.get(a.nodeId)! || a.nodeId.localeCompare(b.nodeId));
        appliedArm = 'jev';
      } catch (error) {
        fallbackReason = error instanceof Error && /^[a-z0-9_]+$/.test(error.message) ? error.message.slice(0, 160) : 'relevance_evaluator_failure';
        ordered = cheap;
        appliedArm = 'cheap';
      }
    }
    const actualAttempts = providerAttempts.filter(attempt => attempt.actualFetchInvoked);
    const model = [...providerAttempts].reverse().find(attempt => attempt.model)?.model;
    return {nodes: ordered, audit: {
      requestedArm: this.#arm,
      appliedArm,
      ...(fallbackReason ? {fallbackReason} : {}),
      candidateNodeIds: nodes.map(node => node.nodeId),
      orderedNodeIds: ordered.map(node => node.nodeId),
      providerReceiptIds: [...new Set(providerAttempts.flatMap(attempt => attempt.receiptId ? [attempt.receiptId] : []))],
      ...(model ? {providerModel: model} : {}),
      providerUsage: actualAttempts.map(attempt => attempt.usage),
      providerLatencyMs: actualAttempts.flatMap(attempt => attempt.latencyMs === undefined ? [] : [attempt.latencyMs]),
      providerAttempts,
      providerTransports: providerAttempts.flatMap(attempt => attempt.transport ? [{...attempt.transport, fetchInvoked: attempt.actualFetchInvoked}] : []),
      providerRankings,
      durationNs: String(process.hrtime.bigint() - start),
    }};
  }
}
