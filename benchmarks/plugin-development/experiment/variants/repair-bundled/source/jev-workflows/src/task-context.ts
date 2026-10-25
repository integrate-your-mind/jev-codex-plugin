import {constants} from 'node:fs';
import {link, mkdir, open, realpath, rename, stat, unlink, readFile} from 'node:fs/promises';
import {randomUUID, createHash} from 'node:crypto';
import {isAbsolute, join} from 'node:path';
import {z} from 'zod';
import {dataDirectory} from './store.js';
import {redactText} from './redact.js';
import {readCredentialFile} from './credential.js';
import {setTimeout as delay} from 'node:timers/promises';

/** The on-disk record is deliberately versioned so callers can evolve it without
 * treating an old task summary as a current goal. */
export const TASK_CONTEXT_VERSION = 1 as const;
const MAX_TEXT_BYTES = 1_500;
const MAX_INPUT_TEXT_BYTES = 12_000;
const MAX_ITEMS = 12;
const MAX_HISTORY = 8;
const MAX_EVIDENCE_REFS = 24;
const CONTEXT_DIRECTORY = 'task-context-v1';
const CONTEXT_LOCK_STALE_MS = 30_000;
const CONTEXT_LOCK_ATTEMPTS = 200;
const CONTEXT_LOCK_WAIT_MS = 10;

const identifier = z.string().min(1).max(256);
export const taskContextScopeSchema = z.strictObject({
  cwd: identifier,
  sessionId: identifier,
  agentId: identifier.optional(),
});

export const taskContextProvenanceSchema = z.strictObject({
  source: z.enum(['user_prompt', 'hook', 'mcp', 'parent', 'agent', 'system']),
  timestamp: z.string().datetime({offset: true}),
  eventId: z.string().max(256).optional(),
  turnId: z.string().max(256).optional(),
  agentId: z.string().max(256).optional(),
  operation: z.enum(['continue', 'replace', 'reset']),
});

export const taskContextItemSchema = z.strictObject({
  value: z.string().min(1).max(MAX_TEXT_BYTES),
  provenance: taskContextProvenanceSchema,
});

export const taskEvidenceRefSchema = z.strictObject({
  id: z.string().regex(/^[a-zA-Z0-9._:-]{1,80}$/),
  source: z.string().max(300).optional(),
  summary: z.string().max(MAX_TEXT_BYTES).optional(),
  provenance: taskContextProvenanceSchema,
});

export const taskCandidateSchema = z.strictObject({
  id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,79}$/),
  description: z.string().min(1).max(MAX_TEXT_BYTES),
  available: z.boolean().default(true),
  metadata: z.record(z.string().regex(/^[a-zA-Z0-9_.-]{1,40}$/), z.union([z.string().max(500), z.number().finite(), z.boolean()])).optional(),
});
const taskCandidateCatalogShape = z.partialRecord(
  z.enum(['tool', 'model', 'task', 'skill', 'context', 'strategy', 'result']),
  z.array(taskCandidateSchema).max(12),
);
export const taskCandidateCatalogSchema = taskCandidateCatalogShape.default({});

export const taskContextRecordSchema = z.strictObject({
  version: z.literal(TASK_CONTEXT_VERSION),
  scope: z.strictObject({
    workspaceHash: z.string().length(64),
    sessionHash: z.string().length(64),
    agentHash: z.string().length(64),
  }),
  rootObjective: taskContextItemSchema.nullable(),
  latestStep: taskContextItemSchema.nullable(),
  followUps: z.array(taskContextItemSchema).max(MAX_ITEMS),
  constraints: z.array(taskContextItemSchema).max(MAX_ITEMS),
  criteria: z.array(taskContextItemSchema).max(MAX_ITEMS),
  corrections: z.array(taskContextItemSchema).max(MAX_ITEMS),
  evidenceRefs: z.array(taskEvidenceRefSchema).max(MAX_EVIDENCE_REFS),
  candidateCatalogs: taskCandidateCatalogSchema,
  history: z.array(taskContextItemSchema).max(MAX_HISTORY),
  updatedAt: z.string().datetime({offset: true}),
  provenance: taskContextProvenanceSchema,
});

