import { createHash, randomUUID } from 'node:crypto';
import { failureSchema, completionSchema, failureQuestions, completionQuestions, RUBRIC_VERSION, MODEL, ENDPOINT, workflowByCategory, type Category, type Question } from './contracts.js';
import { sanitize, redactText } from './redact.js';
import { evaluateProvider, fingerprintCredential, ProviderError, type ProviderTransport } from './provider.js';
import { FileStore, dataDirectory, readBudgetUsage, type Store } from './store.js';
import { readPolicy, DEFAULT_POLICY, type HookPolicy } from './policy.js';
import { decisionSchema, decisionQuestions, DECISION_RUBRIC_VERSION } from './decision.js';

export type Assessment = {
  status: 'preview' | 'assessed' | 'abstained' | 'unavailable' | 'skipped';
  reasonCode?: string; category?: string; support?: string; workflow?: string;
  domain?: string; choice?: string;
  confidence?: number; probabilities?: Record<string, number>; signals?: Record<string, number>;
  evidenceIds?: string[]; model?: string; rubricVersion?: string; inputDigest?: string;
  receiptId?: string; receiptPersisted?: boolean; cached?: boolean; latencyMs?: number;
  transport?: ProviderTransport;
  usage?: {input_tokens: number; output_tokens: number}; preview?: unknown; budget?: Awaited<ReturnType<typeof readBudgetUsage>>;
};
export interface ServiceOptions {
  apiKey?: string; enabled?: boolean; timeoutMs?: number; fetchFn?: typeof fetch;
  store?: Store; confidenceFloor?: number; env?: NodeJS.ProcessEnv;
}
const maxPayloadBytes = 48000;
function positiveLimit(value: string | undefined, fallback: number | null): number | null {
  if (value === undefined) return fallback;
  if (value === 'unlimited') return null;
  if (!/^\d+$/.test(value)) return 0;
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 0 ? n : 0;
}

