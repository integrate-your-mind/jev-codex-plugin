import {constants} from 'node:fs';
import {link, lstat, open, realpath, unlink} from 'node:fs/promises';
import {dirname} from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {createService} from '../../service.js';
import {dataDirectory} from '../../store.js';
import {redactText} from '../../redact.js';
import type {DecisionInput, DecisionService} from '../../decision-hook.js';
import {readCredentialFile} from '../../credential.js';
import {loadTaskContext, updateTaskContext, type TaskContextRecord} from '../../task-context.js';
import {claimConsultation, consultationIdentity, providerCoolingDown, recordProviderOutage} from '../../routing-consultation.js';
import {BRIDGE_VERSION, MAX_RECORD_BYTES, agentKey, parseConfig, recordPath, toolIds, type BridgeConfig, type DecisionRecord} from './bridge.js';
import {prepareBatchClaim} from './retention.js';

type Output = {hookSpecificOutput?: {hookEventName: string; additionalContext: string}};
type Options = {env: NodeJS.ProcessEnv; service?: DecisionService; timeoutMs?: number; fetchFn?: typeof fetch; consultationMode?: 'changed_state' | 'always'; ensureDirectory(path: string): Promise<boolean>};
const object = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const digest = (v: unknown): string => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const scopeFor = (raw: Record<string, unknown>) => ({cwd: raw.cwd as string, sessionId: `claude:${raw.session_id as string}`, ...(typeof raw.agent_id === 'string' ? {agentId: raw.agent_id} : {})});
const facts = (value: TaskContextRecord | undefined) => value ? {rootObjective: value.rootObjective?.value, latestStep: value.latestStep?.value, constraints: value.constraints.map(x => x.value), criteria: value.criteria.map(x => x.value), corrections: value.corrections.map(x => x.value), evidence: value.evidenceRefs.map(x => ({id: x.id, summary: x.summary, source: x.source}))} : null;

export async function captureClaudeObjective(raw: Record<string, unknown>, env: NodeJS.ProcessEnv): Promise<void> {
  if (typeof raw.prompt !== 'string' || !raw.prompt.trim()) return;
  const scope = scopeFor(raw);
  const prior = await loadTaskContext(scope, {env});
  const prompt = raw.prompt.slice(0, 12_000);
  await updateTaskContext(scope, {operation: 'continue', ...(prior?.rootObjective ? {} : {rootObjective: prompt}), latestStep: prompt,
    provenance: {source: 'user_prompt', ...(typeof raw.prompt_id === 'string' ? {eventId: raw.prompt_id} : {})}}, {env});
}

async function readConfig(path: string | undefined): Promise<BridgeConfig | undefined> {
  if (!path?.startsWith('/') || path.includes('\0')) return undefined;
  try {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > MAX_RECORD_BYTES) return undefined;
      return parseConfig(JSON.parse(await handle.readFile('utf8')));
    } finally { await handle.close(); }
  } catch { return undefined; }
}

async function publish(path: string, record: DecisionRecord, signal: AbortSignal): Promise<void> {
  const contents = JSON.stringify(record) + '\n';
  if (Buffer.byteLength(contents) > MAX_RECORD_BYTES) throw new Error('record_packet_too_large');
  const temporary = `${path}.${randomUUID()}.partial`;
  try {
    const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(contents); await handle.sync(); }
    finally { await handle.close(); }
    if (signal.aborted) throw new Error('deadline');
    await link(temporary, path);
  }
  finally { await unlink(temporary).catch(() => {}); }
}

