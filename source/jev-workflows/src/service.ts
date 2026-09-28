import { createHash, randomUUID } from 'node:crypto';
import { failureSchema, completionSchema, failureQuestions, completionQuestionsFor, RUBRIC_VERSION, COMPLETION_RUBRIC_VERSION, MODEL, ENDPOINT, workflowByCategory, type Category, type Question } from './contracts.js';
import { sanitize, redactText } from './redact.js';
import { evaluateProvider, fingerprintCredential, ProviderError, type ProviderTransport } from './provider.js';
import { FileStore, dataDirectory, readBudgetUsage, type Store } from './store.js';
import { readPolicy, DEFAULT_POLICY, type HookPolicy } from './policy.js';
import { decisionSchema, decisionQuestions, DECISION_RUBRIC_VERSION } from './decision.js';
import { readCredentialFile } from './credential.js';
import {
  BATCH_RUBRIC_VERSION, evaluateDecisionsSchema, isBoundedJsonStructure, isReservedId, policiesByQuestion, providerQuestions,
  resolveDecisionPolicy, INSUFFICIENT_EVIDENCE_ID, type BatchQuestion, type DecisionDomain, type DecisionPolicy, type EvaluateDecisionsInput,
} from './batch.js';
import type { Answer } from './provider.js';

export type BatchAnswerAssessment =
  | {type: 'choice'; domain?: DecisionDomain; providerChoice: string; bestCandidate?: string; probabilities: Record<string, number>; confidence: number; disposition: 'recommendation' | 'ranking' | 'abstained'; recommendation?: string; reasonCode?: 'insufficient_evidence' | 'low_confidence'; policy: DecisionPolicy}
  | {type: 'score'; domain?: DecisionDomain; score: number; legend: Record<string, unknown>; probabilities: Record<string, number>; confidence: number; disposition: 'advisory' | 'ranking' | 'abstained'; policy: DecisionPolicy}
  | {type: 'noul'; domain?: DecisionDomain; noul: number; disposition: 'advisory'; policy: DecisionPolicy};

export type Assessment = {
  status: 'preview' | 'assessed' | 'abstained' | 'unavailable' | 'skipped';
  reasonCode?: string; category?: string; support?: string; workflow?: string;
  domain?: string; choice?: string; providerChoice?: string; bestCandidate?: string; recommendation?: string; disposition?: string; questionId?: string;
  confidence?: number; probabilities?: Record<string, number>; signals?: Record<string, number>;
  evidenceIds?: string[]; model?: string; rubricVersion?: string; inputDigest?: string;
  receiptId?: string; receiptPersisted?: boolean; cached?: boolean; latencyMs?: number;
  transport?: ProviderTransport;
  usage?: {input_tokens: number; output_tokens: number}; preview?: unknown; budget?: Awaited<ReturnType<typeof readBudgetUsage>>;
  answers?: Record<string, BatchAnswerAssessment>; questionIds?: string[]; policy?: DecisionPolicy; policies?: Record<string, DecisionPolicy>;
  origin?: EvaluateDecisionsInput['origin']; correlation?: EvaluateDecisionsInput['correlation'];
  authority?: 'advisory_only';
};
export interface ServiceOptions {
  apiKey?: string; enabled?: boolean; timeoutMs?: number; fetchFn?: typeof fetch;
  store?: Store; confidenceFloor?: number; env?: NodeJS.ProcessEnv;
}
const maxPayloadBytes = 48000;
function bestActualCandidate(probabilities: Record<string, number>, actualCandidateIds: string[]): string | undefined {
  let best: string | undefined;
  let max = Number.NEGATIVE_INFINITY;
  for (const id of actualCandidateIds) {
    const probability = probabilities[id];
    if (probability !== undefined && probability > max) {
      best = id;
      max = probability;
    }
  }
  return best;
}

function positiveLimit(value: string | undefined, fallback: number | null): number | null {
  if (value === undefined) return fallback;
  if (value === 'unlimited') return null;
  if (!/^\d+$/.test(value)) return 0;
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 0 ? n : 0;
}

