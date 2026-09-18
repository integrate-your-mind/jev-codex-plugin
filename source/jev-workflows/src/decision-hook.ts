import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, realpath, readdir, unlink, lstat, rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createService } from './service.js';
import { redactText } from './redact.js';
import { dataDirectory } from './store.js';
import { readPolicy, workspaceAllowed, type HookPolicy } from './policy.js';

const MAX_STDIN_BYTES = 128 * 1024;
const MAX_SEMANTIC_BYTES = 1_500;
const MAX_CONTEXT_BYTES = 5_000;
const MAX_FAILURE_EXCERPT_BYTES = 600;
const MAX_RESULT_EXCERPT_BYTES = 1_500;
const HOST_TIMEOUT_MS = 5_000;
const PROVIDER_TIMEOUT_MS = 3_000;
const HOOK_TIMEOUT_MS = HOST_TIMEOUT_MS - 1_000;
const SHORT_EVENT_PROVIDER_TIMEOUT_MS = 1_800;
const SHORT_EVENT_HOOK_TIMEOUT_MS = 2_500;
const EVENT_DIRECTORY = 'decision-hook-v1';
const PROMPT_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_PROMPT_BYTES = 1_500;
const TURN_RESULT_TTL_MS = 2 * 60 * 60 * 1000;
const MAX_TURN_RESULTS = 8;
const MAX_CACHED_RESULT_BYTES = 500;
const MAX_TURN_RESULT_FILE_BYTES = 12 * 1024;
const TURN_RESULT_DIRECTORY = 'turn-results';
const INVOCATION_DIRECTORY = 'invocations';
const LOCAL_INSTRUCTION = 'Before choosing a tool, model, effort, task, skill, context, or strategy, consult classify_decision when this automation policy permits it. Treat its answer as advisory and continue ordinary reasoning when it is unavailable or inconclusive.';
const ACTION_CANDIDATES = [
  {id: 'proceed', description: 'Continue with the ordinary workflow.', available: true},
  {id: 'reconsider', description: 'Reconsider the current action using the available evidence.', available: true},
  {id: 'gather_evidence', description: 'Gather authorized evidence before choosing the next action.', available: true},
] as const;
const ACTION_CHOICES = new Set([...ACTION_CANDIDATES.map(candidate => candidate.id), 'insufficient_evidence']);
const SUPPORTED_EVENTS = new Set([
  'SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse', 'PermissionRequest', 'PostToolUse',
  'PreCompact', 'PostCompact', 'SubagentStart', 'SubagentStop', 'Stop', 'Interrupt',
]);
const EVENTS_WITHOUT_STABLE_NATIVE_ID = new Set(['SessionStart', 'SessionEnd', 'PermissionRequest', 'PreCompact', 'PostCompact', 'Interrupt']);
const INTERNAL_TOOL_NAMES = new Set(['classify_decision', 'classify_failure', 'check_completion', 'jev_status', 'configure_automation']);

type RecordValue = Record<string, unknown>;
export type DecisionInput = {
  domain: 'tool' | 'model' | 'task' | 'skill' | 'context' | 'strategy' | 'result' | 'general';
  question: string;
  context: string;
  candidates: Array<{id: string; description: string; available?: boolean; metadata?: Record<string, string | number | boolean>}>;
  evidence: Array<{id: string; text: string; source?: string}>;
  mode: 'preview' | 'evaluate';
};
export type DecisionAssessment = {status?: string; choice?: string; confidence?: number; receiptId?: string; receiptPersisted?: boolean; reasonCode?: string};
export type DecisionService = {
  classifyDecision(input: DecisionInput, signal?: AbortSignal): Promise<DecisionAssessment>;
};
type HookResult = {
  hookSpecificOutput?: {hookEventName: string; additionalContext: string};
  systemMessage?: string;
};
type NormalizedEvent = {
  name: string;
  eventId: string;
  cwd: string;
  sessionId: string;
  turnId: string;
  toolUseId: string;
  agentId: string;
  agentType?: string;
  toolName?: string;
  model?: string;
  permissionMode?: string;
  source?: string;
  trigger?: string;
  reason?: string;
  prompt?: string;
  finalMessage?: string;
  raw: RecordValue;
};

function isRecord(value: unknown): value is RecordValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function boundedWithEnv(value: unknown, maxBytes: number, env: NodeJS.ProcessEnv): string | undefined {
  if (typeof value !== 'string') return undefined;
  const redacted = redactText(value, env.TYPESAFE_API_KEY ? [env.TYPESAFE_API_KEY] : []);
  if (Buffer.byteLength(redacted) <= maxBytes) return redacted;
  return Buffer.from(redacted).subarray(0, maxBytes).toString('utf8');
}