async function produce(raw: Record<string, unknown>, options: Options, signal: AbortSignal, deadlineAt: number): Promise<Output> {
  const check = () => { if (signal.aborted || Date.now() >= deadlineAt) throw new Error('deadline'); };
  if (raw.hook_event_name !== 'PostToolBatch' || !Array.isArray(raw.tool_calls) || !raw.tool_calls.every(object) ||
      typeof raw.session_id !== 'string' || raw.session_id.length > 160 || typeof raw.cwd !== 'string' || !raw.cwd.startsWith('/') ||
      (raw.agent_id !== undefined && (typeof raw.agent_id !== 'string' || raw.agent_id.length > 160))) return {};
  const calls = raw.tool_calls;
  if (calls.some(c => typeof c.tool_name === 'string' && (/^mcp__plugin_jev-workflows_jev-workflows__/.test(c.tool_name) || new Set(['classify_decision', 'classify_failure', 'check_completion', 'jev_status', 'configure_automation', 'evaluate_decisions', 'record_outcome', 'update_task_context']).has(c.tool_name)))) return {};
  const ids = toolIds(calls.map(c => c.tool_use_id));
  if (!ids) return {};
  const config = await readConfig(options.env.JEV_CLAUDE_ROUTING_CONFIG);
  check();
  if (!config?.enabled) return {};
  try {
    const stateRoot = dataDirectory(options.env);
    if (await realpath(stateRoot) !== config.stateDirectory) return {};
    check();
    const rootInfo = await lstat(config.stateDirectory);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || rootInfo.uid !== process.getuid?.() || (rootInfo.mode & 0o077) !== 0) return {};
    check();
    const path = recordPath(config, raw.session_id, agentKey(raw.agent_id as string | undefined), ids);
    if (!await options.ensureDirectory(dirname(path))) return {};
    check();
    // A permanent invocation claim prevents duplicate consultations after retries or crashes.
    await prepareBatchClaim(path);
    check();
    const task = await loadTaskContext(scopeFor(raw), {env: options.env});
    check();
    if (!task || !task.rootObjective && !task.latestStep || Date.now() - Date.parse(task.updatedAt) >= 7 * 24 * 60 * 60 * 1000) return {};
    const taskFacts = facts(task);
    const profiles = config.profiles.filter(p => p.availability === 'verified' && p.hostId === config.hostId && p.providerId === config.providerId);
    const candidates = profiles.length ? profiles.map(p => ({id: p.id, description: `${p.model} with ${p.effort} effort`, available: true})) : [
      {id: 'proceed', description: 'Continue the authorized workflow.', available: true},
      {id: 'gather_evidence', description: 'Gather authorized evidence before choosing the next action.', available: true},
    ];
    const summaries = calls.map(c => {
      const response = object(c.tool_response) ? c.tool_response : {};
      return {tool: typeof c.tool_name === 'string' ? redactText(c.tool_name, [options.env.TYPESAFE_API_KEY ?? '']).slice(0, 160) : 'unknown', isError: response.isError === true || response.is_error === true, exitCode: typeof response.exit_code === 'number' ? response.exit_code : null, inputDigest: digest(c.tool_input ?? null), responseDigest: digest(c.tool_response ?? null)};
    });
    const timeoutMs = Math.min(5_000, Math.max(1, options.timeoutMs ?? 5_000));
    const credential = options.env.JEV_API_KEY_FILE ? readCredentialFile(options.env.JEV_API_KEY_FILE) ?? '' : options.env.TYPESAFE_API_KEY ?? '';
    const service = options.service ?? createService({env: options.env, apiKey: credential, fetchFn: options.fetchFn, timeoutMs});
    const objectiveDigest = digest(taskFacts);
    const evidenceDigest = digest(summaries);
    const input: DecisionInput = {domain: profiles.length ? 'model' : 'general', question: profiles.length ? 'Which verified model and effort profile fits the next authorized substep?' : 'Should the ordinary workflow continue or gather evidence?', context: JSON.stringify({taskContext: taskFacts, completedToolBatch: summaries, unknowns: ['no full native catalog', 'subtask completion and background tool state unknown']}), candidates, evidence: [], mode: 'evaluate'};
    const semanticId = consultationIdentity(input, {providerId: config.providerId, catalogGeneration: config.catalogGeneration, policyGeneration: config.policyGeneration, profiles: config.profiles, transitions: config.transitions, objectiveDigest, evidenceDigest, credentialEpoch: digest(credential)});
    const consultationDirectory = `${config.stateDirectory}/routing-v1/claude-consultations/${digest(scopeFor(raw))}`;
    const providerDirectory = `${config.stateDirectory}/routing-v1/claude-provider-outages/${digest({provider: 'TypeSafe', model: options.env.JEV_MODEL ?? '', credentialEpoch: digest(credential)})}`;
    if (await providerCoolingDown(providerDirectory)) return {};
    check();
    const semanticClaim = options.consultationMode === 'changed_state' ? await claimConsultation(consultationDirectory, semanticId) : undefined;
    if (options.consultationMode === 'changed_state' && !semanticClaim) return {};
    try {
    let result: Awaited<ReturnType<DecisionService['classifyDecision']>>;
    try {
      check();
      result = await service.classifyDecision(input, signal);
      check();
      if (result.status === 'assessed' && !candidates.some(c => c.id === result.choice)) result = {status: 'unavailable', reasonCode: 'invalid_choice'};
      const latest = await loadTaskContext(scopeFor(raw), {env: options.env});
      check();
      const currentConfig = await readConfig(options.env.JEV_CLAUDE_ROUTING_CONFIG);
      check();
      if (digest(facts(latest)) !== objectiveDigest || JSON.stringify(currentConfig) !== JSON.stringify(config)) result = {status: 'unavailable', reasonCode: 'stale_context'};
      await recordProviderOutage(providerDirectory, result);
      check();
    } catch {
      if (signal.aborted) { await recordProviderOutage(providerDirectory, {status: 'unavailable', reasonCode: 'hook_timeout'}); return {}; }
      result = {status: 'unavailable', reasonCode: 'provider_error'};
      await recordProviderOutage(providerDirectory, result);
    }
    const status = result.status === 'assessed' ? 'assessed' : result.status === 'abstained' ? 'abstained' : 'unavailable';
    const selection = status === 'assessed' && profiles.some(p => p.id === result.choice) ? result.choice ?? null : null;
    const createdAt = Date.now();
    const record: DecisionRecord = {version: BRIDGE_VERSION, producer: 'trusted-post-tool-batch', sessionId: raw.session_id, agentId: agentKey(raw.agent_id as string | undefined), workspace: raw.cwd,
      toolUseIds: ids, createdAt, expiresAt: Math.min(createdAt + 30_000, deadlineAt), hostId: config.hostId, providerId: config.providerId, catalogGeneration: config.catalogGeneration, policyGeneration: config.policyGeneration, status, selection,
      objectiveDigest, evidenceDigest,
      retention: 'metadata',
      ...(result.receiptPersisted && typeof result.receiptId === 'string' ? {receiptId: result.receiptId} : {})};
    check(); await publish(path, record, signal);
    check();
    if (result.status === 'assessed' || result.status === 'abstained') await semanticClaim?.complete();
    const advice = status === 'assessed' && candidates.some(c => c.id === result.choice) ? `; decision=${result.choice}` : '';
    return {hookSpecificOutput: {hookEventName: 'PostToolBatch', additionalContext: `JEV advisory: status=${status}${advice}; advisory only. The ordinary workflow keeps its existing permissions.`}};
    } finally { await semanticClaim?.release(); }
  } catch { return {}; }
}

export async function runPostToolBatch(raw: Record<string, unknown>, options: Options): Promise<Output> {
  const controller = new AbortController();
  const timeoutMs = Math.min(5_000, Math.max(1, options.timeoutMs ?? 5_000));
  const deadlineAt = Date.now() + timeoutMs;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([produce(raw, options, controller.signal, deadlineAt), new Promise<Output>(resolve => {
      timer = setTimeout(() => { controller.abort(); resolve({hookSpecificOutput: {hookEventName: 'PostToolBatch', additionalContext: 'JEV advisory: status=unavailable; reason=hook_timeout; continue ordinary reasoning.'}}); }, timeoutMs);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}