export type TaskContextScope = z.input<typeof taskContextScopeSchema>;
export type TaskContextProvenance = z.input<typeof taskContextProvenanceSchema>;
export type TaskContextItem = z.input<typeof taskContextItemSchema>;
export type TaskEvidenceRef = z.input<typeof taskEvidenceRefSchema>;
export type TaskContextRecord = z.output<typeof taskContextRecordSchema>;

export const taskContextUpdateSchema = z.strictObject({
  operation: z.enum(['continue', 'replace', 'reset']).default('continue'),
  rootObjective: z.string().min(1).max(MAX_INPUT_TEXT_BYTES).optional(),
  latestStep: z.string().min(1).max(MAX_INPUT_TEXT_BYTES).optional(),
  followUp: z.string().min(1).max(MAX_INPUT_TEXT_BYTES).optional(),
  constraints: z.array(z.string().min(1).max(MAX_INPUT_TEXT_BYTES)).max(MAX_ITEMS).optional(),
  criteria: z.array(z.string().min(1).max(MAX_INPUT_TEXT_BYTES)).max(MAX_ITEMS).optional(),
  corrections: z.array(z.string().min(1).max(MAX_INPUT_TEXT_BYTES)).max(MAX_ITEMS).optional(),
  evidenceRefs: z.array(z.strictObject({
    id: z.string().regex(/^[a-zA-Z0-9._:-]{1,80}$/),
    source: z.string().max(300).optional(),
    summary: z.string().max(MAX_INPUT_TEXT_BYTES).optional(),
  })).max(MAX_EVIDENCE_REFS).optional(),
  candidateCatalogs: taskCandidateCatalogShape.optional(),
  provenance: taskContextProvenanceSchema.omit({timestamp: true, operation: true}).extend({
    timestamp: z.string().datetime({offset: true}).optional(),
    operation: z.enum(['continue', 'replace', 'reset']).optional(),
  }).optional(),
});
export type TaskContextUpdate = z.input<typeof taskContextUpdateSchema>;
/** Input shape suitable for a host-owned MCP adapter. The adapter supplies the
 * current workspace/session explicitly; this module never infers a parent. */
export const updateTaskContextInputSchema = z.strictObject({
  scope: taskContextScopeSchema,
  update: taskContextUpdateSchema,
});
export type UpdateTaskContextInput = z.input<typeof updateTaskContextInputSchema>;

export type TaskContextOptions = {
  env?: NodeJS.ProcessEnv;
  now?: Date;
};

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function currentSecrets(env: NodeJS.ProcessEnv): string[] {
  const fileSecret = env.JEV_API_KEY_FILE ? readCredentialFile(env.JEV_API_KEY_FILE) : null;
  return [env.TYPESAFE_API_KEY, fileSecret].filter((value): value is string => Boolean(value));
}

function clip(value: string, maxBytes = MAX_TEXT_BYTES, secrets: string[] = []): string {
  const redacted = redactText(value, secrets);
  if (Buffer.byteLength(redacted) <= maxBytes) return redacted;
  const marker = '\n...[truncated]...\n';
  const markerBytes = Buffer.byteLength(marker);
  const available = Math.max(2, maxBytes - markerBytes);
  const headBytes = Math.ceil(available * 0.6);
  const tailBytes = available - headBytes;
  const source = Buffer.from(redacted);
  let headEnd = Math.min(headBytes, source.length);
  while (headEnd > 0 && ((source[headEnd] ?? 0) & 0xc0) === 0x80) headEnd--;
  let tailStart = Math.max(0, source.length - tailBytes);
  while (tailStart < source.length && ((source[tailStart] ?? 0) & 0xc0) === 0x80) tailStart++;
  return `${source.subarray(0, headEnd).toString('utf8')}${marker}${source.subarray(tailStart).toString('utf8')}`;
}