function safeId(value: string): string {
  return /^[a-zA-Z0-9._:-]{1,80}$/.test(value) ? value : `evidence-${hash(value).slice(0, 20)}`;
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function normalizeDecisionEvent(raw: unknown): NormalizedEvent | undefined {
  if (!isRecord(raw) || typeof raw.hook_event_name !== 'string' || !SUPPORTED_EVENTS.has(raw.hook_event_name)) return undefined;
  if (typeof raw.cwd !== 'string' || typeof raw.session_id !== 'string') return undefined;
  const turnId = typeof raw.turn_id === 'string' ? raw.turn_id : '';
  const toolUseId = typeof raw.tool_use_id === 'string' ? raw.tool_use_id : '';
  const agentId = typeof raw.agent_id === 'string' ? raw.agent_id : '';
  const toolName = typeof raw.tool_name === 'string' ? raw.tool_name : undefined;
  if ((raw.hook_event_name === 'PreToolUse' || raw.hook_event_name === 'PostToolUse') && (!toolName || !toolUseId)) return undefined;
  if (raw.hook_event_name === 'PermissionRequest' && (!toolName || !turnId)) return undefined;
  // Some hosted runtimes omit turn_id on UserPromptSubmit. Keep that valid and
  // derive its deduplication identity from the prompt/event id below.
  if (['PreCompact', 'PostCompact', 'SubagentStart', 'SubagentStop', 'Stop', 'Interrupt'].includes(raw.hook_event_name) && !turnId) return undefined;
  if ((raw.hook_event_name === 'SubagentStart' || raw.hook_event_name === 'SubagentStop') && !agentId) return undefined;
  if ((raw.hook_event_name === 'SubagentStart' || raw.hook_event_name === 'SubagentStop') && typeof raw.agent_type !== 'string') return undefined;
  if ((raw.hook_event_name === 'PreCompact' || raw.hook_event_name === 'PostCompact') && typeof raw.trigger !== 'string') return undefined;
  if (raw.hook_event_name === 'SessionEnd' && typeof raw.reason !== 'string') return undefined;
  if ((raw.hook_event_name === 'Stop' || raw.hook_event_name === 'SubagentStop') && raw.stop_hook_active === true) return undefined;
  return {
    name: raw.hook_event_name,
    eventId: typeof raw.event_id === 'string' ? raw.event_id : EVENTS_WITHOUT_STABLE_NATIVE_ID.has(raw.hook_event_name) ? randomUUID() : '',
    cwd: raw.cwd,
    sessionId: raw.session_id,
    turnId,
    toolUseId,
    agentId,
    agentType: typeof raw.agent_type === 'string' ? raw.agent_type : undefined,
    toolName,
    model: typeof raw.model === 'string' ? raw.model : undefined,
    permissionMode: typeof raw.permission_mode === 'string' ? raw.permission_mode : undefined,
    source: typeof raw.source === 'string' ? raw.source : undefined,
    trigger: typeof raw.trigger === 'string' ? raw.trigger : undefined,
    reason: typeof raw.reason === 'string' ? raw.reason : undefined,
    prompt: typeof raw.prompt === 'string' ? raw.prompt : undefined,
    finalMessage: typeof raw.last_assistant_message === 'string' ? raw.last_assistant_message : undefined,
    raw,
  };
}

function isInternal(event: NormalizedEvent, env: NodeJS.ProcessEnv): boolean {
  const name = event.toolName ?? '';
  if (INTERNAL_TOOL_NAMES.has(name) || name.startsWith('mcp__jev_workflows__') || name.startsWith('mcp__jev-workflows__')) return true;
  if (name.startsWith('mcp__jev_workflows_') || name.startsWith('mcp__jev-workflows_')) return true;
  if (name === 'Bash' && isRecord(event.raw.tool_input)) {
    const command = boundedWithEnv(event.raw.tool_input.command, 4_000, env) ?? '';
    if (command.includes('dist/decision-hook.mjs') || command.includes('dist/hook.mjs')) return true;
  }
  return false;
}

function semanticArguments(event: NormalizedEvent, env: NodeJS.ProcessEnv): {keys: string[]; values: Record<string, string>} {
  if (typeof event.raw.tool_input === 'string') {
    const value = boundedWithEnv(event.raw.tool_input, MAX_SEMANTIC_BYTES, env);
    return value ? {keys: ['$value'], values: {$value: value}} : {keys: ['$value'], values: {}};
  }
  if (!isRecord(event.raw.tool_input)) return {keys: [], values: {}};
  const keys = Object.keys(event.raw.tool_input).slice(0, 32).map(key => boundedWithEnv(key, 80, env) ?? '');
  const values: Record<string, string> = {};
  const allow = new Set(['command', 'cmd', 'code', 'query', 'task', 'prompt']);
  let used = 0;
  for (const key of keys) {
    if (!allow.has(key)) continue;
    const value = boundedWithEnv(event.raw.tool_input[key], Math.min(MAX_SEMANTIC_BYTES - used, 1_500), env);
    if (!value) continue;
    values[key] = value;
    used += Buffer.byteLength(value);
    if (used >= MAX_SEMANTIC_BYTES) break;
  }
  return {keys, values};
}

type SemanticResponse = {status?: string; exitCode?: number; isError?: boolean; resultExcerpt?: string; failureExcerpt?: string};
type CachedToolResult = {toolName?: string; status?: string; exitCode?: number; isError?: boolean; resultExcerpt?: string};
type TurnResultContext = {status: 'available' | 'missing' | 'stale' | 'out_of_turn' | 'unsupported_agent_scope'; results: CachedToolResult[]};

function responseExcerpt(value: unknown, env: NodeJS.ProcessEnv): string | undefined {
  if (typeof value === 'string') return boundedWithEnv(value, MAX_RESULT_EXCERPT_BYTES, env);
  if (!isRecord(value) && !Array.isArray(value)) return undefined;
  try {
    const serialized = JSON.stringify(value, (key, nested) => {
      if (/(?:token|password|secret|authorization|cookie|credential|private[_-]?key|api[_-]?key|base64[_-]?string|file[_-]?uri|download[_-]?url)/i.test(key)) {
        return '[REDACTED_FIELD]';
      }
      if (typeof nested === 'string') {
        const redacted = boundedWithEnv(nested, 800, env) ?? '';
        if (/^(?:data|blob|bytes|base64|image|audio|video)$/i.test(key) && Buffer.byteLength(redacted) > 160) {
          return `[OMITTED_BINARY:${Buffer.byteLength(redacted)} bytes]`;
        }
        return redacted;
      }
      return nested;
    });
    return boundedWithEnv(serialized, MAX_RESULT_EXCERPT_BYTES, env);
  } catch {
    return undefined;
  }
}

function semanticResponse(event: NormalizedEvent, env: NodeJS.ProcessEnv): SemanticResponse {
  const response = event.raw.tool_response;
  const result: SemanticResponse = {};
  if (isRecord(response)) {
    if (typeof response.status === 'string') result.status = response.status.slice(0, 80);
    const exitCode = response.exit_code ?? response.exitCode;
    if (typeof exitCode === 'number' && Number.isSafeInteger(exitCode)) result.exitCode = exitCode;
    const isError = response.isError ?? response.is_error;
    if (typeof isError === 'boolean') result.isError = isError;
    if (result.exitCode === undefined && (typeof response.session_id === 'string' || typeof response.session_id === 'number' || typeof response.cell_id === 'string')) {
      result.status = 'running';
    }
    result.resultExcerpt = responseExcerpt(response, env);
    const failed = result.isError === true || (result.exitCode !== undefined && result.exitCode !== 0) || /fail|error/i.test(result.status ?? '');
    if (failed) {
      for (const key of ['output', 'stderr', 'stdout', 'error', 'message']) {
        const excerpt = boundedWithEnv(response[key], MAX_FAILURE_EXCERPT_BYTES, env);
        if (excerpt) { result.failureExcerpt = excerpt; break; }
      }
    }
  } else if (typeof response === 'string') {
    result.resultExcerpt = responseExcerpt(response, env);
    if (/Script running with (?:session|cell) ID|process is still running/i.test(response)) result.status = 'running';
    const exit = response.match(/Process\s+(?:exited\s+with\s+code|exit\s+code:)\s*(-?\d+)/);
    if (exit) result.exitCode = Number(exit[1]);
    const output = response.match(/\bOutput\s*:\s*([\s\S]*)/);
    if (result.exitCode !== undefined && result.exitCode !== 0 && output) result.failureExcerpt = boundedWithEnv(output[1], MAX_FAILURE_EXCERPT_BYTES, env);
  }
  return result;
}

function cachedToolResult(event: NormalizedEvent, response: SemanticResponse, env: NodeJS.ProcessEnv): CachedToolResult {
  return {
    toolName: boundedWithEnv(event.toolName, 128, env),
    status: boundedWithEnv(response.status, 80, env),
    exitCode: response.exitCode,
    isError: response.isError,
    resultExcerpt: boundedWithEnv(response.failureExcerpt ?? response.resultExcerpt, MAX_CACHED_RESULT_BYTES, env),
  };
}

function privateSessionDirectory(event: NormalizedEvent, env: NodeJS.ProcessEnv, create = false): Promise<string | undefined> {
  return (async () => {
    const directory = dataDirectory(env);
    if (!isAbsolute(directory) || directory.includes('\0')) return undefined;
    try {
      const workspace = await realpath(event.cwd);
      const sessionDirectory = join(directory, EVENT_DIRECTORY, hash(workspace), hash(event.sessionId));
      if (create) await mkdir(sessionDirectory, {recursive: true, mode: 0o700});
      return sessionDirectory;
    } catch {
      return undefined;
    }
  })();
}

async function readPromptCache(event: NormalizedEvent, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  const directory = await privateSessionDirectory(event, env);
  if (!directory) return undefined;
  const path = join(directory, 'prompt.json');
  try {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > 4 * 1024) return undefined;
      const value = JSON.parse(await handle.readFile('utf8')) as RecordValue;
      const updatedAt = value.updatedAt;
      if (typeof value.prompt !== 'string' || typeof updatedAt !== 'number' || !Number.isSafeInteger(updatedAt)) return undefined;
      if (Date.now() - updatedAt > PROMPT_TTL_MS || updatedAt > Date.now() + 60_000) {
        await unlink(path).catch(() => {});
        return undefined;
      }
      return boundedWithEnv(value.prompt, MAX_PROMPT_BYTES, env);
    } finally {
      await handle.close();
    }
  } catch {
    return undefined;
  }
}

