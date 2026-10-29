import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import fs from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import {chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {test} from 'node:test';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {createRoutingApi, catalogRefSchema, routingDecisionSchema, type CatalogRef} from '../src/routing/api.js';
import type {DecisionInput, DecisionService} from '../src/decision-hook.js';
import type {CatalogSnapshot, DecisionProposal} from '../src/routing/contracts.js';
import {RoutingStateStore} from '../src/routing/state.js';
import {loadTaskContext, loadTaskContextIdentity, withTaskContextIdentity} from '../src/task-context.js';

const question = {domain: 'tool' as const, question: 'Choose the useful tool.', context: 'Use the available evidence for this task.', evidence: [], mode: 'evaluate' as const};
const scope = {cwd: process.cwd(), sessionId: 'routing-session', agentId: 'root'};
const candidate = (index: number) => ({id: `tool_${index}`, description: `Tool ${index}`, available: true});
const metadata = {hostId: 'test-host', accountId: 'test-account', sourceRevision: 'source-1'};
const output = (value: unknown): any => value;

async function fixture(service?: DecisionService, extra: {now?: () => Date; deadlineMs?: number; key?: string} = {}) {
  const parent = join(process.cwd(), '.agent-work', 'routing-api');
  await mkdir(parent, {recursive: true});
  const root = await mkdtemp(join(parent, 'test-'));
  const calls: DecisionInput[] = [];
  const provider = service ?? {async classifyDecision(input: DecisionInput) {
    calls.push(input);
    const chosen = [...input.candidates].filter(item => item.available !== false).sort((a, b) => Number(b.id.split('_')[1]) - Number(a.id.split('_')[1]))[0];
    return chosen ? {status: 'assessed', choice: chosen.id, confidence: 0.95, probabilities: {[chosen.id]: 0.9, insufficient_evidence: 0.1}, receiptId: `receipt-${calls.length}`, receiptPersisted: true} : {status: 'abstained'};
  }};
  const env = {PLUGIN_DATA: root, ...(extra.key ? {TYPESAFE_API_KEY: extra.key} : {})};
  const api = createRoutingApi({service: provider, env, ...extra});
  const publish = async (count = 20, routing: Record<string, unknown> = metadata) => output(await api.updateTaskContext({scope, update: {operation: 'replace', rootObjective: 'Repair the current bug.', candidateCatalogs: {tool: Array.from({length: count}, (_, index) => candidate(index))}}, routing}));
  return {root, api, calls, publish, store: (ref: CatalogRef) => new RoutingStateStore({stateDirectory: root, scope: ref.scope, now: extra.now}), close: () => rm(root, {recursive: true, force: true})};
}

test('legacy decisions and task updates retain their public behavior', async () => {
  const raw = {...question, candidates: [candidate(1)]};
  let received: unknown;
  const response = {status: 'preview', preserved: true, probabilities: {tool_1: 0.9}, confidence: 0.95};
  const f = await fixture({async classifyDecision(input) {received = input; return response;}});
  try {
    assert.equal(await f.api.classifyDecision(raw), response);
    assert.equal(received, raw);
    assert.ok(routingDecisionSchema.safeParse(raw).success);
    const updated = output(await f.api.updateTaskContext({scope, update: {rootObjective: 'Legacy objective'}}));
    assert.equal(updated.status, 'updated');
    assert.equal(updated.context.rootObjective.value, 'Legacy objective');
    assert.equal(updated.routing, undefined);
  } finally {await f.close();}
});

test('catalog references retain every entry and compare the last page before selecting it', async () => {
  const f = await fixture();
  try {
    const published = await f.publish(270, {...metadata, coverage: {discovery: 'complete_supported_inventory', pages: 3, inaccessibleCategories: ['native-private-tools']}});
    assert.equal(published.routing.status, 'published');
    const ref = catalogRefSchema.parse(published.routing.catalogRef);
    const catalog = await f.store(ref).read<CatalogSnapshot>(ref.catalogId);
    assert.equal(catalog?.entries.length, 270);
    assert.equal(catalog?.entries.at(-1)?.id, 'tool:tool_269');
    const result = output(await f.api.classifyDecision({...question, catalogRef: ref}));
    assert.equal(result.status, 'assessed');
    assert.equal(result.choice, 'tool_269');
    assert.equal(result.probabilities, undefined);
    assert.equal(result.confidence, undefined);
    assert.equal(result.probabilityScope, 'omitted_page_local_values');
    assert.ok(f.calls.length > 1);
    assert.equal(new Set(f.calls.flatMap(call => call.candidates.map(item => item.id))).size, 270);
    assert.equal(result.routing.coverage.inventoryCount, 270);
    assert.equal(result.routing.coverage.comparison.comparedCount, 270);
    assert.equal(result.routing.coverage.comparison.complete, true);
    assert.equal(result.routing.coverage.outsideSupportedInventory, 'unknown');
    assert.deepEqual(result.routing.coverage.inaccessibleCategories, ['native-private-tools']);
    assert.equal(result.routing.delivery.status, 'prepared');
    assert.equal(result.routing.delivery.acknowledgment, 'unknown');
    assert.equal(result.routing.application.status, 'not_attempted');
    assert.equal(result.routing.execution.status, 'unknown');
    const proposal = await f.store(ref).read<DecisionProposal>(result.routing.proposal.id);
    assert.deepEqual(proposal?.targetIds, ['tool:tool_269']);
    assert.equal(proposal?.providerReceiptId, `receipt-${f.calls.length}`);
    assert.equal((await f.api.status(ref.scope)).profileApplication, 'unsupported');
  } finally {await f.close();}
});

test('missing coverage stays unknown and catalog references never grant model eligibility by name', async () => {
  const f = await fixture();
  try {
    const modelCatalog = [{id: 'model_1', description: 'gpt-6-astra', available: true}, {id: 'model_2', description: 'Eligible tuple', available: true, metadata: {providerId: 'provider', modelId: 'model', effort: 'high'}}];
    const publish = async (capabilities?: Record<string, unknown>) => output(await f.api.updateTaskContext({scope, update: {operation: 'replace', candidateCatalogs: {model: modelCatalog}}, routing: {...metadata, ...(capabilities ? {capabilities} : {})}}));
    const unknown = await publish();
    assert.equal(unknown.routing.coverage.knowledge, 'unknown');
    const noEligibility = await f.api.classifyDecision({...question, domain: 'model', catalogRef: unknown.routing.catalogRef});
    assert.equal(noEligibility.status, 'abstained');
    assert.equal(f.calls.length, 0);
    const known = await publish({sourceRevision: 'capability-1', status: 'known', profileSwitch: 'supported', orderedPreDispatch: true, eligibleProfiles: [{providerId: 'provider', modelId: 'model', effort: 'high'}]});
    const selected = output(await f.api.classifyDecision({...question, domain: 'model', catalogRef: known.routing.catalogRef}));
    assert.equal(selected.choice, 'model_2');
    assert.deepEqual(f.calls[0]?.candidates.map(item => item.id), ['model_2']);
    assert.equal(selected.routing.application.status, 'not_attempted');
  } finally {await f.close();}
});

test('an explicit eligible pin deterministically restricts model advice', async () => {
  const f = await fixture();
  const pin = {providerId: 'provider', modelId: 'pinned', effort: 'high'};
  const other = {providerId: 'provider', modelId: 'other', effort: 'high'};
  try {
    const published = output(await f.api.updateTaskContext({scope, update: {candidateCatalogs: {model: [
      {id: 'model_1', description: 'Pinned profile', metadata: pin},
      {id: 'model_2', description: 'Other available profile', metadata: other},
    ]}}, routing: {...metadata, capabilities: {sourceRevision: 'cap-1', status: 'known', profileSwitch: 'supported', orderedPreDispatch: true, eligibleProfiles: [pin, other]}, task: {pin}}}));
    const result = await f.api.classifyDecision({...question, domain: 'model', catalogRef: published.routing.catalogRef});
    assert.equal(result.choice, 'model_1');
    assert.deepEqual(f.calls.flatMap(call => call.candidates.map(item => item.id)), ['model_1']);
  } finally {await f.close();}
});

test('ambiguous catalog identities cannot produce a routable reference', async () => {
  const f = await fixture();
  try {
    const updated = output(await f.api.updateTaskContext({scope, update: {candidateCatalogs: {tool: [candidate(1), candidate(1)]}}, routing: metadata}));
    assert.equal(updated.status, 'updated');
    assert.equal(updated.routing.status, 'unavailable');
    assert.equal(updated.routing.reasonCode, 'duplicate_catalog_ids');
    assert.equal(updated.routing.catalogRef, undefined);
  } finally {await f.close();}
});

test('unknown, expired, wrong-scope, stale and corrupted references fail before provider dispatch', async () => {
  let date = new Date('2026-10-28T12:00:00Z');
  const f = await fixture(undefined, {now: () => date});
  try {
    const published = await f.publish();
    const ref = catalogRefSchema.parse(published.routing.catalogRef);
    for (const [changed, reason] of [
      [{...ref, catalogId: '0'.repeat(64)}, 'catalog_ref_not_found'],
      [{...ref, scope: {...ref.scope, sessionId: '0'.repeat(64)}}, 'catalog_ref_not_found'],
      [{...ref, digest: '0'.repeat(64)}, 'catalog_ref_digest_mismatch'],
    ] as const) assert.equal((await f.api.classifyDecision({...question, catalogRef: changed})).reasonCode, reason);
    assert.equal((await f.api.classifyDecision({...question, catalogRef: {...ref, catalogId: '../../private'}})).reasonCode, 'invalid_input');
    date = new Date('2026-11-05T12:00:00Z');
    assert.equal((await f.api.classifyDecision({...question, catalogRef: ref})).reasonCode, 'catalog_ref_expired');
    date = new Date('2026-10-29T12:00:00Z');
    await f.publish(21);
    assert.equal((await f.api.classifyDecision({...question, catalogRef: ref})).reasonCode, 'stale_task_revision');
    assert.equal(f.calls.length, 0);
  } finally {await f.close();}
});

test('late results cannot publish advice for a replaced task revision', async () => {
  let complete: ((value: {status: string; choice: string}) => void) | undefined;
  let started: (() => void) | undefined;
  const active = new Promise<void>(resolve => {started = resolve;});
  const f = await fixture({classifyDecision: async () => {started?.(); return new Promise(resolve => {complete = resolve;});}});
  try {
    const first = await f.publish();
    const result = f.api.classifyDecision({...question, catalogRef: first.routing.catalogRef});
    await active;
    const second = await f.publish(21);
    complete?.({status: 'assessed', choice: 'tool_1'});
    assert.equal((await result).reasonCode, 'stale_task_revision');
    assert.equal((await f.store(second.routing.catalogRef).current()).records.proposal, undefined);
  } finally {await f.close();}
});

test('ordinary legacy context updates invalidate references before any provider dispatch', async () => {
  const f = await fixture();
  try {
    const first = await f.publish();
    const changed = output(await f.api.updateTaskContext({scope, update: {operation: 'replace', rootObjective: 'New ordinary objective'}}));
    assert.equal(changed.context.rootObjective.value, 'New ordinary objective');
    assert.equal((await f.api.classifyDecision({...question, catalogRef: first.routing.catalogRef})).reasonCode, 'stale_task_revision');
    assert.equal(f.calls.length, 0);
  } finally {await f.close();}
});

test('a late provider result cannot publish after an ordinary legacy context update', async () => {
  let complete: ((value: {status: string; choice: string}) => void) | undefined;
  let started: (() => void) | undefined;
  const active = new Promise<void>(resolve => {started = resolve;});
  const f = await fixture({classifyDecision: async () => {started?.(); return new Promise(resolve => {complete = resolve;});}});
  try {
    const first = await f.publish();
    const result = f.api.classifyDecision({...question, catalogRef: first.routing.catalogRef});
    await active;
    await f.api.updateTaskContext({scope, update: {operation: 'replace', rootObjective: 'New ordinary objective'}});
    complete?.({status: 'assessed', choice: 'tool_1'});
    assert.equal((await result).reasonCode, 'stale_task_revision');
    assert.equal((await f.store(first.routing.catalogRef).current()).records.proposal, undefined);
  } finally {await f.close();}
});

test('context saving and routing publication serialize against newer scoped updates', async () => {
  const f = await fixture();
  const originalLstat = fs.lstat;
  const originalRename = fs.rename;
  let paused = false;
  let signalPause: (() => void) | undefined;
  let resume: (() => void) | undefined;
  let signalWaiting: (() => void) | undefined;
  let signalNextPublication: (() => void) | undefined;
  const firstPaused = new Promise<void>(resolve => {signalPause = resolve;});
  const release = new Promise<void>(resolve => {resume = resolve;});
  const waiting = new Promise<'locked'>(resolve => {signalWaiting = () => resolve('locked');});
  const nextPublication = new Promise<'unlocked'>(resolve => {signalNextPublication = () => resolve('unlocked');});
  fs.lstat = (async (...args: Parameters<typeof fs.lstat>) => {
    if (String(args[0]) === f.root) {
      if (!paused) {paused = true; signalPause?.(); await release;}
      else signalNextPublication?.();
    }
    return originalLstat(...args);
  }) as typeof fs.lstat;
  fs.rename = (async (...args: Parameters<typeof fs.rename>) => {
    try {return await originalRename(...args);}
    catch (error) {if (paused && String(args[1]).endsWith('/.context.lock') && ['EEXIST', 'ENOTEMPTY', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) signalWaiting?.(); throw error;}
  }) as typeof fs.rename;
  syncBuiltinESMExports();
  try {
    const old = f.api.updateTaskContext({scope, update: {operation: 'replace', rootObjective: 'Old'}, routing: metadata});
    await firstPaused;
    const next = f.api.updateTaskContext({scope, update: {operation: 'replace', rootObjective: 'New'}, routing: metadata});
    if (await Promise.race([waiting, nextPublication]) === 'unlocked') await next;
    resume?.();
    const [oldResult, newResult] = (await Promise.all([old, next])).map(output);
    assert.equal(oldResult.routing.status, 'published');
    assert.equal(newResult.routing.status, 'published');
    const current = await f.store(newResult.routing.catalogRef).current();
    const task = await f.store(newResult.routing.catalogRef).read(current.records.task!);
    assert.equal((task as unknown as {objective: string}).objective, 'New');
    assert.equal((await loadTaskContext(scope, {env: {PLUGIN_DATA: f.root}}))?.rootObjective?.value, 'New');
  } finally {resume?.(); fs.lstat = originalLstat; fs.rename = originalRename; syncBuiltinESMExports(); await f.close();}
});

test('a non-cooperative provider reaches the consultation deadline and no late result changes the pointer', async () => {
  let complete: ((value: {status: string; choice: string}) => void) | undefined;
  const f = await fixture({classifyDecision: async () => new Promise(resolve => {complete = resolve;})}, {deadlineMs: 20});
  try {
    const first = await f.publish();
    const result = await f.api.classifyDecision({...question, catalogRef: first.routing.catalogRef});
    assert.equal(result.reasonCode, 'timeout');
    const before = await f.store(first.routing.catalogRef).current();
    complete?.({status: 'assessed', choice: 'tool_1'});
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(await f.store(first.routing.catalogRef).current(), before);
  } finally {await f.close();}
});

test('caller cancellation discards a late provider result without publishing a proposal', async () => {
  let complete: ((value: {status: string; choice: string}) => void) | undefined;
  let started: (() => void) | undefined;
  const active = new Promise<void>(resolve => {started = resolve;});
  const f = await fixture({classifyDecision: async () => {started?.(); return new Promise(resolve => {complete = resolve;});}});
  try {
    const first = await f.publish();
    const controller = new AbortController();
    const pending = f.api.classifyDecision({...question, catalogRef: first.routing.catalogRef}, controller.signal);
    await active;
    controller.abort(new Error('stop_request'));
    assert.equal((await pending).reasonCode, 'cancelled');
    complete?.({status: 'assessed', choice: 'tool_1'});
    await new Promise(resolve => setImmediate(resolve));
    assert.equal((await f.store(first.routing.catalogRef).current()).records.proposal, undefined);
  } finally {await f.close();}
});

test('event loop lateness and caller cancellation cannot turn a late provider result into advice', async () => {
  const late = await fixture({async classifyDecision(input) {
    const until = Date.now() + 30;
    while (Date.now() < until) {}
    return {status: 'assessed', choice: input.candidates[0]!.id};
  }}, {deadlineMs: 10});
  try {
    const published = await late.publish();
    assert.equal((await late.api.classifyDecision({...question, catalogRef: published.routing.catalogRef})).reasonCode, 'timeout');
  } finally {await late.close();}
  const cancelled = await fixture();
  try {
    const published = await cancelled.publish();
    const controller = new AbortController();
    controller.abort(new Error('caller_cancelled'));
    const result = await cancelled.api.classifyDecision({...question, catalogRef: published.routing.catalogRef}, controller.signal);
    assert.equal(result.reasonCode, 'cancelled');
    assert.equal(cancelled.calls.length, 0);
  } finally {await cancelled.close();}
});

test('routing catalogs preserve redacted data and require a private state directory', async () => {
  const secret = 'secret-for-routing-test';
  const f = await fixture(undefined, {key: secret});
  try {
    const published = output(await f.api.updateTaskContext({scope, update: {candidateCatalogs: {tool: [{id: 'safe_tool', description: `Use ${secret}`, available: true}]}}, routing: metadata}));
    const snapshot = await f.store(published.routing.catalogRef).snapshot();
    assert.equal(JSON.stringify(snapshot).includes(secret), false);
    assert.ok(JSON.stringify(snapshot).includes('[REDACTED]'));
    await chmod(f.root, 0o755);
    const unsafe = await f.publish();
    assert.equal(unsafe.status, 'updated');
    assert.equal(unsafe.routing.reasonCode, 'unsafe_routing_directory');
  } finally {await chmod(f.root, 0o700); await f.close();}
});

test('sensitive candidate metadata stays out of raw task context, routing records and provider inputs', async () => {
  const f = await fixture();
  const privateValue = 'synthetic-private-value';
  const safeFields = Object.fromEntries(Array.from({length: 16}, (_, index) => [`safe_${index}`, index]));
  try {
    const updated = output(await f.api.updateTaskContext({scope, update: {candidateCatalogs: {tool: [{...candidate(1), metadata: {apiKey: privateValue, authorization: privateValue, ...safeFields}}]}}, routing: metadata}));
    const contextFile = join(f.root, 'task-context-v1', updated.context.scope.workspaceHash, updated.context.scope.sessionHash, updated.context.scope.agentHash, 'context.json');
    assert.equal((await readFile(contextFile, 'utf8')).includes(privateValue), false);
    assert.deepEqual(updated.context.candidateCatalogs.tool[0].metadata, safeFields);
    const snapshot = await f.store(updated.routing.catalogRef).snapshot();
    assert.equal(JSON.stringify(snapshot).includes(privateValue), false);
    await f.api.classifyDecision({...question, catalogRef: updated.routing.catalogRef});
    assert.equal(JSON.stringify(f.calls).includes(privateValue), false);
    assert.deepEqual(f.calls[0]?.candidates[0]?.metadata, safeFields);
    const legacy = JSON.parse(await readFile(contextFile, 'utf8'));
    legacy.candidateCatalogs.tool[0].metadata.apiKey = privateValue;
    await writeFile(contextFile, JSON.stringify(legacy));
    assert.equal(JSON.stringify(await loadTaskContext(scope, {env: {PLUGIN_DATA: f.root}})).includes(privateValue), false);
    await f.api.updateTaskContext({scope, update: {latestStep: 'Continue safely.'}, routing: metadata});
    assert.equal((await readFile(contextFile, 'utf8')).includes(privateValue), false);
  } finally {await f.close();}
});

test('an unsafe retained catalog is rejected without rewriting the immutable observation', async () => {
  const f = await fixture();
  try {
    const published = await f.publish(1);
    const ref = catalogRefSchema.parse(published.routing.catalogRef);
    const recordPath = join(f.store(ref).directory, 'records', `${createHash('sha256').update(ref.catalogId).digest('hex')}.json`);
    const record = JSON.parse(await readFile(recordPath, 'utf8'));
    record.entries[0].metadata = {apiKey: 'synthetic-retained-private-value'};
    const seeded = JSON.stringify(record);
    await writeFile(recordPath, seeded);
    const stable = (value: unknown): unknown => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)])) : value;
    const {expiresAt: _expiresAt, ...content} = record;
    const retainedRef = {...ref, digest: createHash('sha256').update(JSON.stringify(stable(content))).digest('hex')};
    assert.equal((await f.api.classifyDecision({...question, catalogRef: retainedRef})).reasonCode, 'unsafe_catalog_metadata');
    assert.equal(f.calls.length, 0);
    assert.equal(await readFile(recordPath, 'utf8'), seeded);
  } finally {await f.close();}
});