function safeScope(scope: TaskContextScope): {cwd: string; workspaceHash: string; sessionHash: string; agentHash: string} | undefined {
  if (!taskContextScopeSchema.safeParse(scope).success) return undefined;
  if (!isAbsolute(scope.cwd) || scope.cwd.includes('\0')) return undefined;
  return {cwd: scope.cwd, workspaceHash: digest(scope.cwd), sessionHash: digest(scope.sessionId), agentHash: digest(scope.agentId ?? 'root')};
}

async function contextPath(scope: TaskContextScope, env: NodeJS.ProcessEnv, create = false): Promise<{path: string; directory: string; scope: ReturnType<typeof safeScope>} | undefined> {
  const resolved = safeScope(scope);
  if (!resolved) return undefined;
  const directory = dataDirectory(env);
  if (!isAbsolute(directory) || directory.includes('\0')) return undefined;
  try {
    const workspace = await realpath(scope.cwd);
    const scopedDirectory = join(directory, CONTEXT_DIRECTORY, digest(workspace), resolved.sessionHash, resolved.agentHash);
    if (create) await mkdir(scopedDirectory, {recursive: true, mode: 0o700});
    return {path: join(scopedDirectory, 'context.json'), directory: scopedDirectory, scope: {...resolved, workspaceHash: digest(workspace)}};
  } catch {
    return undefined;
  }
}

function initialRecord(scope: NonNullable<ReturnType<typeof safeScope>>, provenance: TaskContextProvenance, now: Date): TaskContextRecord {
  return {
    version: TASK_CONTEXT_VERSION,
    scope: {workspaceHash: scope.workspaceHash, sessionHash: scope.sessionHash, agentHash: scope.agentHash},
    rootObjective: null,
    latestStep: null,
    followUps: [],
    constraints: [],
    criteria: [],
    corrections: [],
    evidenceRefs: [],
    candidateCatalogs: {},
    history: [],
    updatedAt: now.toISOString(),
    provenance,
  };
}

function sanitizeCatalog(value: TaskContextUpdate['candidateCatalogs'], secrets: string[]): TaskContextRecord['candidateCatalogs'] {
  const output: TaskContextRecord['candidateCatalogs'] = {};
  if (!value) return output;
  for (const [domain, candidates] of Object.entries(value)) {
    output[domain as keyof typeof output] = candidates.slice(0, 12).map(candidate => ({
      id: clip(candidate.id, 80, secrets),
      description: clip(candidate.description, MAX_TEXT_BYTES, secrets),
      available: candidate.available !== false,
      ...(candidate.metadata ? {metadata: Object.fromEntries(Object.entries(candidate.metadata).slice(0, 16).map(([key, item]) => [clip(key, 40, secrets), typeof item === 'string' ? clip(item, 500, secrets) : item]))} : {}),
    }));
  }
  return output;
}

function item(value: string, provenance: TaskContextProvenance, secrets: string[]): TaskContextItem {
  return {value: clip(value, MAX_TEXT_BYTES, secrets), provenance};
}

function boundedItems(values: TaskContextItem[] | undefined): TaskContextItem[] {
  return (values ?? []).slice(-MAX_ITEMS);
}

function provenanceFor(update: TaskContextUpdate, scope: TaskContextScope, now: Date, secrets: string[]): TaskContextProvenance {
  const supplied = update.provenance;
  return {
    source: supplied?.source ?? 'system',
    timestamp: supplied?.timestamp ?? now.toISOString(),
    ...(supplied?.eventId === undefined ? {} : {eventId: clip(supplied.eventId, 256, secrets)}),
    ...(supplied?.turnId === undefined ? {} : {turnId: clip(supplied.turnId, 256, secrets)}),
    ...(supplied?.agentId === undefined && scope.agentId === undefined ? {} : {agentId: clip(supplied?.agentId ?? scope.agentId!, 256, secrets)}),
    operation: update.operation ?? supplied?.operation ?? 'continue',
  };
}