async function updatePromptCache(event: NormalizedEvent, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  const directory = await privateSessionDirectory(event, env, true);
  if (!directory) return undefined;
  const lockPath = join(directory, '.prompt.lock');
  let lock;
  try {
    lock = await open(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  } catch {
    return readPromptCache(event, env);
  }
  const path = join(directory, 'prompt.json');
  try {
    const prompt = boundedWithEnv(event.prompt, MAX_PROMPT_BYTES, env);
    if (!prompt) {
      try {
        const existing = await lstat(path);
        if (existing.isFile()) await unlink(path);
      } catch { /* absent or unsafe state */ }
      return undefined;
    }
    const temporary = join(directory, `.prompt-${randomUUID()}.tmp`);
    const contents = JSON.stringify({prompt, updatedAt: Date.now()}) + '\n';
    const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(contents, 'utf8'); } finally { await handle.close(); }
    try {
      try {
        const existing = await lstat(path);
        if (existing.isSymbolicLink() || !existing.isFile()) throw new Error('unsafe_prompt_cache');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      await rename(temporary, path);
    } finally { await unlink(temporary).catch(() => {}); }
    return prompt;
  } catch {
    return readPromptCache(event, env);
  } finally {
    await lock.close().catch(() => {});
    await unlink(lockPath).catch(() => {});
  }
}

async function updateTurnResultCache(event: NormalizedEvent, response: SemanticResponse, env: NodeJS.ProcessEnv): Promise<void> {
  if (event.name !== 'PostToolUse' || !event.turnId) return;
  const sessionDirectory = await privateSessionDirectory(event, env, true);
  if (!sessionDirectory) return;
  const directory = join(sessionDirectory, TURN_RESULT_DIRECTORY);
  await mkdir(directory, {recursive: true, mode: 0o700}).catch(() => {});
  const turnHash = hash(event.turnId);
  const path = join(directory, `${turnHash}.json`);
  const lockPath = join(directory, `.${turnHash}.lock`);
  let lock;
  try {
    lock = await open(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  } catch {
    return;
  }
  try {
    let results: CachedToolResult[] = [];
    try {
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const info = await handle.stat();
        if (info.isFile() && info.size <= MAX_TURN_RESULT_FILE_BYTES) {
          const prior = JSON.parse(await handle.readFile('utf8')) as RecordValue;
          if (prior.turnHash === turnHash && typeof prior.updatedAt === 'number' && Number.isSafeInteger(prior.updatedAt) &&
              Date.now() - prior.updatedAt <= TURN_RESULT_TTL_MS && prior.updatedAt <= Date.now() + 60_000 && Array.isArray(prior.results)) {
            results = prior.results.filter(isRecord).slice(-MAX_TURN_RESULTS) as CachedToolResult[];
          }
        }
      } finally { await handle.close(); }
    } catch { /* absent or invalid cache starts a fresh current-turn record */ }
    results.push(cachedToolResult(event, response, env));
    results = results.slice(-MAX_TURN_RESULTS);
    const temporary = join(directory, `.${turnHash}-${randomUUID()}.tmp`);
    const contents = JSON.stringify({turnHash, updatedAt: Date.now(), results}) + '\n';
    const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(contents, 'utf8'); } finally { await handle.close(); }
    try { await rename(temporary, path); } finally { await unlink(temporary).catch(() => {}); }
  } catch { /* task-result context is advisory and never affects host behavior */ }
  finally {
    await lock.close().catch(() => {});
    await unlink(lockPath).catch(() => {});
  }
}

