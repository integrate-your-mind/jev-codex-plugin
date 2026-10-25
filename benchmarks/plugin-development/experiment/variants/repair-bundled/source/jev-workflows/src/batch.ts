import { z } from 'zod';
import type { Question } from './contracts.js';

export const BATCH_RUBRIC_VERSION = 'batch-2026-09-26.2';
export const DECISION_POLICY_VERSION = 'decision-policy-2026-09-26.1';
export const INSUFFICIENT_EVIDENCE_ID = 'insufficient_evidence';
export const decisionDomains = ['tool', 'model', 'task', 'skill', 'context', 'strategy', 'result', 'general'] as const;
export type DecisionDomain = typeof decisionDomains[number];

export type JsonValue = string | number | boolean | null | JsonValue[] | {[key: string]: JsonValue};

export function isBoundedJsonStructure(value: unknown, maxDepth = 12, maxNodes = 4096): boolean {
  const pending: Array<{value: unknown; depth: number}> = [{value, depth: 0}];
  const seen = new WeakSet<object>();
  let nodes = 0;
  while (pending.length) {
    const current = pending.pop()!;
    if (++nodes > maxNodes || current.depth > maxDepth) return false;
    if (!current.value || typeof current.value !== 'object') continue;
    if (seen.has(current.value as object)) return false;
    seen.add(current.value as object);
    const children = Array.isArray(current.value) ? current.value : Object.values(current.value as Record<string, unknown>);
    for (const child of children) pending.push({value: child, depth: current.depth + 1});
  }
  return true;
}

const jsonScalarSchema = z.union([z.string().max(12000), z.number().finite(), z.boolean(), z.null()]);
export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() => z.union([
  jsonScalarSchema,
  z.array(jsonValueSchema).max(64),
  z.record(z.string().min(1).max(80), jsonValueSchema).refine(value => Object.keys(value).length <= 64, 'at most 64 object keys'),
]));

// TypeSafe accepts a string, object, array, or null for structured question
// entries. Numbers and booleans remain valid as nested JSON values.
export const structuredEntrySchema = z.union([
  z.string().max(12000),
  z.null(),
  z.array(jsonValueSchema).max(64),
  z.record(z.string().min(1).max(80), jsonValueSchema).refine(value => Object.keys(value).length <= 64, 'at most 64 object keys'),
]);
export type StructuredEntry = z.output<typeof structuredEntrySchema>;

export const opaqueIdSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,79}$/);
const reservedIds = new Set([INSUFFICIENT_EVIDENCE_ID, '__proto__', 'constructor', 'prototype']);
export function isReservedId(value: string): boolean { return reservedIds.has(value); }

export const decisionPolicySchema = z.strictObject({
  mode: z.enum(['conservative', 'ranking']).optional(),
  minConfidence: z.number().finite().min(0).max(1).optional(),
  minProbability: z.number().finite().min(0).max(1).optional(),
});
export type DecisionPolicyInput = z.output<typeof decisionPolicySchema>;
export type DecisionPolicy = {
  version: typeof DECISION_POLICY_VERSION;
  mode: 'conservative' | 'ranking';
  minConfidence: number;
  minProbability: number;
  calibration: 'not_locally_calibrated';
};

export function resolveDecisionPolicy(
  common?: DecisionPolicyInput,
  specific?: DecisionPolicyInput,
  defaults: {minConfidence?: number; minProbability?: number} = {},
): DecisionPolicy {
  return {
    version: DECISION_POLICY_VERSION,
    mode: specific?.mode ?? common?.mode ?? 'conservative',
    minConfidence: specific?.minConfidence ?? common?.minConfidence ?? defaults.minConfidence ?? 0.6,
    minProbability: specific?.minProbability ?? common?.minProbability ?? defaults.minProbability ?? 0.6,
    calibration: 'not_locally_calibrated',
  };
}

const candidateSchema = z.strictObject({
  id: opaqueIdSchema,
  description: structuredEntrySchema,
  available: z.boolean().default(true),
  metadata: structuredEntrySchema.optional(),
});