async function writeRecord(path: string, directory: string, record: TaskContextRecord): Promise<void> {
  const temporary = join(directory, `.context-${randomUUID()}.tmp`);
  const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(JSON.stringify(record) + '\n', 'utf8'); } finally { await handle.close(); }
  try { await rename(temporary, path); } finally { await unlink(temporary).catch(() => {}); }
}

type ContextLock = {path: string; token: string};

async function processIsAlive(pid: number): Promise<boolean> {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}

async function reclaimStaleContextLock(path: string): Promise<void> {
  let info;
  try { info = await stat(path); }
  catch { return; }
  if (Date.now() - info.mtimeMs < CONTEXT_LOCK_STALE_MS) return;
  let owner: {pid?: unknown; token?: unknown};
  try { owner = JSON.parse(await readFile(path, 'utf8')) as {pid?: unknown; token?: unknown}; }
  catch { return; }
  if (!Number.isInteger(owner.pid) || typeof owner.token !== 'string' || await processIsAlive(owner.pid as number)) return;
  await unlink(path).catch(() => {});
}

/** Publish the lock only after its metadata is complete, preventing a crash
 * between O_EXCL creation and metadata write from leaving an unreclaimable
 * empty lock behind. */
async function acquireContextLock(path: string, directory: string): Promise<ContextLock | undefined> {
  for (let attempt = 0; attempt < CONTEXT_LOCK_ATTEMPTS; attempt++) {
    const token = randomUUID();
    const temporary = join(directory, `.context-lock-${token}.tmp`);
    try {
      const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      try { await handle.writeFile(JSON.stringify({pid: process.pid, token, createdAt: new Date().toISOString()})); await handle.sync(); }
      finally { await handle.close(); }
      try {
        await link(temporary, path);
        return {path, token};
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return undefined;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return undefined;
    } finally { await unlink(temporary).catch(() => {}); }
    await reclaimStaleContextLock(path);
    await delay(CONTEXT_LOCK_WAIT_MS);
  }
  return undefined;
}

async function releaseContextLock(lock: ContextLock): Promise<void> {
  try {
    const owner = JSON.parse(await readFile(lock.path, 'utf8')) as {token?: unknown};
    if (owner.token === lock.token) await unlink(lock.path);
  } catch { /* preserve a lock owned by a different writer */ }
}

export async function loadTaskContext(scope: TaskContextScope, options: TaskContextOptions = {}): Promise<TaskContextRecord | undefined> {
  const target = await contextPath(scope, options.env ?? process.env);
  if (!target) return undefined;
  try {
    const handle = await open(target.path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > 64 * 1024) return undefined;
      const parsed = taskContextRecordSchema.safeParse(JSON.parse(await handle.readFile('utf8')));
      if (!parsed.success) return undefined;
      if (parsed.data.scope.workspaceHash !== target.scope!.workspaceHash || parsed.data.scope.sessionHash !== target.scope!.sessionHash || parsed.data.scope.agentHash !== target.scope!.agentHash) return undefined;
      return parsed.data;
    } finally { await handle.close(); }
  } catch { return undefined; }
}

/**
 * Apply a local context update. `replace` is an explicit new goal and clears
 * accumulated constraints/criteria; `reset` leaves a versioned empty record so
 * a stale parent or previous turn cannot silently repopulate this scope.
 */
