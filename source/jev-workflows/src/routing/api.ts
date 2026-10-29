import {createHash, randomUUID} from 'node:crypto';
import {lstat, mkdir} from 'node:fs/promises';
import {isAbsolute, join} from 'node:path';
import {z} from 'zod';
import {decisionSchema} from '../decision.js';
import {decisionDomains} from '../batch.js';
import type {DecisionAssessment, DecisionInput, DecisionService} from '../decision-hook.js';
import {consultCandidateCatalog} from '../routing-consultation.js';
import {dataDirectory} from '../store.js';
import {updateTaskContext, updateTaskContextInputSchema, type TaskContextRecord} from '../task-context.js';
import {redactText} from '../redact.js';
import {readCredentialFile} from '../credential.js';
import {sanitizeCandidateMetadata} from '../candidate-metadata.js';
import {ROUTING_SCHEMA_VERSION, sameProfile, type CatalogSnapshot, type DecisionProposal, type DeliveryObservation, type HostCapabilities, type ModelEffortProfile, type RoutingRecord, type RoutingScope, type TaskRevision} from './contracts.js';
import {RoutingStateStore} from './state.js';

const identifier = z.string().min(1).max(256).refine(value => !value.includes('\0'));
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const profileSchema = z.strictObject({providerId: identifier, modelId: identifier, effort: identifier});
export const routingScopeSchema = z.strictObject({hostId: identifier, accountId: identifier, workspaceId: digestSchema, sessionId: digestSchema, agentId: digestSchema});
export const catalogRefSchema = z.strictObject({
  schemaVersion: z.literal(ROUTING_SCHEMA_VERSION), scope: routingScopeSchema,
  catalogId: digestSchema, digest: digestSchema, taskRevisionId: digestSchema, capabilityId: digestSchema,
});
export type CatalogRef = z.output<typeof catalogRefSchema>;