test('context identity readers reject path-shaped input without invoking a transaction', async () => {
  const f = await fixture();
  try {
    const identity = {workspaceHash: '../'.repeat(22), sessionHash: '0'.repeat(64), agentHash: '1'.repeat(64)};
    const options = {env: {PLUGIN_DATA: f.root}};
    assert.equal(await loadTaskContextIdentity(identity, options), undefined);
    assert.equal(await withTaskContextIdentity(identity, async () => {throw new Error('unsafe_callback');}, options), undefined);
    await assert.rejects(lstat(join(f.root, 'task-context-v1')), {code: 'ENOENT'});
  } finally {await f.close();}
});

test('scoped status remains read only before any routing observations exist', async () => {
  const f = await fixture();
  const directory = join(f.root, 'routing-v1');
  try {
    await assert.rejects(lstat(directory), {code: 'ENOENT'});
    const result = await f.api.status({hostId: metadata.hostId, accountId: metadata.accountId, workspaceId: '0'.repeat(64), sessionId: '1'.repeat(64), agentId: '2'.repeat(64)});
    assert.equal(result.inventoryCoverage, 'unknown');
    await assert.rejects(lstat(directory), {code: 'ENOENT'});
  } finally {await f.close();}
});

test('scoped status does not initialize a partially published state directory', async () => {
  const f = await fixture();
  const partialScope = {hostId: metadata.hostId, accountId: metadata.accountId, workspaceId: '0'.repeat(64), sessionId: '1'.repeat(64), agentId: '2'.repeat(64)};
  const scopeId = createHash('sha256').update(JSON.stringify(Object.values(partialScope))).digest('hex');
  const directory = join(f.root, 'routing-v1', scopeId);
  try {
    await mkdir(directory, {recursive: true, mode: 0o700});
    await f.api.status(partialScope);
    await assert.rejects(lstat(join(directory, 'records')), {code: 'ENOENT'});
    await assert.rejects(lstat(join(directory, 'revisions')), {code: 'ENOENT'});
  } finally {await f.close();}
});

