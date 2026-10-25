import {createService, type Assessment} from '../../../source/jev-workflows/src/service.js';
import {VERSIONED_MODELS, type VersionedModel} from '../../../source/jev-workflows/src/contracts.js';
import {sanitize} from '../../../source/jev-workflows/src/redact.js';
import {expectedRelevance} from './relevance.js';
import {RELEVANCE_LEVELS, type ProviderAttempt, type RelevanceAssessment, type RelevanceEvaluator, type RelevanceRequest} from './types.js';

export const DEFAULT_JEV_MODEL = 'jev-1.14.0';
const MAX_BATCH = 16;
const MAX_PACKET_BYTES = 40000;
const OUTAGE_BACKOFF_MS = 30000;
const OUTAGE_REASONS = new Set(['timeout', 'request_timeout', 'rate_limited', 'provider_overloaded', 'provider_error', 'provider_unavailable']);
const DESCRIPTIONS = [
  'Unrelated to the objective and current query.',
  'Weakly related context.',
  'Plausibly useful supporting context.',
  'Directly useful to localize or repair the objective.',
  'Essential to the next repair step.',
];
export type EvaluateDecisions = (input: unknown, signal?: AbortSignal) => Promise<Assessment>;

function pinnedModel(value: string | undefined): VersionedModel {
  const model = value ?? DEFAULT_JEV_MODEL;
  if (!(VERSIONED_MODELS as readonly string[]).includes(model)) throw new Error('PROJECT_GRAPH_JEV_MODEL must be an exact supported version');
  return model as VersionedModel;
}

function packet(cards: RelevanceRequest['cards'], context: RelevanceRequest['context'], offset: number, model: VersionedModel): unknown {
  return sanitize({
    state: {
      objective: context.objective, query: context.query, operation: context.operation,
      graphVersion: context.graphVersion, sourceNodeId: context.sourceNodeId ?? null,
      visitedNodeIds: context.visitedNodeIds, candidates: cards,
    },
    questions: Object.fromEntries(cards.map((card, index) => [`node_${String(offset + index).padStart(3, '0')}`, {
      type: 'choice', domain: 'context', policy: {mode: 'ranking'},
      instructions: {task: 'Choose the ordinal relevance level for this code node against the stated coding objective and current traversal query.', nodeId: card.nodeId},
      candidates: RELEVANCE_LEVELS.map((id, level) => ({id, description: DESCRIPTIONS[level], available: true})),
    }])),
    policy: {mode: 'ranking'},
    origin: {source: 'service', eventId: context.packetSeed.slice(0, 64)},
    correlation: {requestId: context.packetSeed.slice(0, 64)},
    model,
    mode: 'evaluate',
  }, []);
}

function attemptOf(result: Assessment, model: VersionedModel): ProviderAttempt {
  const cached = result.cached === true;
  return {
    provider: 'jev', status: result.status, requestedModel: model,
    ...(result.reasonCode ? {reasonCode: result.reasonCode} : {}),
    ...(result.receiptId ? {receiptId: result.receiptId} : {}),
    ...(result.model ? {model: result.model} : {}),
    cached, actualFetchInvoked: result.transport?.fetchInvoked === true && !cached,
    usage: result.usage ?? {input_tokens: null, output_tokens: null},
    ...(result.latencyMs === undefined ? {} : {latencyMs: result.latencyMs}),
    ...(result.transport ? {transport: {
      requestStartedAt: result.transport.requestStartedAt,
      fetchInvoked: result.transport.fetchInvoked,
      responseReceivedAt: result.transport.responseReceivedAt,
      responseStatus: result.transport.responseStatus,
      validatedResponse: result.transport.validatedResponse,
      providerRequestId: result.transport.providerRequestId,
      providerRequestIdHeader: result.transport.providerRequestIdHeader,
    }} : {}),
  };
}

export function jevRelevanceEvaluator(options: {env?: NodeJS.ProcessEnv; model?: string; evaluate?: EvaluateDecisions; now?: () => number} = {}): RelevanceEvaluator {
  const env = options.env ?? process.env;
  const model = pinnedModel(options.model ?? env.PROJECT_GRAPH_JEV_MODEL);
  const evaluate = options.evaluate ?? createService({env: {
    JEV_ENABLED: '1', JEV_MODEL: model,
    JEV_STATE_DIRECTORY: env.JEV_STATE_DIRECTORY, JEV_API_KEY_FILE: env.JEV_API_KEY_FILE,
    JEV_MAX_CALLS_PER_DAY: 'unlimited', JEV_MAX_BYTES_PER_DAY: 'unlimited',
  }}).evaluateDecisions;
  const now = options.now ?? Date.now;
  let retryAt = 0;
  return async ({cards, context}, signal) => {
    const attempts: ProviderAttempt[] = [];
    if (signal?.aborted) return {status: 'unavailable', reasonCode: 'jev_cancelled', attempts};
    if (now() < retryAt) return {status: 'unavailable', reasonCode: 'jev_outage_backoff', attempts};
    const assessments: Record<string, RelevanceAssessment> = {};
    for (let offset = 0; offset < cards.length;) {
      let batch = cards.slice(offset, offset + MAX_BATCH);
      let input = packet(batch, context, offset, model);
      while (Buffer.byteLength(JSON.stringify(input)) > MAX_PACKET_BYTES && batch.length > 1) {
        batch = batch.slice(0, Math.ceil(batch.length / 2));
        input = packet(batch, context, offset, model);
      }
      if (Buffer.byteLength(JSON.stringify(input)) > MAX_PACKET_BYTES) return {status: 'unavailable', reasonCode: 'jev_payload_too_large', attempts};
      let result: Assessment;
      try { result = await evaluate(input, signal); }
      catch {
        retryAt = now() + OUTAGE_BACKOFF_MS;
        attempts.push({provider: 'jev', status: 'unavailable', requestedModel: model, reasonCode: 'evaluator_exception', cached: false, actualFetchInvoked: false, usage: {input_tokens: null, output_tokens: null}});
        return {status: 'unavailable', reasonCode: 'jev_evaluator_exception', attempts};
      }
      attempts.push(attemptOf(result, model));
      if (OUTAGE_REASONS.has(result.reasonCode ?? '')) retryAt = now() + OUTAGE_BACKOFF_MS;
      if (result.status !== 'assessed' || !result.answers) return {status: 'unavailable', reasonCode: `jev_${result.status}_${result.reasonCode ?? 'unknown'}`, attempts};
      if (result.model !== model) return {status: 'unavailable', reasonCode: 'jev_model_mismatch', attempts};
      if (Object.keys(result.answers).length !== batch.length) return {status: 'unavailable', reasonCode: 'jev_incomplete_answers', attempts};
      for (let index = 0; index < batch.length; index += 1) {
        const answer = result.answers[`node_${String(offset + index).padStart(3, '0')}`];
        if (!answer || answer.type !== 'choice' || answer.disposition !== 'ranking') return {status: 'unavailable', reasonCode: 'jev_invalid_answer', attempts};
        const relevance = {providerChoice: answer.providerChoice, probabilities: answer.probabilities} as RelevanceAssessment;
        try { expectedRelevance(relevance); }
        catch { return {status: 'unavailable', reasonCode: 'jev_invalid_answer', attempts}; }
        assessments[batch[index]!.nodeId] = relevance;
      }
      offset += batch.length;
    }
    return {status: 'assessed', assessments, attempts};
  };
}

export function pinnedJevEvaluator(env: NodeJS.ProcessEnv = process.env): RelevanceEvaluator {
  return jevRelevanceEvaluator({env});
}
