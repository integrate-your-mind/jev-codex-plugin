import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { ENDPOINT, MODEL, type Question } from './contracts.js';
import { isBoundedJsonStructure, structuredEntrySchema, type StructuredEntry } from './batch.js';

export type ProviderRequestIdHeader = 'x-typesafe-request-id' | 'x-request-id' | 'request-id';
export const networkPolicyErrors = [
  'blocked-by-allowlist',
  'blocked-by-denylist',
  'blocked-by-method-policy',
  'blocked-by-policy',
] as const;
export type NetworkPolicyError = typeof networkPolicyErrors[number];
export type ResponseValidationFailure =
  | 'missing_body'
  | 'invalid_json'
  | 'response_schema'
  | 'model_mismatch'
  | 'answer_keys_mismatch'
  | 'answer_schema'
  | 'probability_keys_mismatch'
  | 'choice_unknown'
  | 'probability_sum_invalid'
  | 'choice_not_argmax'
  | 'score_legend_mismatch'
  | 'score_value_invalid';
export type ResponseValidationDiagnostic = {
  questionId?: string;
  sum?: number;
  deviation?: number;
  selected?: number;
  max?: number;
};
export type ProviderTransport = {
  requestStartedAt: string;
  fetchInvoked: boolean;
  responseReceivedAt: string | null;
  responseStatus: number | null;
  validatedResponse: boolean;
  providerRequestId: string | null;
  providerRequestIdHeader: ProviderRequestIdHeader | null;
  retryAfter: string | null;
  credentialFingerprint: string;
  networkPolicyError?: NetworkPolicyError;
  responseValidationFailure?: ResponseValidationFailure;
  responseValidationDiagnostic?: ResponseValidationDiagnostic;
};

export class ProviderError extends Error {
  constructor(public readonly code: string, public readonly transport: ProviderTransport | null = null) { super(code); }
}
const number01 = z.number().finite().min(0).max(1);
const responseSchema = z.strictObject({
  model: z.string(),
  answers: z.record(z.string(), z.unknown()),
  usage: z.strictObject({input_tokens: z.number().int().nonnegative(), output_tokens: z.number().int().nonnegative()})
});
const noulAnswerSchema = z.strictObject({type: z.literal('noul'), noul: number01});
const choiceAnswerSchema = z.strictObject({type: z.literal('choice'), choice: z.string(), probabilities: z.record(z.string(), number01), confidence: number01});
const scoreAnswerSchema = z.strictObject({
  type: z.literal('score'), score: z.number().finite(),
  legend: z.record(z.string(), structuredEntrySchema), probabilities: z.record(z.string(), number01), confidence: number01,
});
export type Answer =
  | {type: 'choice'; choice: string; probabilities: Record<string, number>; confidence: number}
  | {type: 'score'; score: number; legend: Record<string, StructuredEntry>; probabilities: Record<string, number>; confidence: number}
  | {type: 'noul'; noul: number};
export type Evaluation = {
  model: string;
  answers: Record<string, Answer>;
  usage: {input_tokens: number; output_tokens: number};
  transport?: ProviderTransport;
};
export type ProviderEvaluation = Evaluation & {transport: ProviderTransport};

export function fingerprintCredential(apiKey: string): string {
  return createHash('sha256').update(apiKey).digest('hex');
}

function requestIdentifier(response: Response, apiKey: string): {
  providerRequestId: string | null;
  providerRequestIdHeader: ProviderRequestIdHeader | null;
} {
  const names: ProviderRequestIdHeader[] = ['x-typesafe-request-id', 'x-request-id', 'request-id'];
  for (const name of names) {
    const value = response.headers.get(name);
    // Keep only bounded opaque identifiers. This excludes whitespace, control
    // characters, and reflected bearer credentials from receipts.
    if (value !== null && value.length <= 256 && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value) && !value.includes(apiKey)) {
      return {providerRequestId: value, providerRequestIdHeader: name};
    }
  }
  return {providerRequestId: null, providerRequestIdHeader: null};
}