export function createService(options: ServiceOptions = {}) {
  const env = options.env ?? process.env;
  const apiKey = options.apiKey ?? env.TYPESAFE_API_KEY ?? '';
  const enabled = options.enabled ?? env.JEV_ENABLED !== '0';
  const timeoutMs = Math.min(Math.max(options.timeoutMs ?? 10000, 1), 10000);
  const confidenceFloor = options.confidenceFloor ?? 0.6;
  const credentialFingerprint = apiKey ? fingerprintCredential(apiKey) : null;
  const cache = new Map<string, Assessment>();
  const inFlight = new Map<string, Promise<Assessment>>();
  const digestOf = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  function status(policy: HookPolicy = DEFAULT_POLICY) {
    return {version: '0.2.2', provider: 'TypeSafe', endpoint: ENDPOINT, model: MODEL,
      credentialConfigured: Boolean(apiKey), credentialFingerprint, enabled,
      stateDirectory: dataDirectory(env), defaultMode: 'preview', rubricVersion: RUBRIC_VERSION, decisionRubricVersion: DECISION_RUBRIC_VERSION, maxPayloadBytes,
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
    if (new Set(input.evidence.map(e => e.id)).size !== input.evidence.length) return {status: 'skipped', reasonCode: 'duplicate_evidence_ids'};
    if (input.evidence.some(e => redactText(e.id, [apiKey]) !== e.id)) return {status: 'skipped', reasonCode: 'unsafe_evidence_id'};
    if ('candidates' in input) {
      if (new Set(input.candidates.map(c => c.id)).size !== input.candidates.length) return {status: 'skipped', reasonCode: 'duplicate_candidate_ids'};
      if (input.candidates.some(c => ['insufficient_evidence', '__proto__', 'constructor', 'prototype'].includes(c.id) || redactText(c.id, [apiKey]) !== c.id)) return {status: 'skipped', reasonCode: 'unsafe_candidate_id'};
      if (!input.candidates.some(c => c.available)) return {status: 'abstained', reasonCode: 'no_available_candidates', domain: input.domain};
    }
    if ('exitCode' in input) {
      if (input.exitCode === 0) return {status: 'skipped', reasonCode: 'command_succeeded'};
      if (input.exitCode === null) return {status: 'abstained', reasonCode: 'command_not_completed'};
    }
    const {mode, ...selected} = input;
    const state = sanitize(selected, [apiKey]);
    // Sanitize caller-defined questions and criteria as well as state before any egress.
    const questions = sanitize('candidates' in input ? decisionQuestions(input) : tool === 'classify_failure' ? failureQuestions : completionQuestions, [apiKey]) as Record<string, Question>;
    const rubricVersion = tool === 'classify_decision' ? DECISION_RUBRIC_VERSION : RUBRIC_VERSION;
    const payload = {state, questions, model: MODEL};
    const bytes = Buffer.byteLength(JSON.stringify(payload));
    if (bytes > maxPayloadBytes) return {status: 'skipped', reasonCode: 'payload_too_large'};
    const evidenceIds = input.evidence.map(e => e.id);
    const inputDigest = digestOf({payload, rubric: rubricVersion, confidenceFloor});
    if (mode === 'preview') return {status: 'preview', preview: payload, evidenceIds, inputDigest, rubricVersion};
    if (!enabled) return {status: 'skipped', reasonCode: 'disabled'};
    if (!apiKey) return {status: 'unavailable', reasonCode: 'missing_api_key'};
    if (signal?.aborted) return {status: 'unavailable', reasonCode: 'cancelled'};
    if (tool === 'check_completion' && input.evidence.length === 0) {
      return {status: 'abstained', support: 'insufficient_evidence', reasonCode: 'no_evidence', evidenceIds};
    }
    const cached = cache.get(inputDigest);
    if (cached) return {...cached, cached: true};
    // Do not coalesce independently cancellable calls, so one client cannot cancel another.
    if (!signal && inFlight.has(inputDigest)) return {...await inFlight.get(inputDigest)!, cached: true};
    const work = run();
    if (!signal) inFlight.set(inputDigest, work);
    try { return await work; }
    finally { if (!signal) inFlight.delete(inputDigest); }

    async function run(): Promise<Assessment> {
      const start = Date.now();
      const receiptId = randomUUID();
      const meta = {receiptId, evidenceIds, inputDigest, rubricVersion};
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
        const uncertain = answer.confidence < confidenceFloor || answer.probabilities[answer.choice]! < confidenceFloor || answer.choice === 'insufficient_evidence';
        result = {status: uncertain ? 'abstained' : 'assessed', ...meta, model: evaluation.model,
          confidence: answer.confidence, probabilities: answer.probabilities, usage: evaluation.usage,
          transport: evaluation.transport,
          signals: Object.fromEntries(Object.entries(evaluation.answers).filter(([,a]) => a.type === 'noul').map(([id,a]) => [id, a.type === 'noul' ? a.noul : 0]))};
        if (tool === 'classify_failure') {
          result.category = answer.choice;
          result.workflow = uncertain ? 'gather_evidence' : workflowByCategory[answer.choice as Category];
        } else if ('candidates' in input) { result.choice = answer.choice; result.domain = input.domain; }
        else { result.support = answer.choice; }
        if (uncertain) result.reasonCode = answer.choice === 'insufficient_evidence' ? 'insufficient_evidence' : 'low_confidence';
      } catch (err) {
        result = {status: 'unavailable', reasonCode: err instanceof ProviderError ? err.code : 'internal_error', ...meta,
          ...(err instanceof ProviderError && err.transport ? {transport: err.transport} : {})};
      }
      result.latencyMs = Date.now() - start;
      try { await store.save({timestamp: new Date().toISOString(), tool, ...result}); result.receiptPersisted = true; }
      catch { result.receiptPersisted = false; }
      if (result.status === 'assessed' || result.status === 'abstained') {
        if (cache.size >= 128) cache.delete(cache.keys().next().value!);
        cache.set(inputDigest, result);
      }
      return result;
    }
  }
  return {
    status,
    classifyFailure: (input: unknown, signal?: AbortSignal) => assess('classify_failure', input, signal),
    checkCompletion: (input: unknown, signal?: AbortSignal) => assess('check_completion', input, signal),
    classifyDecision: (input: unknown, signal?: AbortSignal) => assess('classify_decision', input, signal)
  };
}