const commonQuestionFields = {
  instructions: structuredEntrySchema,
  domain: z.enum(decisionDomains).optional(),
  policy: decisionPolicySchema.optional(),
};
export const batchChoiceQuestionSchema = z.strictObject({
  type: z.literal('choice'),
  ...commonQuestionFields,
  candidates: z.array(candidateSchema).min(1).max(12),
});
export const batchNoulQuestionSchema = z.strictObject({
  type: z.literal('noul'),
  ...commonQuestionFields,
  criteria: z.strictObject({true: structuredEntrySchema, false: structuredEntrySchema}).optional(),
});
export const batchScoreQuestionSchema = z.strictObject({
  type: z.literal('score'),
  ...commonQuestionFields,
  criteria: z.array(structuredEntrySchema).min(2).max(10),
});
export const batchQuestionSchema = z.discriminatedUnion('type', [
  batchChoiceQuestionSchema,
  batchNoulQuestionSchema,
  batchScoreQuestionSchema,
]);
export type BatchQuestion = z.output<typeof batchQuestionSchema>;

const questionRecordSchema = z.record(opaqueIdSchema, batchQuestionSchema).superRefine((questions, context) => {
  const ids = Object.keys(questions);
  if (ids.length < 1 || ids.length > 32) context.addIssue({code: 'custom', message: 'questions must contain between 1 and 32 entries'});
  for (const id of ids) if (isReservedId(id)) context.addIssue({code: 'custom', message: 'reserved question id', path: [id]});
});

export const originSchema = z.strictObject({
  source: z.enum(['mcp', 'cli', 'hook', 'service', 'completion', 'unknown']),
  chatId: opaqueIdSchema.optional(),
  turnId: opaqueIdSchema.optional(),
  agentId: opaqueIdSchema.optional(),
  eventId: opaqueIdSchema.optional(),
});
export const correlationSchema = z.strictObject({
  requestId: opaqueIdSchema.optional(),
  parentDecisionId: opaqueIdSchema.optional(),
  rootTaskId: opaqueIdSchema.optional(),
});

const stateSchema = z.union([
  z.string().max(24000),
  z.array(jsonValueSchema).max(64),
  z.record(z.string().min(1).max(80), jsonValueSchema).refine(value => Object.keys(value).length <= 64, 'at most 64 state keys'),
]);

export const evaluateDecisionsSchema = z.strictObject({
  state: stateSchema,
  questions: questionRecordSchema,
  policy: decisionPolicySchema.optional(),
  origin: originSchema.optional(),
  correlation: correlationSchema.optional(),
  mode: z.enum(['preview', 'evaluate']).default('preview'),
});
export type EvaluateDecisionsInput = z.output<typeof evaluateDecisionsSchema>;

export function providerQuestions(input: EvaluateDecisionsInput): Record<string, Question> {
  return Object.fromEntries(Object.entries(input.questions).map(([id, question]) => {
    if (question.type === 'choice') {
      const criteria = Object.fromEntries(question.candidates.filter(candidate => candidate.available).map(candidate => [
        candidate.id,
        candidate.metadata === undefined ? candidate.description : {description: candidate.description, metadata: candidate.metadata},
      ]));
      criteria[INSUFFICIENT_EVIDENCE_ID] = 'The supplied state does not distinguish any available candidate well enough to support a selection.';
      return [id, {type: 'choice', instructions: question.instructions, criteria} satisfies Question];
    }
    if (question.type === 'score') return [id, {type: 'score', instructions: question.instructions, criteria: question.criteria} satisfies Question];
    return [id, {type: 'noul', instructions: question.instructions, ...(question.criteria ? {criteria: question.criteria} : {})} satisfies Question];
  }));
}

export function policiesByQuestion(input: EvaluateDecisionsInput, defaults: {minConfidence?: number; minProbability?: number} = {}): Record<string, DecisionPolicy> {
  return Object.fromEntries(Object.entries(input.questions).map(([id, question]) => [id, resolveDecisionPolicy(input.policy, question.policy, defaults)]));
}