function retryAfter(response: Response, apiKey: string): string | null {
  const value = response.headers.get('retry-after')?.trim();
  if (!value || value.length > 128 || value.includes(apiKey) || /[\r\n]/.test(value)) return null;
  if (/^\d{1,10}$/.test(value)) return value;
  return Number.isFinite(Date.parse(value)) ? value : null;
}

function networkPolicyError(response: Response): NetworkPolicyError | null {
  const value = response.headers.get('x-proxy-error')?.trim();
  return value && (networkPolicyErrors as readonly string[]).includes(value) ? value as NetworkPolicyError : null;
}

function exactKeys(left: Record<string, unknown>, right: Record<string, unknown>): boolean {
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every(key => Object.hasOwn(right, key));
}

function safeQuestionId(value: string): string | undefined {
  return /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,79}$/.test(value) && !['__proto__', 'constructor', 'prototype'].includes(value) ? value : undefined;
}

function invalidResponse(
  transport: ProviderTransport | null,
  failure: ResponseValidationFailure,
  diagnostic?: ResponseValidationDiagnostic,
): never {
  const bounded = diagnostic && Object.keys(diagnostic).length ? diagnostic : undefined;
  throw new ProviderError('invalid_response', transport ? {
    ...transport, responseValidationFailure: failure, ...(bounded ? {responseValidationDiagnostic: bounded} : {}),
  } : null);
}

export function validateEvaluation(raw: unknown, questions: Record<string, Question>, transport: ProviderTransport | null = null): Evaluation {
  if (!isBoundedJsonStructure(raw)) invalidResponse(transport, 'response_schema');
  const parsedResult = responseSchema.safeParse(raw);
  if (!parsedResult.success) invalidResponse(transport, 'response_schema');
  const parsed = parsedResult.data;
  if (parsed.model !== MODEL) invalidResponse(transport, 'model_mismatch');
  if (!exactKeys(parsed.answers, questions)) invalidResponse(transport, 'answer_keys_mismatch');
  const answers: Record<string, Answer> = {};
  for (const [key, q] of Object.entries(questions)) {
    if (q.type === 'noul') {
      const result = noulAnswerSchema.safeParse(parsed.answers[key]);
      if (!result.success) invalidResponse(transport, 'answer_schema', {questionId: safeQuestionId(key)});
      answers[key] = result.data;
    } else if (q.type === 'choice') {
      const result = choiceAnswerSchema.safeParse(parsed.answers[key]);
      if (!result.success) invalidResponse(transport, 'answer_schema', {questionId: safeQuestionId(key)});
      const answer = result.data;
      if (!exactKeys(answer.probabilities, q.criteria)) invalidResponse(transport, 'probability_keys_mismatch', {questionId: safeQuestionId(key)});
      if (!Object.hasOwn(q.criteria, answer.choice)) invalidResponse(transport, 'choice_unknown', {questionId: safeQuestionId(key)});
      const probabilities = Object.values(answer.probabilities);
      const sum = probabilities.reduce((a,b) => a+b, 0);
      const deviation = Math.abs(sum - 1);
      if (deviation > 0.001) invalidResponse(transport, 'probability_sum_invalid', {questionId: safeQuestionId(key), sum, deviation});
      const selected = answer.probabilities[answer.choice]!;
      const max = Math.max(...probabilities);
      if (selected + 0.000001 < max) invalidResponse(transport, 'choice_not_argmax', {questionId: safeQuestionId(key), selected, max});
      answers[key] = answer;
    } else {
      const result = scoreAnswerSchema.safeParse(parsed.answers[key]);
      if (!result.success) invalidResponse(transport, 'answer_schema', {questionId: safeQuestionId(key)});
      const answer = result.data;
      const levels = Object.fromEntries(q.criteria.map((_, index) => [String(index), true]));
      if (!exactKeys(answer.probabilities, levels)) invalidResponse(transport, 'probability_keys_mismatch', {questionId: safeQuestionId(key)});
      if (!exactKeys(answer.legend, levels) || q.criteria.some((criterion, index) => !isDeepStrictEqual(answer.legend[String(index)], criterion))) {
        invalidResponse(transport, 'score_legend_mismatch', {questionId: safeQuestionId(key)});
      }
      const probabilities = Object.values(answer.probabilities);
      const sum = probabilities.reduce((a,b) => a+b, 0);
      const deviation = Math.abs(sum - 1);
      if (deviation > 0.001) invalidResponse(transport, 'probability_sum_invalid', {questionId: safeQuestionId(key), sum, deviation});
      const weighted = Object.entries(answer.probabilities).reduce((total, [level, probability]) => total + Number(level) * probability, 0);
      if (answer.score < 0 || answer.score > q.criteria.length - 1 || Math.abs(answer.score - weighted) > 0.001) {
        invalidResponse(transport, 'score_value_invalid', {questionId: safeQuestionId(key)});
      }
      answers[key] = answer;
    }
  }
  return {model: parsed.model, answers, usage: parsed.usage, ...(transport ? {transport} : {})};
}

