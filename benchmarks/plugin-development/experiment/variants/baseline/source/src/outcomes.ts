import {constants} from 'node:fs';
import {open, mkdir, unlink, link} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {dataDirectory} from './store.js';

const opaqueId = z.string().min(1).max(256).regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/, 'must be an opaque stable identifier');
const observedValues = z.enum(['supported', 'contradicted', 'unknown']);

/** Input is deliberately limited to references and a caller's observation. */
export const decisionOutcomeSchema = z.strictObject({
  receiptId: z.string().uuid(),
  actionId: opaqueId.optional(),
  actualActionId: opaqueId.optional(),
  evidenceIds: z.array(opaqueId).min(1).max(128).optional(),
  evidenceRefs: z.array(opaqueId).min(1).max(128).optional(),
  observed: observedValues.optional(),
  observedOutcome: observedValues.optional(),
  callerReported: z.literal(true),
  observedAt: z.string().datetime({offset: true}),
  // This is only a correlation assertion. The saved value is taken from the
  // referenced receipt transport, never from this caller field.
  providerRequestId: opaqueId.optional(),
}).refine(value => Boolean(value.actionId) !== Boolean(value.actualActionId), {
  message: 'exactly one actionId or actualActionId is required', path: ['actionId'],
}).refine(value => Boolean(value.observed) !== Boolean(value.observedOutcome), {
  message: 'exactly one observed or observedOutcome is required', path: ['observedOutcome'],
}).refine(value => Boolean(value.evidenceIds) !== Boolean(value.evidenceRefs), {
  message: 'exactly one evidenceIds or evidenceRefs is required', path: ['evidenceIds'],
}).refine(value => {
  const evidenceIds = value.evidenceIds ?? value.evidenceRefs ?? [];
  return new Set(evidenceIds).size === evidenceIds.length;
}, {
  message: 'evidence references must be unique', path: ['evidenceIds'],
});
// Short aliases keep registration code independent of the internal module
// naming while preserving one strict schema as the source of truth.
export const outcomeSchema = decisionOutcomeSchema;

export type DecisionOutcomeInput = z.input<typeof decisionOutcomeSchema>;
export type OutcomeInput = DecisionOutcomeInput;
export type DecisionOutcomeRecord = {
  schemaVersion: 1;
  outcomeId: string;
  recordedAt: string;
  receiptId: string;
  actualActionId: string;
  evidenceIds: string[];
  observedOutcome: z.infer<typeof observedValues>;
  callerReported: true;
  observedAt: string;
  providerRequestId?: string;
  provenance: {
    source: 'local_receipt_link';
    receiptId: string;
    evidenceIds: string[];
    callerClaimOnly: boolean;
    independentlyVerified: false;
  };
};
export type OutcomeRecord = DecisionOutcomeRecord;

const MAX_RECEIPT_BYTES = 65536;
const MAX_OUTCOME_BYTES = 32768;

function outcomeDirectory(directory: string): string {
  return join(directory, 'outcomes');
}

async function assertReceiptExists(directory: string, receiptId: string): Promise<{providerRequestId?: string}> {
  const path = join(directory, 'receipts', `${receiptId}.json`);
  let handle;
  try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('receipt_not_found');
    throw new Error('receipt_unavailable');
  }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_RECEIPT_BYTES) throw new Error('receipt_invalid');
    let value: unknown;
    try { value = JSON.parse(await handle.readFile('utf8')); }
    catch { throw new Error('receipt_invalid'); }
    if (!value || typeof value !== 'object' || (value as {receiptId?: unknown}).receiptId !== receiptId) throw new Error('receipt_invalid');
    const transport = (value as {transport?: unknown}).transport;
    const providerRequestId = transport && typeof transport === 'object' && typeof (transport as {providerRequestId?: unknown}).providerRequestId === 'string'
      ? (transport as {providerRequestId: string}).providerRequestId : undefined;
    return providerRequestId && opaqueId.safeParse(providerRequestId).success ? {providerRequestId} : {};
  } finally { await handle.close(); }
}

/**
 * Record a caller-reported observation against an existing local receipt.
 * The record contains references only; it never copies private context and
 * never promotes the caller's claim to independent verification.
 */
export async function recordDecisionOutcome(
  raw: unknown,
  options: {directory?: string; env?: NodeJS.ProcessEnv} = {},
): Promise<DecisionOutcomeRecord> {
  const parsed = decisionOutcomeSchema.safeParse(raw);
  if (!parsed.success) throw new Error('invalid_outcome');
  const input = parsed.data;
  const actualActionId = input.actualActionId ?? input.actionId!;
  const observedOutcome = input.observedOutcome ?? input.observed!;
  const evidenceIds = input.evidenceIds ?? input.evidenceRefs!;
  const directory = options.directory ?? dataDirectory(options.env ?? process.env);
  if (!directory || !directory.startsWith('/') || directory.includes('\0')) throw new Error('invalid_outcome_directory');
  const receipt = await assertReceiptExists(directory, input.receiptId);
  if (input.providerRequestId !== undefined && input.providerRequestId !== receipt.providerRequestId) throw new Error('provider_request_mismatch');
  await mkdir(outcomeDirectory(directory), {recursive: true, mode: 0o700});
  const outcomeId = randomUUID();
  const record: DecisionOutcomeRecord = {
    schemaVersion: 1,
    outcomeId,
    recordedAt: new Date().toISOString(),
    receiptId: input.receiptId,
    actualActionId,
    evidenceIds: [...evidenceIds],
    observedOutcome,
    callerReported: input.callerReported,
    observedAt: input.observedAt,
    ...(receipt.providerRequestId === undefined ? {} : {providerRequestId: receipt.providerRequestId}),
    provenance: {
      source: 'local_receipt_link',
      receiptId: input.receiptId,
      evidenceIds: [...evidenceIds],
      callerClaimOnly: input.callerReported,
      independentlyVerified: false,
    },
  };
  const contents = JSON.stringify(record) + '\n';
  if (Buffer.byteLength(contents) > MAX_OUTCOME_BYTES) throw new Error('outcome_too_large');
  const destination = join(outcomeDirectory(directory), `${outcomeId}.json`);
  const temporary = join(outcomeDirectory(directory), `.outcome-${randomUUID()}.tmp`);
  try {
    const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(contents); await handle.sync(); }
    finally { await handle.close(); }
    // link() publishes a complete record without replacing a prior outcome.
    await link(temporary, destination);
  } finally { await unlink(temporary).catch(() => {}); }
  return record;
}

// MCP registration uses snake_case tool names; expose the same function under
// that spelling so the server does not need an adapter that can drift from the
// strict local contract.
export const record_decision_outcome = recordDecisionOutcome;