export async function updateTaskContext(scope: TaskContextScope, update: TaskContextUpdate, options: TaskContextOptions = {}): Promise<TaskContextRecord | undefined> {
  const parsed = taskContextUpdateSchema.safeParse(update);
  if (!parsed.success) return undefined;
  const env = options.env ?? process.env;
  const target = await contextPath(scope, env, true);
  if (!target || !target.scope) return undefined;
  const now = options.now ?? new Date();
  const operation = parsed.data.operation ?? 'continue';
  const secrets = currentSecrets(env);
  const provenance = provenanceFor(parsed.data, scope, now, secrets);
  const lockPath = join(target.directory, '.context.lock');
  const lock = await acquireContextLock(lockPath, target.directory);
  if (!lock) return undefined;
  try {
    const prior = await loadTaskContext(scope, options);
    let next = prior ?? initialRecord(target.scope, provenance, now);
    if (operation === 'reset') {
      next = initialRecord(target.scope, provenance, now);
    } else if (operation === 'replace') {
      if (next.rootObjective) next.history = [...next.history, next.rootObjective].slice(-MAX_HISTORY);
      next.rootObjective = parsed.data.rootObjective ? item(parsed.data.rootObjective, provenance, secrets) : null;
      next.latestStep = parsed.data.latestStep ? item(parsed.data.latestStep, provenance, secrets) : null;
      next.followUps = parsed.data.followUp ? [item(parsed.data.followUp, provenance, secrets)] : [];
      next.constraints = boundedItems((parsed.data.constraints ?? []).map(value => item(value, provenance, secrets)));
      next.criteria = boundedItems((parsed.data.criteria ?? []).map(value => item(value, provenance, secrets)));
      next.corrections = boundedItems((parsed.data.corrections ?? []).map(value => item(value, provenance, secrets)));
      next.evidenceRefs = (parsed.data.evidenceRefs ?? []).slice(-MAX_EVIDENCE_REFS).map(ref => ({...ref, ...(ref.summary ? {summary: clip(ref.summary, MAX_TEXT_BYTES, secrets)} : {}), provenance}));
      next.candidateCatalogs = sanitizeCatalog(parsed.data.candidateCatalogs, secrets);
    } else {
      if (parsed.data.rootObjective) {
        if (!next.rootObjective) next.rootObjective = item(parsed.data.rootObjective, provenance, secrets);
        else next.latestStep = item(parsed.data.rootObjective, provenance, secrets);
      }
      if (parsed.data.latestStep) next.latestStep = item(parsed.data.latestStep, provenance, secrets);
      if (parsed.data.followUp) next.followUps = [...next.followUps, item(parsed.data.followUp, provenance, secrets)].slice(-MAX_ITEMS);
      if (parsed.data.constraints) next.constraints = boundedItems([...next.constraints, ...parsed.data.constraints.map(value => item(value, provenance, secrets))]);
      if (parsed.data.criteria) next.criteria = boundedItems([...next.criteria, ...parsed.data.criteria.map(value => item(value, provenance, secrets))]);
      if (parsed.data.corrections) next.corrections = boundedItems([...next.corrections, ...parsed.data.corrections.map(value => item(value, provenance, secrets))]);
      if (parsed.data.evidenceRefs) next.evidenceRefs = [...next.evidenceRefs, ...parsed.data.evidenceRefs.map(ref => ({...ref, ...(ref.summary ? {summary: clip(ref.summary, MAX_TEXT_BYTES, secrets)} : {}), provenance}))].slice(-MAX_EVIDENCE_REFS);
      if (parsed.data.candidateCatalogs) next.candidateCatalogs = sanitizeCatalog(parsed.data.candidateCatalogs, secrets);
    }
    next.version = TASK_CONTEXT_VERSION;
    next.scope = {workspaceHash: target.scope.workspaceHash, sessionHash: target.scope.sessionHash, agentHash: target.scope.agentHash};
    next.updatedAt = now.toISOString();
    next.provenance = provenance;
    const valid = taskContextRecordSchema.safeParse(next);
    if (!valid.success) return undefined;
    await writeRecord(target.path, target.directory, valid.data);
    return valid.data;
  } finally {
    await releaseContextLock(lock);
  }
}

export async function resetTaskContext(scope: TaskContextScope, options: TaskContextOptions = {}): Promise<TaskContextRecord | undefined> {
  return updateTaskContext(scope, {operation: 'reset', provenance: {source: 'mcp'}}, options);
}