export async function evaluateProvider(args: {
  state: unknown; questions: Record<string, Question>; apiKey: string;
  timeoutMs: number; signal?: AbortSignal; fetchFn?: typeof fetch
}): Promise<ProviderEvaluation> {
  const timeout = AbortSignal.timeout(args.timeoutMs);
  const signal = args.signal ? AbortSignal.any([args.signal, timeout]) : timeout;
  let transport: ProviderTransport = {
    requestStartedAt: new Date().toISOString(),
    fetchInvoked: false,
    responseReceivedAt: null,
    responseStatus: null,
    validatedResponse: false,
    providerRequestId: null,
    providerRequestIdHeader: null,
    retryAfter: null,
    credentialFingerprint: fingerprintCredential(args.apiKey),
  };
  try {
    // AbortSignal listeners added after an abort do not fire. Check explicitly
    // before entering fetch so cancellation during earlier service work cannot
    // leave a custom transport waiting forever.
    if (args.signal?.aborted) throw new ProviderError('cancelled', transport);
    transport = {...transport, fetchInvoked: true};
    const response = await (args.fetchFn ?? fetch)(ENDPOINT, {
      method: 'POST', redirect: 'error', signal,
      headers: {'content-type': 'application/json', authorization: `Bearer ${args.apiKey}`},
      body: JSON.stringify({model: MODEL, state: args.state, questions: args.questions})
    });
    const policyError = response.status === 403 ? networkPolicyError(response) : null;
    transport = {
      ...transport,
      responseReceivedAt: new Date().toISOString(),
      responseStatus: response.status,
      ...requestIdentifier(response, args.apiKey),
      retryAfter: retryAfter(response, args.apiKey),
      ...(policyError ? {networkPolicyError: policyError} : {}),
    };
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      const code = response.status === 401 ? 'authentication_failed'
        : response.status === 403 && policyError ? 'network_policy_blocked'
        : response.status === 403 ? 'request_forbidden'
        : response.status === 422 ? 'invalid_request'
        : response.status === 429 ? 'rate_limited'
        : response.status === 529 ? 'provider_overloaded'
        : 'provider_error';
      throw new ProviderError(code, transport);
    }
    // Bound the response even when content-length is missing or dishonest.
    if (!response.body) invalidResponse(transport, 'missing_body');
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = []; let size = 0;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.byteLength;
        if (size > 65536) { await reader.cancel(); throw new ProviderError('response_too_large', transport); }
        chunks.push(next.value);
      }
    } finally { reader.releaseLock(); }
    let payload: unknown;
    try {
      payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      invalidResponse(transport, 'invalid_json');
    }
    const evaluation = validateEvaluation(payload, args.questions, transport);
    return {...evaluation, transport: {...transport, validatedResponse: true}};
  } catch (error) {
    if (args.signal?.aborted) throw new ProviderError('cancelled', transport);
    if (timeout.aborted) throw new ProviderError('timeout', transport);
    if (error instanceof ProviderError) throw error;
    throw new ProviderError('provider_unavailable', transport);
  }
}