export function createService(options: ServiceOptions = {}) {
  const env = options.env ?? process.env;
  const staticApiKey = options.apiKey ?? env.TYPESAFE_API_KEY ?? '';
  const credentialFile = options.apiKey === undefined ? env.JEV_API_KEY_FILE : undefined;
  const credential = () => {
    const apiKey = credentialFile === undefined ? staticApiKey : readCredentialFile(credentialFile);
    return {apiKey, fingerprint: apiKey ? fingerprintCredential(apiKey) : null};
  };
  const enabled = options.enabled ?? env.JEV_ENABLED !== '0';
  const timeoutMs = Math.min(Math.max(options.timeoutMs ?? 10000, 1), 10000);
  const confidenceFloor = options.confidenceFloor ?? 0.6;
  const cache = new Map<string, Assessment>();
  const inFlight = new Map<string, Promise<Assessment>>();
  const digestOf = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  function status(policy: HookPolicy = DEFAULT_POLICY) {
    const current = credential();
    return {version: '0.5.0', provider: 'TypeSafe', endpoint: ENDPOINT, model: MODEL,
      credentialConfigured: Boolean(current.apiKey), credentialFingerprint: current.fingerprint, enabled,
      stateDirectory: dataDirectory(env), defaultMode: 'preview', rubricVersion: RUBRIC_VERSION, completionRubricVersion: COMPLETION_RUBRIC_VERSION, decisionRubricVersion: DECISION_RUBRIC_VERSION, batchRubricVersion: BATCH_RUBRIC_VERSION, maxPayloadBytes,
      maxCallsPerDay: positiveLimit(env.JEV_MAX_CALLS_PER_DAY, policy.maxCallsPerDay),
      maxBytesPerDay: positiveLimit(env.JEV_MAX_BYTES_PER_DAY, policy.maxBytesPerDay),
      note: 'Status is local. Evaluation sends selected redacted question, context, candidate descriptions/metadata, and evidence to TypeSafe. Automatic consultation requires enabled local policy, workspace scope, and trusted hooks on a supported host.'};
  }
  async function assess(tool: 'classify_failure' | 'check_completion' | 'classify_decision', raw: unknown, signal?: AbortSignal): Promise<Assessment> {
    const schema = tool === 'classify_failure' ? failureSchema : tool === 'check_completion' ? completionSchema : decisionSchema;
    if (tool === 'classify_decision' && raw && typeof raw === 'object' && 'candidates' in raw && Array.isArray(raw.candidates) && raw.candidates.some(c => c && typeof c === 'object' && c.metadata && typeof c.metadata === 'object' && Object.keys(c.metadata).length > 16)) return {status: 'skipped', reasonCode: 'invalid_input'};
    const parsed = schema.safeParse(raw);
    if (!parsed.success) return {status: 'skipped', reasonCode: 'invalid_input'};
    const input = parsed.data;
    const origin = 'origin' in input ? input.origin : undefined;
    const correlation = 'correlation' in input ? input.correlation : undefined;
    const decisionPolicy = 'candidates' in input
      ? resolveDecisionPolicy(input.policy, undefined, {minConfidence: confidenceFloor, minProbability: confidenceFloor})
      : undefined;
    const originMeta = {
      ...(origin ? {origin} : {}),
      ...(correlation ? {correlation} : {}),
    };
    const localMeta = {
      ...(decisionPolicy ? {policy: decisionPolicy} : {}),
      ...(decisionPolicy ? {authority: 'advisory_only' as const} : {}),
      ...originMeta,
    };
    const current = credential();
    // A configured file that cannot be read must never fall back to a captured,
    // possibly revoked environment key. Preview also fails closed because the
    // current credential would be unavailable for exact-match redaction.
    if (credentialFile !== undefined && !current.apiKey && input.mode !== 'preview') return {status: 'unavailable', reasonCode: 'credential_source_unavailable', ...originMeta};
    const apiKey = current.apiKey ?? '';
    const secrets = [apiKey, staticApiKey].filter(Boolean);
    if (new Set(input.evidence.map(e => e.id)).size !== input.evidence.length) return {status: 'skipped', reasonCode: 'duplicate_evidence_ids'};
    if (input.evidence.some(e => redactText(e.id, secrets) !== e.id)) return {status: 'skipped', reasonCode: 'unsafe_evidence_id'};
    if ('candidates' in input) {
      if (new Set(input.candidates.map(c => c.id)).size !== input.candidates.length) return {status: 'skipped', reasonCode: 'duplicate_candidate_ids'};
      if (input.candidates.some(c => [INSUFFICIENT_EVIDENCE_ID, '__proto__', 'constructor', 'prototype'].includes(c.id) || redactText(c.id, secrets) !== c.id)) return {status: 'skipped', reasonCode: 'unsafe_candidate_id'};
      if (input.candidates.filter(c => c.available).length < 1) return {status: 'abstained', reasonCode: 'insufficient_available_candidates', domain: input.domain, ...localMeta};
    }
    if ('exitCode' in input) {
      if (input.exitCode === 0) return {status: 'skipped', reasonCode: 'command_succeeded'};
      if (input.exitCode === null) return {status: 'abstained', reasonCode: 'command_not_completed'};
    }
    const selected = Object.fromEntries(Object.entries(input).filter(([key]) => !['mode', 'policy', 'origin', 'correlation'].includes(key)));
    if ('candidates' in input) selected.candidates = input.candidates.filter(candidate => candidate.available);
    const state = sanitize(selected, secrets);
    // Sanitize caller-defined questions and criteria as well as state before any egress.
    const rawQuestions = 'candidates' in input ? decisionQuestions(input)
      : 'exitCode' in input ? failureQuestions
        : completionQuestionsFor(input);
    const questions = sanitize(rawQuestions, secrets) as Record<string, Question>;
    const rubricVersion = tool === 'classify_decision' ? DECISION_RUBRIC_VERSION : tool === 'check_completion' ? COMPLETION_RUBRIC_VERSION : RUBRIC_VERSION;
    const payload = {state, questions, model: MODEL};
    const bytes = Buffer.byteLength(JSON.stringify(payload));
    if (bytes > maxPayloadBytes) return {status: 'skipped', reasonCode: 'payload_too_large', ...originMeta};
    const evidenceIds = input.evidence.map(e => e.id);
    const inputDigest = digestOf({payload, rubric: rubricVersion, policy: decisionPolicy ?? {minConfidence: confidenceFloor, minProbability: confidenceFloor}});
    if (input.mode === 'preview') return {status: 'preview', preview: payload, evidenceIds, inputDigest, rubricVersion, ...localMeta};
    if (!enabled) return {status: 'skipped', reasonCode: 'disabled', ...originMeta};
    if (!apiKey) return {status: 'unavailable', reasonCode: 'missing_api_key', ...originMeta};
    if (signal?.aborted) return {status: 'unavailable', reasonCode: 'cancelled', ...originMeta};
    if (tool === 'check_completion' && input.evidence.length === 0) {
      return {status: 'abstained', support: 'insufficient_evidence', reasonCode: 'no_evidence', evidenceIds};
    }
    // Credential identity is part of cache/coalescing identity so a rotated
    // key never receives a previous key's assessment or in-flight response.
    const cacheKey = digestOf({inputDigest, credentialFingerprint: current.fingerprint, origin, correlation});
    const cached = cache.get(cacheKey);
    if (cached) return {...cached, cached: true};
    // Do not coalesce independently cancellable calls, so one client cannot cancel another.
    if (!signal && inFlight.has(cacheKey)) return {...await inFlight.get(cacheKey)!, cached: true};
    const work = run();
    if (!signal) inFlight.set(cacheKey, work);
    try { return await work; }
    finally { if (!signal) inFlight.delete(cacheKey); }

    async function run(): Promise<Assessment> {
      const start = Date.now();
      const receiptId = randomUUID();
      const meta = {receiptId, evidenceIds, inputDigest, rubricVersion, ...localMeta};
      let result: Assessment;
      const limits = status(await readPolicy(env));
      const store = options.store ?? new FileStore(dataDirectory(env), limits.maxCallsPerDay, limits.maxBytesPerDay);
      try {
        if (!(await store.reserve(bytes))) return {status: 'skipped', reasonCode: 'budget_exhausted', ...meta, receiptPersisted: false, ...(options.store ? {} : {budget: await readBudgetUsage(dataDirectory(env), limits.maxCallsPerDay, limits.maxBytesPerDay)})};
      } catch { return {status: 'unavailable', reasonCode: 'budget_store_unavailable', ...meta, receiptPersisted: false}; }
      try {
        const evaluation = await evaluateProvider({state, questions: questions as Record<string, Question>, apiKey, timeoutMs, signal, fetchFn: options.fetchFn});
        const answer = evaluation.answers[tool === 'classify_failure' ? 'category' : tool === 'check_completion' ? 'support' : 'decision'];
        if (!answer || answer.type !== 'choice') throw new ProviderError('invalid_response', evaluation.transport);
        // Confidence and selected probability are separate signals; neither alone is a correctness guarantee.
        const minConfidence = decisionPolicy?.minConfidence ?? confidenceFloor;
        const minProbability = decisionPolicy?.minProbability ?? confidenceFloor;
        const ranking = decisionPolicy?.mode === 'ranking';
        const providerAbstained = answer.choice === INSUFFICIENT_EVIDENCE_ID;
        const uncertain = providerAbstained || (!ranking && (answer.confidence < minConfidence || answer.probabilities[answer.choice]! < minProbability));
        result = {status: uncertain ? 'abstained' : 'assessed', ...meta, model: evaluation.model,
          confidence: answer.confidence, probabilities: answer.probabilities, usage: evaluation.usage,
          transport: evaluation.transport,
          signals: Object.fromEntries(Object.entries(evaluation.answers).filter(([,a]) => a.type === 'noul').map(([id,a]) => [id, a.type === 'noul' ? a.noul : 0]))};
        if (tool === 'classify_failure') {
          result.category = answer.choice;
          result.workflow = uncertain ? 'gather_evidence' : workflowByCategory[answer.choice as Category];
        } else if ('candidates' in input) {
          result.choice = answer.choice;
          result.providerChoice = answer.choice;
          const bestCandidate = bestActualCandidate(answer.probabilities, input.candidates.filter(candidate => candidate.available).map(candidate => candidate.id));
          if (bestCandidate) result.bestCandidate = bestCandidate;
          result.domain = input.domain;
          result.disposition = ranking ? 'ranking' : uncertain ? 'abstained' : 'recommendation';
          if (!uncertain) result.recommendation = answer.choice;
        }
        else { result.support = answer.choice; }
        if (uncertain) result.reasonCode = providerAbstained ? 'insufficient_evidence' : 'low_confidence';
      } catch (err) {
        result = {status: 'unavailable', reasonCode: err instanceof ProviderError ? err.code : 'internal_error', ...meta,
          ...(err instanceof ProviderError && err.transport ? {transport: err.transport} : {})};
      }
      result.latencyMs = Date.now() - start;
      try { await store.save({timestamp: new Date().toISOString(), tool, ...result}); result.receiptPersisted = true; }
      catch { result.receiptPersisted = false; }
      if (result.status === 'assessed' || result.status === 'abstained') {
        if (cache.size >= 128) cache.delete(cache.keys().next().value!);
        cache.set(cacheKey, result);
      }
      return result;
    }
  }

  async function evaluateDecisions(raw: unknown, signal?: AbortSignal): Promise<Assessment> {
    if (!isBoundedJsonStructure(raw)) return {status: 'skipped', reasonCode: 'invalid_input'};
    const parsed = evaluateDecisionsSchema.safeParse(raw);
    if (!parsed.success) return {status: 'skipped', reasonCode: 'invalid_input'};
    const input = parsed.data;
    const current = credential();
    if (credentialFile !== undefined && !current.apiKey && input.mode !== 'preview') return {status: 'unavailable', reasonCode: 'credential_source_unavailable'};
    const apiKey = current.apiKey ?? '';
    const secrets = [apiKey, staticApiKey].filter(Boolean);
    const questionIds = Object.keys(input.questions);
    const metadataIds = [
      ...questionIds,
      ...Object.values(input.origin ?? {}).filter(value => typeof value === 'string'),
      ...Object.values(input.correlation ?? {}).filter(value => typeof value === 'string'),
    ];
    if (metadataIds.some(id => redactText(id, secrets) !== id)) return {status: 'skipped', reasonCode: 'unsafe_id'};
    for (const [questionId, question] of Object.entries(input.questions)) {
      if (isReservedId(questionId)) return {status: 'skipped', reasonCode: 'unsafe_question_id', questionId};
      if (question.type !== 'choice') continue;
      const candidateIds = question.candidates.map(candidate => candidate.id);
      if (new Set(candidateIds).size !== candidateIds.length) return {status: 'skipped', reasonCode: 'duplicate_candidate_ids', questionId};
      if (candidateIds.some(id => isReservedId(id) || redactText(id, secrets) !== id)) return {status: 'skipped', reasonCode: 'unsafe_candidate_id', questionId};
      if (question.candidates.filter(candidate => candidate.available).length < 1) {
        return {status: 'skipped', reasonCode: 'insufficient_available_candidates', questionId, questionIds, ...(input.origin ? {origin: input.origin} : {}), ...(input.correlation ? {correlation: input.correlation} : {})};
      }
    }

    const state = sanitize(input.state, secrets);
    const questions = sanitize(providerQuestions(input), secrets) as Record<string, Question>;
    const policies = policiesByQuestion(input, {minConfidence: confidenceFloor, minProbability: confidenceFloor});
    const payload = {state, questions, model: MODEL};
    const bytes = Buffer.byteLength(JSON.stringify(payload));
    if (bytes > maxPayloadBytes) return {status: 'skipped', reasonCode: 'payload_too_large', questionIds};
    const inputDigest = digestOf({payload, rubric: BATCH_RUBRIC_VERSION, policies});
    const localMeta = {
      questionIds, inputDigest, rubricVersion: BATCH_RUBRIC_VERSION, policies, authority: 'advisory_only' as const,
      ...(input.origin ? {origin: input.origin} : {}),
      ...(input.correlation ? {correlation: input.correlation} : {}),
    };
    if (input.mode === 'preview') return {status: 'preview', preview: payload, ...localMeta};
    if (!enabled) return {status: 'skipped', reasonCode: 'disabled', ...localMeta};
    if (!apiKey) return {status: 'unavailable', reasonCode: 'missing_api_key', ...localMeta};
    if (signal?.aborted) return {status: 'unavailable', reasonCode: 'cancelled', ...localMeta};

    const cacheKey = digestOf({inputDigest, credentialFingerprint: current.fingerprint, origin: input.origin, correlation: input.correlation});
    const cached = cache.get(cacheKey);
    if (cached) return {...cached, cached: true};
    if (!signal && inFlight.has(cacheKey)) return {...await inFlight.get(cacheKey)!, cached: true};
    const work = run();
    if (!signal) inFlight.set(cacheKey, work);
    try { return await work; }
    finally { if (!signal) inFlight.delete(cacheKey); }

    async function run(): Promise<Assessment> {
      const start = Date.now();
      const receiptId = randomUUID();
      const meta = {receiptId, ...localMeta};
      let result: Assessment;
      const limits = status(await readPolicy(env));
      const store = options.store ?? new FileStore(dataDirectory(env), limits.maxCallsPerDay, limits.maxBytesPerDay);
      try {
        if (!(await store.reserve(bytes))) return {status: 'skipped', reasonCode: 'budget_exhausted', ...meta, receiptPersisted: false, ...(options.store ? {} : {budget: await readBudgetUsage(dataDirectory(env), limits.maxCallsPerDay, limits.maxBytesPerDay)})};
      } catch { return {status: 'unavailable', reasonCode: 'budget_store_unavailable', ...meta, receiptPersisted: false}; }
      try {
        const evaluation = await evaluateProvider({state, questions, apiKey, timeoutMs, signal, fetchFn: options.fetchFn});
        const answers = Object.fromEntries(Object.entries(evaluation.answers).map(([questionId, answer]) => [
          questionId, assessBatchAnswer(answer, policies[questionId]!, input.questions[questionId]!),
        ])) as Record<string, BatchAnswerAssessment>;
        const allAbstained = Object.values(answers).every(answer => answer.disposition === 'abstained');
        const abstentionReason = Object.values(answers).some(answer => answer.type === 'choice' && answer.reasonCode === 'insufficient_evidence')
          ? 'insufficient_evidence' : 'low_confidence';
        result = {
          status: allAbstained ? 'abstained' : 'assessed', ...meta, model: evaluation.model, answers,
          ...(allAbstained ? {reasonCode: abstentionReason} : {}), usage: evaluation.usage, transport: evaluation.transport,
        };
      } catch (err) {
        result = {status: 'unavailable', reasonCode: err instanceof ProviderError ? err.code : 'internal_error', ...meta,
          ...(err instanceof ProviderError && err.transport ? {transport: err.transport} : {})};
      }
      result.latencyMs = Date.now() - start;
      const retained = result.answers ? {
        ...result,
        answers: Object.fromEntries(Object.entries(result.answers).map(([id, answer]) => {
          if (answer.type !== 'score') return [id, answer];
          const {legend: _privateStructuredCriteria, ...safeAnswer} = answer;
          return [id, safeAnswer];
        })),
      } : result;
      try { await store.save({timestamp: new Date().toISOString(), tool: 'evaluate_decisions', ...retained}); result.receiptPersisted = true; }
      catch { result.receiptPersisted = false; }
      if (result.status === 'assessed' || result.status === 'abstained') {
        if (cache.size >= 128) cache.delete(cache.keys().next().value!);
        cache.set(cacheKey, result);
      }
      return result;
    }
  }

  function assessBatchAnswer(answer: Answer, policy: DecisionPolicy, question: BatchQuestion): BatchAnswerAssessment {
    const domain = question.domain;
    const domainMeta = domain ? {domain} : {};
    if (answer.type === 'noul') return {type: 'noul', ...domainMeta, noul: answer.noul, disposition: 'advisory', policy};
    if (answer.type === 'score') {
      const lowConfidence = policy.mode === 'conservative' && answer.confidence < policy.minConfidence;
      return {type: 'score', ...domainMeta, score: answer.score, legend: answer.legend, probabilities: answer.probabilities, confidence: answer.confidence,
        disposition: policy.mode === 'ranking' ? 'ranking' : lowConfidence ? 'abstained' : 'advisory', policy};
    }
    const providerAbstained = answer.choice === INSUFFICIENT_EVIDENCE_ID;
    const lowConfidence = !providerAbstained && policy.mode === 'conservative' &&
      (answer.confidence < policy.minConfidence || answer.probabilities[answer.choice]! < policy.minProbability);
    const disposition = providerAbstained ? 'abstained' : policy.mode === 'ranking' ? 'ranking' : lowConfidence ? 'abstained' : 'recommendation';
    const bestCandidate = question.type === 'choice'
      ? bestActualCandidate(answer.probabilities, question.candidates.filter(candidate => candidate.available).map(candidate => candidate.id))
      : undefined;
    return {type: 'choice', ...domainMeta, providerChoice: answer.choice, ...(bestCandidate ? {bestCandidate} : {}), probabilities: answer.probabilities, confidence: answer.confidence,
      disposition, ...(disposition === 'abstained' ? {reasonCode: providerAbstained ? 'insufficient_evidence' : 'low_confidence'} : {recommendation: answer.choice}), policy};
  }
  return {
    status,
    classifyFailure: (input: unknown, signal?: AbortSignal) => assess('classify_failure', input, signal),
    checkCompletion: (input: unknown, signal?: AbortSignal) => assess('check_completion', input, signal),
    classifyDecision: (input: unknown, signal?: AbortSignal) => assess('classify_decision', input, signal),
    evaluateDecisions,
  };
}