async function readTurnResultCache(event: NormalizedEvent, env: NodeJS.ProcessEnv): Promise<TurnResultContext> {
  if (event.name === 'SubagentStop') return {status: 'unsupported_agent_scope', results: []};
  if ((event.name !== 'Stop' && event.name !== 'Interrupt') || !event.turnId) return {status: 'missing', results: []};
  const sessionDirectory = await privateSessionDirectory(event, env);
  if (!sessionDirectory) return {status: 'missing', results: []};
  const directory = join(sessionDirectory, TURN_RESULT_DIRECTORY);
  const turnHash = hash(event.turnId);
  const path = join(directory, `${turnHash}.json`);
  try {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > MAX_TURN_RESULT_FILE_BYTES) return {status: 'stale', results: []};
      const value = JSON.parse(await handle.readFile('utf8')) as RecordValue;
      if (value.turnHash !== turnHash || typeof value.updatedAt !== 'number' || !Number.isSafeInteger(value.updatedAt) || !Array.isArray(value.results)) {
        return {status: 'stale', results: []};
      }
      if (Date.now() - value.updatedAt > TURN_RESULT_TTL_MS || value.updatedAt > Date.now() + 60_000) {
        await unlink(path).catch(() => {});
        return {status: 'stale', results: []};
      }
      const results = value.results.filter(isRecord).slice(-MAX_TURN_RESULTS) as CachedToolResult[];
      return results.length ? {status: 'available', results} : {status: 'missing', results: []};
    } finally { await handle.close(); }
  } catch {
    try {
      const entries = await readdir(directory, {withFileTypes: true});
      if (entries.some(entry => entry.isFile() && /^[a-f0-9]{64}\.json$/.test(entry.name))) return {status: 'out_of_turn', results: []};
    } catch { /* no result directory */ }
    return {status: 'missing', results: []};
  }
}

