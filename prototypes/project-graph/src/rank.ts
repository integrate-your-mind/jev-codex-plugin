import {createService} from '../../../source/jev-workflows/src/service.js';
import {sanitize} from '../../../source/jev-workflows/src/redact.js';
import type {Arm, GraphNode, JevAssessment, NodeCard, RankAudit, RankContext} from './types.js';

const BM25_K1 = 1.2;
const BM25_B = 0.75;
const MAX_BATCH = 16;
const RELEVANCE_LEVELS = ['relevance_0', 'relevance_1', 'relevance_2', 'relevance_3', 'relevance_4'] as const;

export type EvaluateDecisions = (input: unknown, signal?: AbortSignal) => Promise<JevAssessment>;

export function pinnedJevEvaluator(env: NodeJS.ProcessEnv = process.env): EvaluateDecisions {
  const service = createService({env: {
    JEV_ENABLED: '1',
    JEV_MODEL: 'jev-1.13.0',
    JEV_STATE_DIRECTORY: env.JEV_STATE_DIRECTORY,
    JEV_API_KEY_FILE: env.JEV_API_KEY_FILE,
  }});
  return service.evaluateDecisions;
}

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

function compactCard(node: GraphNode): NodeCard {
  const {key: _key, ...card} = node;
  return card;
}

function jevInput(nodes: readonly GraphNode[], context: RankContext, offset: number): unknown {
  const questions = Object.fromEntries(nodes.map((node, index) => {
    const questionId = `node_${String(offset + index).padStart(3, '0')}`;
    return [questionId, {
      type: 'choice',
      domain: 'context',
      policy: {mode: 'ranking'},
      instructions: {
        task: 'Choose the ordinal relevance level for this code node against the stated coding objective and current traversal query.',
        nodeId: node.nodeId,
      },
      candidates: [
        {id: 'relevance_0', description: 'Unrelated to the objective and current query.', available: true},
        {id: 'relevance_1', description: 'Weakly related context.', available: true},
        {id: 'relevance_2', description: 'Plausibly useful supporting context.', available: true},
        {id: 'relevance_3', description: 'Directly useful to localize or repair the objective.', available: true},
        {id: 'relevance_4', description: 'Essential to the next repair step.', available: true},
      ],
    }];
  }));
  return {
    state: {
      objective: context.objective,
      query: context.query,
      operation: context.operation,
      graphVersion: context.graphVersion,
      sourceNodeId: context.sourceNodeId ?? null,
      visitedNodeIds: context.visitedNodeIds,
      candidates: nodes.map(compactCard),
    },
    questions,
    policy: {mode: 'ranking'},
    origin: {source: 'service', eventId: context.packetSeed.slice(0, 64)},
    correlation: {requestId: context.packetSeed.slice(0, 64)},
    mode: 'evaluate',
  };
}

export class Ranker {
  readonly #arm: Arm;
  readonly #evaluate?: EvaluateDecisions;

  constructor(arm: Arm, evaluate?: EvaluateDecisions) {
    this.#arm = arm;
    this.#evaluate = evaluate;
  }

  async rank(nodes: readonly GraphNode[], context: RankContext, signal?: AbortSignal): Promise<{nodes: GraphNode[]; audit: RankAudit}> {
    const start = process.hrtime.bigint();
    const cheap = cheapOrder(context.query || context.objective, nodes);
    let ordered = this.#arm === 'graph' ? graphOrder(nodes) : cheap;
    let appliedArm: RankAudit['appliedArm'] = this.#arm === 'graph' ? 'graph' : 'cheap';
    let fallbackReason: string | undefined;
    const providerReceiptIds: string[] = [];
    const providerUsage: RankAudit['providerUsage'] = [];
    const providerLatencyMs: number[] = [];
    const providerTransports: RankAudit['providerTransports'] = [];
    const providerRankings: RankAudit['providerRankings'] = [];
    let providerModel: string | undefined;

    if (this.#arm === 'jev' && nodes.length) {
      const scores = new Map<string, number>();
      const evaluate = this.#evaluate ?? pinnedJevEvaluator();
      try {
        for (let offset = 0; offset < nodes.length; offset += MAX_BATCH) {
          const batch = nodes.slice(offset, offset + MAX_BATCH);
          const assessment = await evaluate(sanitize(jevInput(batch, context, offset), []), signal);
          if (assessment.receiptId) providerReceiptIds.push(assessment.receiptId);
          if (assessment.usage) providerUsage.push(assessment.usage);
          if (typeof assessment.latencyMs === 'number') providerLatencyMs.push(assessment.latencyMs);
          if (assessment.model) providerModel = assessment.model;
          if (assessment.transport) {
            const {requestStartedAt, fetchInvoked, responseReceivedAt, responseStatus, validatedResponse, providerRequestId, providerRequestIdHeader} = assessment.transport;
            providerTransports.push({requestStartedAt, fetchInvoked, responseReceivedAt, responseStatus, validatedResponse, providerRequestId, providerRequestIdHeader});
          }
          if (assessment.status !== 'assessed' || !assessment.answers) throw new Error(`jev_${assessment.status}_${assessment.reasonCode ?? 'unknown'}`);
          const retainedAnswers: Record<string, {providerChoice: string; probabilities: Record<string, number>}> = {};
          for (let index = 0; index < batch.length; index += 1) {
            const answer = assessment.answers[`node_${String(offset + index).padStart(3, '0')}`];
            if (!answer || answer.type !== 'choice' || answer.disposition === 'abstained' || typeof answer.providerChoice !== 'string' || !answer.probabilities) throw new Error('jev_invalid_answer');
            let expected = 0;
            for (let level = 0; level < RELEVANCE_LEVELS.length; level += 1) {
              const probability = answer.probabilities[RELEVANCE_LEVELS[level]!];
              if (!Number.isFinite(probability) || probability! < 0 || probability! > 1) throw new Error('jev_invalid_answer');
              expected += level * probability!;
            }
            retainedAnswers[`node_${String(offset + index).padStart(3, '0')}`] = {providerChoice: answer.providerChoice, probabilities: Object.fromEntries(Object.entries(answer.probabilities).sort(([a], [b]) => a.localeCompare(b)))};
            scores.set(batch[index]!.nodeId, expected);
          }
          providerRankings.push({...(assessment.receiptId ? {receiptId: assessment.receiptId} : {}), answers: retainedAnswers});
        }
        if (scores.size !== nodes.length) throw new Error('jev_incomplete_answers');
        ordered = [...nodes].sort((a, b) => scores.get(b.nodeId)! - scores.get(a.nodeId)! || a.nodeId.localeCompare(b.nodeId));
        appliedArm = 'jev';
      } catch (error) {
        fallbackReason = error instanceof Error ? error.message.slice(0, 160) : 'jev_unknown_failure';
        ordered = cheap;
        appliedArm = 'cheap';
      }
    }

    return {
      nodes: ordered,
      audit: {
        requestedArm: this.#arm,
        appliedArm,
        ...(fallbackReason ? {fallbackReason} : {}),
        candidateNodeIds: nodes.map(node => node.nodeId),
        orderedNodeIds: ordered.map(node => node.nodeId),
        providerReceiptIds,
        ...(providerModel ? {providerModel} : {}),
        providerUsage,
        providerLatencyMs,
        providerTransports,
        providerRankings,
        durationNs: String(process.hrtime.bigint() - start),
      },
    };
  }
}