const coverageSchema = z.strictObject({
  discovery: z.enum(['complete_supported_inventory', 'partial']),
  pages: z.number().int().nonnegative(), inaccessibleCategories: z.array(identifier).default([]),
});
const routingUpdateSchema = z.strictObject({
  hostId: identifier, accountId: identifier, sourceRevision: identifier,
  coverage: coverageSchema.optional(),
  capabilities: z.strictObject({
    sourceRevision: identifier, status: z.enum(['known', 'unknown']),
    profileSwitch: z.enum(['supported', 'unsupported', 'unknown']), orderedPreDispatch: z.boolean(),
    eligibleProfiles: z.array(profileSchema), inaccessibleCategories: z.array(identifier).default([]),
  }).optional(),
  task: z.strictObject({
    factsRevision: identifier.optional(), evidenceRevision: identifier.optional(),
    observedFailureIds: z.array(identifier).default([]), unknowns: z.array(z.string().max(1500)).default([]),
    pendingToolCycle: z.boolean().default(false), completedSubtask: z.boolean().default(false),
    pin: profileSchema.optional(), currentProfile: profileSchema.optional(),
  }).optional(),
});
export const routingUpdateTaskContextInputSchema = updateTaskContextInputSchema.extend({routing: routingUpdateSchema.optional()});
export const routingDecisionSchema = z.union([
  decisionSchema,
  decisionSchema.omit({candidates: true}).extend({catalogRef: catalogRefSchema}),
]);
export const routingStatusInputSchema = z.strictObject({fullReceiptScan: z.boolean().default(false), routingScope: routingScopeSchema.optional()});

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
  return value;
}
function digest(value: unknown): string {return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');}
function catalogDigest(record: CatalogSnapshot): string {
  const {expiresAt: _expiresAt, ...content} = record;
  return digest(content);
}
function reasonFor(error: unknown): string {
  if (error instanceof z.ZodError) return 'invalid_catalog_record';
  const codes = ['unsafe_routing_directory', 'unsafe_routing_metadata', 'unsafe_catalog_metadata', 'duplicate_catalog_ids', 'catalog_ref_not_found', 'catalog_ref_expired', 'catalog_ref_digest_mismatch', 'catalog_ref_dependencies_unavailable', 'stale_task_revision'];
  return error instanceof Error && codes.includes(error.message) ? error.message : 'routing_state_unavailable';
}
function profileFor(metadata: Readonly<Record<string, string | number | boolean>> | undefined): ModelEffortProfile | undefined {
  const parsed = profileSchema.safeParse({providerId: metadata?.providerId, modelId: metadata?.modelId, effort: metadata?.effort});
  return parsed.success ? parsed.data : undefined;
}
function eligibleProfile(metadata: Readonly<Record<string, string | number | boolean>> | undefined, capabilities: HostCapabilities, task: TaskRevision): boolean {
  const profile = profileFor(metadata);
  return !!profile && capabilities.status === 'known' && capabilities.eligibleProfiles.some(eligible => sameProfile(eligible, profile)) && (!task.pin || sameProfile(task.pin, profile));
}
function publicAssessment(result: DecisionAssessment): DecisionAssessment & Record<string, unknown> {
  if (result.coverage?.method !== 'paged_reduction') return result;
  const {probabilities: _probabilities, confidence: _confidence, bestCandidate: _bestCandidate, ...advice} = result as DecisionAssessment & Record<string, unknown>;
  return {...advice, comparisonScope: 'paged_advisory_reduction', probabilityScope: 'omitted_page_local_values'};
}
const catalogEntrySchema = z.strictObject({
  id: z.string().min(1).max(100), category: z.enum(decisionDomains), description: z.string().min(1).max(1500),
  available: z.boolean(), source: z.literal('caller_scoped_mcp'),
  metadata: decisionSchema.shape.candidates.element.shape.metadata.optional(),
});
const catalogSnapshotSchema = z.object({
  schemaVersion: z.literal(ROUTING_SCHEMA_VERSION), id: digestSchema, kind: z.literal('catalog_snapshot'),
  scope: routingScopeSchema, sourceRevision: identifier, createdAt: z.string().datetime({offset: true}),
  retention: z.literal('facts'), expiresAt: z.string().datetime({offset: true}).optional(),
  entries: z.array(catalogEntrySchema), coverage: coverageSchema.extend({inventoryCount: z.number().int().nonnegative()}),
});

export function createRoutingApi(options: {service: DecisionService; env?: NodeJS.ProcessEnv; now?: () => Date; deadlineMs?: number}) {
  const env = options.env ?? process.env;
  const now = options.now ?? (() => new Date());
  const directory = dataDirectory(env);
  const deadlineMs = Math.min(Math.max(options.deadlineMs ?? 5000, 1), 5000);
  const storeFor = (scope: RoutingScope, readOnly = false) => new RoutingStateStore({stateDirectory: directory, scope, now, ...(readOnly ? {readOnly: true} : {})});
  async function privateState(create = false): Promise<void> {
    if (!isAbsolute(directory) || directory.includes('\0')) throw new Error('unsafe_routing_directory');
    if (create) await mkdir(directory, {recursive: true, mode: 0o700});
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) throw new Error('unsafe_routing_directory');
  }
  function safeMetadata(value: unknown): void {
    const key = env.JEV_API_KEY_FILE ? readCredentialFile(env.JEV_API_KEY_FILE) : null;
    const secrets = [env.TYPESAFE_API_KEY, key].filter((item): item is string => Boolean(item));
    const text = JSON.stringify(value);
    if (redactText(text, secrets) !== text) throw new Error('unsafe_routing_metadata');
  }
  function scopeFor(context: TaskContextRecord, input: z.output<typeof routingUpdateSchema>): RoutingScope {
    return {hostId: input.hostId, accountId: input.accountId, workspaceId: context.scope.workspaceHash, sessionId: context.scope.sessionHash, agentId: context.scope.agentHash};
  }
  function base(scope: RoutingScope, kind: string, retention: 'facts' | 'metadata'): RoutingRecord {
    return {schemaVersion: ROUTING_SCHEMA_VERSION, id: digest(randomUUID()), kind, scope, createdAt: now().toISOString(), retention};
  }
  async function publishContext(context: TaskContextRecord, input: z.output<typeof routingUpdateSchema>) {
    await privateState(true);
    safeMetadata(input);
    const scope = scopeFor(context, input);
    const store = storeFor(scope);
    await store.prune();
    const current = await store.current();
    const entries = Object.entries(context.candidateCatalogs).flatMap(([category, candidates]) => candidates.map(candidate => ({...candidate, id: `${category}:${candidate.id}`, category, source: 'caller_scoped_mcp' as const})));
    if (new Set(entries.map(entry => entry.id)).size !== entries.length) throw new Error('duplicate_catalog_ids');
    const coverage = {...(input.coverage ?? {discovery: 'partial' as const, pages: 0, inaccessibleCategories: []}), inventoryCount: entries.length};
    const content = {...base(scope, 'catalog_snapshot', 'facts'), sourceRevision: input.sourceRevision, entries, coverage};
    const catalog = await store.publish({...content, id: digest(content), kind: 'catalog_snapshot'} as CatalogSnapshot);
    const capabilities = await store.publish({
      ...base(scope, 'host_capabilities', 'facts'), kind: 'host_capabilities',
      ...(input.capabilities ?? {sourceRevision: input.sourceRevision, status: 'unknown', profileSwitch: 'unknown', orderedPreDispatch: false, eligibleProfiles: [], inaccessibleCategories: []}),
    } as HostCapabilities);
    const previous = current.records.task ? await store.read<TaskRevision>(current.records.task) : null;
    const task = await store.publish({
      ...base(scope, 'task_revision', 'facts'), kind: 'task_revision', revision: (previous?.revision ?? 0) + 1,
      factsRevision: input.task?.factsRevision ?? digest(context), objective: context.rootObjective?.value ?? '', subtask: context.latestStep?.value ?? '',
      sourceRevision: input.sourceRevision, evidenceRevision: input.task?.evidenceRevision ?? digest(context.evidenceRefs), catalogId: catalog.id,
      observedFailureIds: input.task?.observedFailureIds ?? [], pendingToolCycle: input.task?.pendingToolCycle ?? false,
      completedSubtask: input.task?.completedSubtask ?? false, unknowns: input.task?.unknowns ?? [],
      ...(input.task?.pin ? {pin: input.task.pin} : {}), ...(input.task?.currentProfile ? {currentProfile: input.task.currentProfile} : {}),
      dependsOn: [catalog.id, capabilities.id],
    } as TaskRevision);
    const commit = await store.compareAndSet(current.revision, {catalog: catalog.id, capabilities: capabilities.id, task: task.id});
    if (commit.status === 'conflict') return {status: 'unavailable', reasonCode: 'routing_state_conflict'};
    const catalogRef: CatalogRef = {schemaVersion: ROUTING_SCHEMA_VERSION, scope, catalogId: catalog.id, digest: catalogDigest(catalog), taskRevisionId: task.id, capabilityId: capabilities.id};
    return {status: 'published', schemaVersion: ROUTING_SCHEMA_VERSION, revision: commit.current.revision, catalogRef,
      coverage: {...coverage, source: 'caller_scoped_mcp', outsideSupportedInventory: 'unknown', knowledge: input.coverage ? 'caller_reported' : 'unknown'},
      capabilities: {source: 'caller_reported', profileSwitch: capabilities.profileSwitch, application: 'not_supported_by_mcp'},
      proposal: null, delivery: {status: 'not_attempted'}, application: {status: 'not_attempted'}, execution: {status: 'unknown'}};
  }
  async function update(raw: unknown) {
    const input = routingUpdateTaskContextInputSchema.parse(raw);
    const context = await updateTaskContext(input.scope, input.update, {env, now: now()});
    if (!context) return {status: 'unavailable', reasonCode: 'task_context_unavailable'};
    if (!input.routing) return {status: 'updated', context};
    try {return {status: 'updated', context, routing: await publishContext(context, input.routing)};}
    catch (error) {return {status: 'updated', context, routing: {status: 'unavailable', reasonCode: reasonFor(error)}};}
  }
  async function resolveRef(ref: CatalogRef) {
    await privateState();
    const store = storeFor(ref.scope);
    const stored = await store.read<CatalogSnapshot>(ref.catalogId, {includeExpired: true});
    if (!stored) throw new Error('catalog_ref_not_found');
    const catalog = catalogSnapshotSchema.parse(stored) as CatalogSnapshot;
    if (catalog.expiresAt && Date.parse(catalog.expiresAt) <= now().getTime()) throw new Error('catalog_ref_expired');
    if (catalogDigest(catalog) !== ref.digest) throw new Error('catalog_ref_digest_mismatch');
    if (catalog.entries.some(entry => JSON.stringify(entry.metadata ?? {}) !== JSON.stringify(sanitizeCandidateMetadata(entry.metadata, value => value)))) throw new Error('unsafe_catalog_metadata');
    safeMetadata(catalog.entries);
    const [current, task, capabilities] = await Promise.all([store.current(), store.read<TaskRevision>(ref.taskRevisionId), store.read<HostCapabilities>(ref.capabilityId)]);
    if (!task || !capabilities || task.kind !== 'task_revision' || capabilities.kind !== 'host_capabilities') throw new Error('catalog_ref_dependencies_unavailable');
    if (current.records.catalog !== ref.catalogId || current.records.task !== ref.taskRevisionId || current.records.capabilities !== ref.capabilityId || task.catalogId !== ref.catalogId) throw new Error('stale_task_revision');
    return {store, catalog, current, task, capabilities};
  }
  async function boundedConsult(input: DecisionInput, signal?: AbortSignal): Promise<DecisionAssessment> {
    const controller = new AbortController();
    const deadline = Date.now() + deadlineMs;
    const service: DecisionService = {async classifyDecision(question, cancellation) {
      if (Date.now() >= deadline) return {status: 'unavailable', reasonCode: 'timeout'};
      const result = await options.service.classifyDecision(question, cancellation);
      return Date.now() >= deadline ? {status: 'unavailable', reasonCode: 'timeout'} : result;
    }};
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancelled: (() => void) | undefined;
    const stopped = new Promise<DecisionAssessment>(resolve => {
      cancelled = () => {controller.abort(signal?.reason); resolve({status: 'unavailable', reasonCode: 'cancelled'});};
      if (signal?.aborted) cancelled(); else signal?.addEventListener('abort', cancelled, {once: true});
      timer = setTimeout(() => {controller.abort(new Error('routing_deadline')); resolve({status: 'unavailable', reasonCode: 'timeout'});}, deadlineMs);
    });
    try {return await Promise.race([consultCandidateCatalog(input, service, controller.signal), stopped]);}
    finally {if (timer) clearTimeout(timer); if (cancelled) signal?.removeEventListener('abort', cancelled);}
  }
  async function classify(raw: unknown, signal?: AbortSignal): Promise<DecisionAssessment & Record<string, unknown>> {
    if (!raw || typeof raw !== 'object' || !('catalogRef' in raw)) return options.service.classifyDecision(raw as DecisionInput, signal);
    const parsed = routingDecisionSchema.safeParse(raw);
    if (!parsed.success || !('catalogRef' in parsed.data)) return {status: 'skipped', reasonCode: 'invalid_input'};
    const {catalogRef, ...question} = parsed.data;
    try {
      const resolved = await resolveRef(catalogRef);
      const {store, catalog, task, capabilities} = resolved;
      const entries = catalog.entries.filter(entry => entry.category === question.domain);
      const candidates = entries.map(entry => ({
        id: entry.id.slice(entry.category.length + 1), description: entry.description,
        available: entry.available && (question.domain !== 'model' || eligibleProfile(entry.metadata, capabilities, task)),
        ...(entry.metadata ? {metadata: {...entry.metadata}} : {}),
      }));
      const result = publicAssessment(await boundedConsult({...question, candidates}, signal));
      await resolveRef(catalogRef);
      const coverage = {catalogId: catalog.id, inventoryCount: catalog.coverage.inventoryCount, domainInventoryCount: entries.length,
        discovery: catalog.coverage.discovery, source: 'caller_scoped_mcp', inaccessibleCategories: catalog.coverage.inaccessibleCategories,
        outsideSupportedInventory: 'unknown', ...(result.coverage ? {comparison: result.coverage} : {})};
      if (question.mode === 'preview') return {...result, routing: {schemaVersion: ROUTING_SCHEMA_VERSION, catalogRef, coverage, proposal: null, delivery: {status: 'prepared'}, application: {status: 'not_attempted', reasonCode: 'mcp_has_no_host_actuator'}, execution: {status: 'unknown'}, outcome: {status: 'unknown'}}};
      const selected = result.status === 'assessed' ? entries.find(entry => entry.id === `${question.domain}:${result.choice}`) : undefined;
      const providerReceiptIds = (result.coverage as {receiptIds?: readonly string[]} | undefined)?.receiptIds;
      const proposal = await store.publish({
        ...base(catalogRef.scope, 'decision_proposal', 'metadata'), kind: 'decision_proposal', taskRevision: task.revision,
        factsRevision: task.factsRevision, catalogId: catalog.id, capabilityRevision: capabilities.sourceRevision,
        targetIds: selected ? [selected.id] : [], disposition: selected ? 'selected' : 'abstained',
        ...(selected && question.domain === 'model' && profileFor(selected.metadata) ? {recommendedProfile: profileFor(selected.metadata)} : {}),
        ...(result.receiptPersisted && result.receiptId ? {providerReceiptId: result.receiptId} : {}),
        ...(providerReceiptIds ? {providerReceiptIds} : {}),
        dependsOn: [catalog.id, task.id, capabilities.id],
      } as DecisionProposal);
      const delivery = await store.publish({...base(catalogRef.scope, 'delivery_observation', 'metadata'), kind: 'delivery_observation', proposalId: proposal.id,
        deliveryId: randomUUID(), channel: 'mcp_response_prepared', status: 'unknown', dependsOn: [proposal.id]} as DeliveryObservation);
      const current = await store.current();
      if (current.records.task !== task.id || current.records.catalog !== catalog.id || current.records.capabilities !== capabilities.id) return {status: 'unavailable', reasonCode: 'stale_task_revision'};
      const commit = await store.compareAndSet(current.revision, {...current.records, proposal: proposal.id, delivery: delivery.id});
      if (commit.status === 'conflict') return {status: 'unavailable', reasonCode: 'stale_task_revision'};
      return {...result, routing: {schemaVersion: ROUTING_SCHEMA_VERSION, catalogRef, coverage, proposal: {id: proposal.id, disposition: proposal.disposition},
        delivery: {status: 'prepared', observationId: delivery.id, acknowledgment: 'unknown'},
        application: {status: 'not_attempted', reasonCode: 'mcp_has_no_host_actuator'}, execution: {status: 'unknown'}, outcome: {status: 'unknown'}}};
    } catch (error) {return {status: 'unavailable', reasonCode: reasonFor(error)};}
  }
  async function status(scope?: RoutingScope) {
    const support = {schemaVersion: ROUTING_SCHEMA_VERSION, catalogs: 'caller_scoped_only', inventoryCoverage: 'unknown',
      profileApplication: 'unsupported', automaticModelRouting: 'undelivered', execution: 'unknown', independentOutcome: 'unknown'};
    if (!scope) return support;
    try {
      await privateState();
      routingScopeSchema.parse(scope);
      const scopeId = digest([scope.hostId, scope.accountId, scope.workspaceId, scope.sessionId, scope.agentId]);
      const scopedDirectory = join(directory, ROUTING_SCHEMA_VERSION, scopeId);
      try {await Promise.all([lstat(scopedDirectory), lstat(join(scopedDirectory, 'records')), lstat(join(scopedDirectory, 'revisions'))]);}
      catch (error) {if ((error as NodeJS.ErrnoException).code === 'ENOENT') return support; throw error;}
      const store = storeFor(scope, true);
      const current = await store.current();
      const catalog = current.records.catalog ? await store.read<CatalogSnapshot>(current.records.catalog) : null;
      const capabilities = current.records.capabilities ? await store.read<HostCapabilities>(current.records.capabilities) : null;
      return {...support, scope, revision: current.revision, records: current.records,
        inventoryCoverage: catalog ? 'caller_reported' : 'unknown', ...(catalog ? {coverage: catalog.coverage} : {}),
        capabilities: {status: capabilities?.status ?? 'unknown', profileSwitch: capabilities?.profileSwitch ?? 'unknown', source: 'caller_reported'}};
    } catch {return {...support, status: 'unavailable', reasonCode: 'routing_state_unavailable'};}
  }
  return {updateTaskContext: update, classifyDecision: classify, status};
}