function finalMessage(event: NormalizedEvent, env: NodeJS.ProcessEnv): string | undefined {
  return boundedWithEnv(event.finalMessage, MAX_PROMPT_BYTES, env);
}

function actionCandidates(event: NormalizedEvent): DecisionInput['candidates'] {
  if (event.name === 'PostToolUse') return [
    {id: 'proceed', description: 'The observed tool result supports continuing the authorized workflow.', available: true},
    {id: 'reconsider', description: 'The observed tool result contradicts expectations or reveals a substantive issue that should change the next action.', available: true},
    {id: 'gather_evidence', description: 'The observed tool result is incomplete or ambiguous, so more authorized evidence is needed before the next action.', available: true},
  ];
  if (event.name === 'Stop' || event.name === 'SubagentStop') return [
    {id: 'proceed', description: 'The available final message and same-scope result evidence support ending this task flow.', available: true},
    {id: 'reconsider', description: 'The available final message or result evidence contains a contradiction, failure, or unsupported outcome that should be revisited.', available: true},
    {id: 'gather_evidence', description: 'The available result evidence is incomplete or missing, so more authorized verification is needed.', available: true},
  ];
  if (event.name === 'PreToolUse') return [
    {id: 'proceed', description: 'The proposed tool action fits the current authorized task and available evidence.', available: true},
    {id: 'reconsider', description: 'The proposed tool action conflicts with the task, constraints, or available evidence.', available: true},
    {id: 'gather_evidence', description: 'The proposed tool action depends on missing context that should be gathered first.', available: true},
  ];
  if (event.name === 'PermissionRequest') return [
    {id: 'proceed', description: 'The approval request is coherent with the authorized task; leave the actual approval decision to the host and user.', available: true},
    {id: 'reconsider', description: 'The approval request appears inconsistent with the task or constraints and should be reconsidered before the host asks the user.', available: true},
    {id: 'gather_evidence', description: 'The approval request lacks context needed for useful advisory feedback; gather authorized evidence without granting or denying permission.', available: true},
  ];
  return ACTION_CANDIDATES.map(candidate => ({...candidate}));
}

function contextText(value: RecordValue, env: NodeJS.ProcessEnv): string {
  const complete = JSON.stringify({...value, contextTruncated: false});
  if (Buffer.byteLength(complete) <= MAX_CONTEXT_BYTES) return complete;
  const response = isRecord(value.response) ? value.response : {};
  const turnResults = isRecord(value.turnResults) ? value.turnResults : undefined;
  const compact = {
    event: value.event,
    toolName: value.toolName,
    model: value.model,
    permissionMode: value.permissionMode,
    source: value.source,
    trigger: value.trigger,
    reason: value.reason,
    agentType: value.agentType,
    argumentKeys: value.argumentKeys,
    arguments: boundedWithEnv(JSON.stringify(value.arguments ?? {}), 700, env),
    response: {
      status: response.status,
      exitCode: response.exitCode,
      isError: response.isError,
      resultExcerpt: boundedWithEnv(response.failureExcerpt ?? response.resultExcerpt, 700, env),
    },
    taskPrompt: boundedWithEnv(value.taskPrompt, 700, env),
    finalMessage: boundedWithEnv(value.finalMessage, 700, env),
    turnResults: turnResults ? {status: turnResults.status, resultCount: Array.isArray(turnResults.results) ? turnResults.results.length : 0} : undefined,
    contextTruncated: true,
  };
  return JSON.stringify(compact);
}