test('an authorized context update prunes expired routing facts without rewriting old records', async () => {
  let date = new Date('2026-10-28T12:00:00Z');
  const f = await fixture(undefined, {now: () => date});
  try {
    const original = await f.publish();
    const originalRef = catalogRefSchema.parse(original.routing.catalogRef);
    const originalRecord = await f.store(originalRef).read(originalRef.catalogId, {includeExpired: true});
    assert.ok(originalRecord);
    date = new Date('2026-11-05T12:00:00Z');
    assert.equal((await f.publish()).routing.status, 'published');
    assert.equal(await f.store(originalRef).read(originalRef.catalogId, {includeExpired: true}), null);
  } finally {await f.close();}
});

test('real MCP tools expose the same eight names and use persisted scoped catalogs', async () => {
  const f = await fixture();
  const env = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== undefined && !key.startsWith('JEV_') && !['TYPESAFE_API_KEY', 'XDG_STATE_HOME', 'PLUGIN_DATA'].includes(key))) as Record<string, string>;
  const transport = new StdioClientTransport({command: process.execPath, args: ['--import', 'tsx', join(process.cwd(), 'src/server.ts')], cwd: process.cwd(), env: {...env, PLUGIN_DATA: f.root}, stderr: 'pipe'});
  const client = new Client({name: 'routing-api-test', version: '1'}, {capabilities: {}});
  const text = (result: unknown) => JSON.parse((result as {content: Array<{text: string}>}).content[0]!.text);
  try {
    await client.connect(transport);
    const {tools} = await client.listTools();
    assert.deepEqual(tools.map(tool => tool.name).sort(), ['jev_status', 'classify_failure', 'check_completion', 'classify_decision', 'configure_automation', 'evaluate_decisions', 'update_task_context', 'record_decision_outcome'].sort());
    const published = text(await client.callTool({name: 'update_task_context', arguments: {scope, update: {candidateCatalogs: {tool: Array.from({length: 20}, (_, index) => candidate(index))}}, routing: metadata}}));
    assert.equal(published.routing.status, 'published');
    const preview = text(await client.callTool({name: 'classify_decision', arguments: {...question, mode: 'preview', catalogRef: published.routing.catalogRef}}));
    assert.equal(preview.status, 'preview');
    assert.equal(preview.preview.state.candidates.length, 20);
    assert.equal(preview.routing.coverage.inventoryCount, 20);
    assert.equal(preview.routing.execution.status, 'unknown');
    const evaluated = text(await client.callTool({name: 'classify_decision', arguments: {...question, catalogRef: published.routing.catalogRef}}));
    assert.equal(evaluated.status, 'unavailable');
    assert.equal(evaluated.reasonCode, 'missing_api_key');
    assert.equal(evaluated.routing.proposal.disposition, 'abstained');
    assert.equal(evaluated.routing.delivery.status, 'prepared');
    assert.equal(evaluated.routing.application.status, 'not_attempted');
    const legacy = text(await client.callTool({name: 'classify_decision', arguments: {...question, mode: 'preview', candidates: [candidate(1)]}}));
    assert.equal(legacy.status, 'preview');
    assert.equal(legacy.routing, undefined);
    const status = text(await client.callTool({name: 'jev_status', arguments: {routingScope: published.routing.catalogRef.scope}}));
    assert.equal(status.routing.coverage.inventoryCount, 20);
    assert.equal(status.routing.automaticModelRouting, 'undelivered');
    assert.equal(status.maxCallsPerDay, null);
    assert.equal(status.maxBytesPerDay, null);
    assert.equal(status.evaluations.scanMode, 'daily-index');
    assert.equal((await f.store(published.routing.catalogRef).current()).records.catalog, published.routing.catalogRef.catalogId);
  } finally {await client.close().catch(() => {}); await f.close();}
});