function decisionInput(event: NormalizedEvent, env: NodeJS.ProcessEnv, taskPrompt?: string, turnResults?: TurnResultContext): DecisionInput {
  const args = semanticArguments(event, env);
  const response = semanticResponse(event, env);
  const message = finalMessage(event, env);
  const context = contextText({
    event: event.name,
    toolName: boundedWithEnv(event.toolName, 128, env),
    model: boundedWithEnv(event.model, 128, env),
    permissionMode: boundedWithEnv(event.permissionMode, 80, env),
    source: boundedWithEnv(event.source, 80, env),
    trigger: boundedWithEnv(event.trigger, 80, env),
    reason: boundedWithEnv(event.reason, 80, env),
    agentType: boundedWithEnv(event.agentType, 128, env),
    argumentKeys: args.keys,
    arguments: args.values,
    response,
    taskPrompt,
    finalMessage: message,
    turnResults,
  }, env);
  const evidence: Array<{id: string; text: string; source?: string}> = [];
  if (event.name === 'UserPromptSubmit' && taskPrompt) evidence.push({id: safeId('task.prompt'), text: taskPrompt, source: 'prompt'});
  if (response.failureExcerpt) evidence.push({id: safeId('tool.failure'), text: response.failureExcerpt, source: 'hook'});
  else if (event.name === 'PostToolUse' && response.resultExcerpt) evidence.push({id: safeId('tool.result'), text: response.resultExcerpt, source: 'hook'});
  if (message) evidence.push({id: safeId('result.message'), text: message, source: 'assistant'});
  if (turnResults?.status === 'available') {
    const text = boundedWithEnv(JSON.stringify(turnResults.results), MAX_CONTEXT_BYTES, env);
    if (text) evidence.push({id: safeId('result.tool_summaries'), text, source: 'hook'});
  }
  const question = event.name === 'UserPromptSubmit'
    ? 'Does the current user prompt support proceeding with the ordinary workflow, reconsidering direction, or gathering evidence first?'
    : event.name === 'PreToolUse'
    ? 'Should this tool action proceed, be reconsidered, or gather evidence?'
    : event.name === 'PostToolUse'
      ? 'After this tool result, should the next step proceed, be reconsidered, or gather evidence?'
      : event.name === 'PermissionRequest'
        ? 'What advisory feedback best fits this approval request without granting or denying it?'
        : event.name === 'PreCompact' || event.name === 'PostCompact'
          ? 'Does this context-compaction lifecycle point support proceeding, reconsidering, or gathering evidence?'
          : event.name === 'SubagentStart'
            ? 'Does this subagent start fit the current task, or should the workflow be reconsidered or gather evidence?'
      : 'Should this task result proceed, be reconsidered, or gather evidence?';
  const domain = event.name === 'UserPromptSubmit' || event.name === 'SubagentStart' ? 'task'
    : event.name === 'PreToolUse' || event.name === 'PermissionRequest' ? 'tool'
    : event.name === 'PreCompact' || event.name === 'PostCompact' ? 'context' : 'result';
  return {domain, question, context, candidates: actionCandidates(event), evidence, mode: 'evaluate'};
}

function eventKey(event: NormalizedEvent): string {
  const promptIdentity = event.turnId || (typeof event.raw.event_id === 'string' ? event.raw.event_id : hash(event.prompt ?? 'prompt'));
  let identity: string;
  if (event.eventId) identity = `${event.sessionId}\0${event.eventId}`;
  else if (event.name === 'SessionStart') identity = `${event.sessionId}\0${event.source ?? 'unknown'}\0${event.turnId}`;
  else if (event.name === 'SessionEnd') identity = `${event.sessionId}\0${event.reason ?? 'other'}`;
  else if (event.name === 'SubagentStart' || event.name === 'SubagentStop') identity = `${event.sessionId}\0${event.turnId}\0${event.agentId}`;
  else if (event.name === 'PermissionRequest') identity = `${event.sessionId}\0${event.turnId}\0${event.toolName ?? ''}\0${hash(JSON.stringify(event.raw.tool_input ?? null))}`;
  else if (event.name === 'PreCompact' || event.name === 'PostCompact') identity = `${event.sessionId}\0${event.turnId}\0${event.trigger ?? ''}`;
  else if (event.name === 'UserPromptSubmit' || event.name === 'Stop' || event.name === 'Interrupt') identity = `${event.sessionId}\0${promptIdentity}`;
  else identity = `${event.sessionId}\0${event.turnId}\0${event.toolUseId}`;
  return hash(`${event.name}\0${identity}`);
}

async function claimEvent(event: NormalizedEvent, policy: HookPolicy, env: NodeJS.ProcessEnv): Promise<boolean> {
  if (policy.maxHookCallsPerSession !== null && policy.maxHookCallsPerSession <= 0) return false;
  const directory = dataDirectory(env);
  if (!isAbsolute(directory) || directory.includes('\0')) return false;
  let workspace: string;
  try {
    await mkdir(directory, {recursive: true, mode: 0o700});
    workspace = await realpath(event.cwd);
  } catch {
    return false;
  }
  const sessionDirectory = join(directory, EVENT_DIRECTORY, hash(workspace), hash(event.sessionId));
  await mkdir(sessionDirectory, {recursive: true, mode: 0o700}).catch(() => {});
  const eventName = eventKey(event);
  if (policy.maxHookCallsPerSession === null) {
    try {
      const marker = await open(join(sessionDirectory, eventName), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      await marker.close();
      return true;
    } catch {
      return false;
    }
  }
  const lockPath = join(sessionDirectory, '.lock');
  let lock;
  try {
    lock = await open(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  } catch {
    return false;
  }
  try {
    const entries = await readdir(sessionDirectory, {withFileTypes: true});
    if (entries.some(entry => entry.isFile() && entry.name === eventName)) return false;
    const count = entries.filter(entry => entry.isFile() && /^[a-f0-9]{64}$/.test(entry.name)).length;
    if (policy.maxHookCallsPerSession !== null && count >= policy.maxHookCallsPerSession) return false;
    const marker = await open(join(sessionDirectory, eventName), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    await marker.close();
    return true;
  } catch {
    return false;
  } finally {
    await lock.close().catch(() => {});
    await unlink(lockPath).catch(() => {});
  }
}

function instructionOutput(event: NormalizedEvent): HookResult {
  return {hookSpecificOutput: {hookEventName: event.name, additionalContext: LOCAL_INSTRUCTION}};
}

function decisionOutput(event: NormalizedEvent, result: DecisionAssessment): HookResult {
  const prefix = event.name === 'UserPromptSubmit' ? `${LOCAL_INSTRUCTION} ` : '';
  const emit = (message: string): HookResult => ['Stop', 'SubagentStop', 'PermissionRequest', 'Interrupt', 'SessionEnd', 'PreCompact', 'PostCompact'].includes(event.name)
    ? {systemMessage: message}
    : {hookSpecificOutput: {hookEventName: event.name, additionalContext: message}};
  const status = typeof result.status === 'string' && ['assessed', 'abstained', 'unavailable', 'skipped', 'preview'].includes(result.status)
    ? result.status : 'unavailable';
  const fields = [`status=${status}`];
  if (typeof result.choice === 'string' && ACTION_CHOICES.has(result.choice)) fields.push(`decision=${result.choice}`);
  if (typeof result.confidence === 'number' && Number.isFinite(result.confidence) && result.confidence >= 0 && result.confidence <= 1) {
    fields.push(`confidence=${result.confidence.toFixed(2)}`);
  }
  if (typeof result.reasonCode === 'string' && /^[a-z_]{1,80}$/.test(result.reasonCode)) fields.push(`reason=${result.reasonCode}`);
  if (result.receiptPersisted === true && typeof result.receiptId === 'string' && /^[a-f0-9-]{1,80}$/.test(result.receiptId)) fields.push(`receipt=${result.receiptId}`);
  const suffix = status === 'assessed'
    ? 'advisory only, continue ordinary reasoning.'
    : 'continue ordinary reasoning and gather authorized evidence if useful.';
  return emit(`${prefix}JEV advisory: ${fields.join('; ')}; ${suffix}`);
}

function resultStatus(result: DecisionAssessment | undefined): string {
  if (result?.status === 'assessed' && typeof result.choice === 'string' && ACTION_CHOICES.has(result.choice)) return result.choice;
  return 'unavailable';
}

async function writeInvocationReceipt(event: NormalizedEvent, env: NodeJS.ProcessEnv, input: DecisionInput, response: ReturnType<typeof semanticResponse>, result: DecisionAssessment | undefined): Promise<void> {
  const sessionDirectory = await privateSessionDirectory(event, env, true);
  if (!sessionDirectory) return;
  const directory = join(sessionDirectory, INVOCATION_DIRECTORY);
  const path = join(directory, `${eventKey(event)}.json`);
  try {
    await mkdir(directory, {recursive: true, mode: 0o700});
    const receipt: RecordValue = {
      event: event.name,
      sessionHash: hash(event.sessionId),
      toolIdHash: hash(event.toolUseId || event.agentId || event.turnId || 'none'),
      output: {
        status: typeof response.status === 'string' ? response.status : undefined,
        exitCode: response.exitCode,
        isError: response.isError,
        resultExcerptBytes: response.resultExcerpt === undefined ? undefined : Buffer.byteLength(response.resultExcerpt),
        resultExcerptDigest: response.resultExcerpt === undefined ? undefined : hash(response.resultExcerpt),
      },
      inputDigest: hash(JSON.stringify(input)),
      evidenceIds: input.evidence.map(item => item.id),
      contextBytes: Buffer.byteLength(input.context),
      contextTruncated: input.context.includes('"contextTruncated":true'),
      evidenceTruncated: input.evidence.some(item => {
        const bytes = Buffer.byteLength(item.text);
        if (item.id === 'tool.failure') return bytes >= MAX_FAILURE_EXCERPT_BYTES;
        if (item.id === 'result.tool_summaries') return bytes >= MAX_CONTEXT_BYTES;
        return bytes >= MAX_RESULT_EXCERPT_BYTES;
      }),
      referenceReceiptId: result?.receiptPersisted === true && typeof result?.receiptId === 'string' && /^[a-f0-9-]{1,80}$/.test(result.receiptId) ? result.receiptId : undefined,
      classification: resultStatus(result),
      assessmentStatus: result?.status && ['assessed','abstained','unavailable','skipped','preview'].includes(result.status) ? result.status : 'unavailable',
      confidence: typeof result?.confidence === 'number' && Number.isFinite(result.confidence) && result.confidence >= 0 && result.confidence <= 1 ? result.confidence : undefined,
      reasonCode: result?.reasonCode && /^[a-z_]{1,80}$/.test(result.reasonCode) ? result.reasonCode : undefined,
    };
    const contents = JSON.stringify(receipt) + '\n';
    const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(contents, 'utf8'); } finally { await handle.close(); }
  } catch { /* receipts are private proof and never affect hook behavior */ }
}

function defaultService(env: NodeJS.ProcessEnv, timeoutMs = PROVIDER_TIMEOUT_MS): DecisionService {
  return createService({timeoutMs, env}) as unknown as DecisionService;
}

export async function runDecisionHook(raw: string | Uint8Array | unknown, options: {env?: NodeJS.ProcessEnv; service?: DecisionService; hookTimeoutMs?: number} = {}): Promise<HookResult> {
  try {
    const env = options.env ?? process.env;
    const policy = await readPolicy(env);
    if (!policy.enabled || env.JEV_ENABLED === '0') return {};
    let parsed: unknown = raw;
    if (typeof raw === 'string' || raw instanceof Uint8Array) {
      if (Buffer.byteLength(raw) > MAX_STDIN_BYTES) {
        return {systemMessage: 'JEV advisory: status=skipped; reason=hook_input_too_large; continue ordinary reasoning and gather authorized evidence if useful.'};
      }
      parsed = JSON.parse(typeof raw === 'string' ? raw : Buffer.from(raw).toString('utf8')) as unknown;
    }
    const event = normalizeDecisionEvent(parsed);
    if (!event || !(await workspaceAllowed(policy, event.cwd)) || isInternal(event, env)) return {};
    if (event.name === 'SessionStart') {
      if (!(await claimEvent(event, policy, env))) return {};
      return instructionOutput(event);
    }
    const taskPrompt = event.name === 'UserPromptSubmit'
      ? await updatePromptCache(event, env)
      : await readPromptCache(event, env);
    if (!(await claimEvent(event, policy, env))) return {};
    const response = semanticResponse(event, env);
    if (event.name === 'PostToolUse') await updateTurnResultCache(event, response, env);
    const turnResults = event.name === 'Stop' || event.name === 'SubagentStop' || event.name === 'Interrupt'
      ? await readTurnResultCache(event, env) : undefined;
    const shortEvent = event.name === 'SessionEnd' || event.name === 'Interrupt';
    const service = options.service ?? defaultService(env, shortEvent ? SHORT_EVENT_PROVIDER_TIMEOUT_MS : PROVIDER_TIMEOUT_MS);
    const controller = new AbortController();
    const eventTimeoutMs = shortEvent ? SHORT_EVENT_HOOK_TIMEOUT_MS : HOOK_TIMEOUT_MS;
    const timeoutMs = options.hookTimeoutMs === undefined ? eventTimeoutMs : Math.min(Math.max(options.hookTimeoutMs, 1), eventTimeoutMs);
    let timeoutResolve: ((value: DecisionAssessment) => void) | undefined;
    const timeout = new Promise<DecisionAssessment>(resolve => { timeoutResolve = resolve; });
    const timer = setTimeout(() => {
      controller.abort();
      timeoutResolve?.({status: 'unavailable', reasonCode: 'hook_timeout'});
    }, timeoutMs);
    const input = decisionInput(event, env, taskPrompt, turnResults);
    let result: DecisionAssessment;
    try {
      result = await Promise.race([service.classifyDecision(input, controller.signal), timeout]);
    } catch {
      result = {status: 'unavailable', reasonCode: 'service_error'};
    } finally {
      clearTimeout(timer);
    }
    await writeInvocationReceipt(event, env, input, response, result);
    return decisionOutput(event, result);
  } catch {
    return {};
  }
}

async function readStdin(): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.byteLength;
    if (total > MAX_STDIN_BYTES) return new Uint8Array(MAX_STDIN_BYTES + 1);
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

async function main(): Promise<void> {
  const result = await runDecisionHook(await readStdin());
  process.stdout.write(JSON.stringify(result));
}

if (process.argv[1] && import.meta.url === pathToFileURL(await realpath(process.argv[1])).href) void main().catch(() => process.stdout.write('{}'));
