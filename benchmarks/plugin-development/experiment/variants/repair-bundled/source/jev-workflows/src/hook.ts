import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { mkdir, open, realpath } from 'node:fs/promises';
import { isAbsolute, join, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createService } from './service.js';

const MAX_STDIN_BYTES = 128 * 1024;
const MAX_TASK_BYTES = 4_000;
const MAX_COMMAND_BYTES = 4_000;
const MAX_OUTPUT_BYTES = 24_000;
const PROVIDER_TIMEOUT_MS = 2_000;
const EVENT_DIRECTORY = 'hook-events-v1';

const LOCAL_ADVISORY = 'JEV local preview: failed Bash command is ready for authorized diagnosis via diagnose-failure or classify_failure.';

export type HookResult = {
  hookSpecificOutput?: {
    hookEventName: 'PostToolUse';
    additionalContext: string;
  };
};

export type FailureInput = {
  task: string;
  command: string;
  exitCode: number | null;
  output: string;
  evidence: Array<{ id: string; text: string; source?: string }>;
  outputTruncated: boolean;
  mode: 'evaluate' | 'preview';
};

export type FailureResult = {
  status?: string;
  category?: string;
  workflow?: string;
  reasonCode?: string;
  confidence?: number;
  receiptId?: string;
};

export type FailureService = {
  classifyFailure(input: FailureInput, signal?: AbortSignal): Promise<FailureResult>;
  status?: () => unknown;
};

export type HookDependencies = {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  signal?: AbortSignal;
  service?: FailureService;
  serviceFactory?: () => FailureService | Promise<FailureService>;
};

type RecordValue = Record<string, unknown>;

type NormalizedEvent = {
  input: FailureInput;
  toolUseId: string;
  turnId: string;
  sessionId: string;
  cwd: string;
};

function isRecord(value: unknown): value is RecordValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown, maxBytes = 8 * 1024): string | undefined {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > maxBytes) return undefined;
  return value;
}

function boundedOutput(value: string): { text: string; truncated: boolean } {
  if (Buffer.byteLength(value, 'utf8') <= MAX_OUTPUT_BYTES) return { text: value, truncated: false };
  return { text: Buffer.from(value, 'utf8').subarray(0, MAX_OUTPUT_BYTES).toString('utf8'), truncated: true };
}

function integerValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined;
}

function parseStandardFailure(value: string): { exitCode: number; output: string; outputTruncated: boolean } | undefined {
  const outputMatch = value.match(/\bOutput\s*:/);
  if (!outputMatch || outputMatch.index === undefined) return undefined;
  const prefix = value.slice(0, outputMatch.index);
  const matches = [...prefix.matchAll(/Process\s+(?:exited\s+with\s+code|exit\s+code:)\s*(-?\d+)/g)];
  if (matches.length !== 1) return undefined;
  const match = matches[0];
  const code = Number(match?.[1]);
  if (!Number.isSafeInteger(code) || code === 0) return undefined;

  const output = value.slice(outputMatch.index + outputMatch[0].length).replace(/^\r?\n/, '');
  const bounded = boundedOutput(output);
  return { exitCode: code, output: bounded.text, outputTruncated: bounded.truncated };
}

function parseNativeFailure(value: unknown): { exitCode: number; output: string; outputTruncated: boolean } | undefined {
  if (!isRecord(value)) return undefined;
  // This is deliberately the unified-exec result shape. In particular, a
  // pending session has no exit_code and must not cause an early request.
  const exitCode = integerValue(value.exit_code);
  const output = stringValue(value.output, MAX_STDIN_BYTES);
  if (exitCode === undefined || exitCode === 0 || output === undefined) return undefined;
  const outputTruncated = value.output_truncated === true;
  const bounded = boundedOutput(output);
  return { exitCode, output: bounded.text, outputTruncated: outputTruncated || bounded.truncated };
}

function parseToolResponse(value: unknown): { exitCode: number; output: string; outputTruncated: boolean } | undefined {
  if (typeof value === 'string') return parseStandardFailure(value);
  return parseNativeFailure(value);
}

/** Normalize only a completed, failed Bash PostToolUse event. */
export function normalizeHookEvent(raw: unknown, fallbackCwd?: string): NormalizedEvent | undefined {
  if (!isRecord(raw)) return undefined;
  if (raw.hook_event_name !== 'PostToolUse' || raw.tool_name !== 'Bash') return undefined;

  const cwd = stringValue(raw.cwd, 16 * 1024) ?? fallbackCwd;
  const toolUseId = stringValue(raw.tool_use_id, 512);
  const turnId = stringValue(raw.turn_id, 512);
  const sessionId = stringValue(raw.session_id, 512);
  const command = isRecord(raw.tool_input) ? stringValue(raw.tool_input.command, MAX_COMMAND_BYTES) : undefined;
  if (!cwd || !toolUseId || !turnId || !sessionId || !command) return undefined;

  const parsed = parseToolResponse(raw.tool_response);
  if (!parsed) return undefined;

  const task = stringValue(raw.task, MAX_TASK_BYTES) ?? command;
  const evidence = Array.isArray(raw.evidence)
    ? raw.evidence.flatMap((item): Array<{ id: string; text: string; source?: string }> => {
        if (!isRecord(item)) return [];
        const id = stringValue(item.id, 80);
        const text = stringValue(item.text, 12_000);
        const source = item.source === undefined ? undefined : stringValue(item.source, 500);
        if (!id || !text || (item.source !== undefined && !source) || !/^[a-zA-Z0-9._:-]{1,80}$/.test(id)) return [];
        return [{ id, text, ...(source ? { source } : {}) }];
      }).slice(0, 12)
    : [];
  const explicitTruncated = raw.outputTruncated === true || raw.output_truncated === true;
  return {
    cwd,
    toolUseId,
    turnId,
    sessionId,
    input: {
      task,
      command,
      exitCode: parsed.exitCode,
      output: parsed.output,
      evidence,
      outputTruncated: explicitTruncated || parsed.outputTruncated,
      mode: 'preview',
    },
  };
}

function parseAllowedWorkspaces(env: NodeJS.ProcessEnv): string[] | undefined {
  const value = env.JEV_ALLOWED_WORKSPACES;
  if (!value) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed) || parsed.length === 0) return undefined;
    const roots = parsed.filter((item): item is string => typeof item === 'string' && item.length > 0);
    return roots.length === parsed.length ? roots : undefined;
  } catch {
    return undefined;
  }
}

async function isAllowedWorkspace(cwd: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  const roots = parseAllowedWorkspaces(env);
  if (!roots) return false;
  let resolvedCwd: string;
  try {
    resolvedCwd = await realpath(cwd);
  } catch {
    return false;
  }
  for (const root of roots) {
    try {
      const resolvedRoot = await realpath(root);
      if (resolvedCwd === resolvedRoot || resolvedCwd.startsWith(`${resolvedRoot}${sep}`)) return true;
    } catch {
      // A missing or inaccessible allowlisted root cannot authorize a request.
    }
  }
  return false;
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

async function claimEvent(event: NormalizedEvent, env: NodeJS.ProcessEnv): Promise<boolean> {
  const pluginData = env.PLUGIN_DATA;
  if (!pluginData || !isAbsolute(pluginData)) return false;
  let dataRoot: string;
  let workspace: string;
  try {
    await mkdir(pluginData, { recursive: true, mode: 0o700 });
    dataRoot = await realpath(pluginData);
    workspace = await realpath(event.cwd);
  } catch {
    return false;
  }

  const workspaceDir = join(dataRoot, EVENT_DIRECTORY, digest(workspace));
  const eventName = digest(`${event.sessionId}\0${event.turnId}\0${event.toolUseId}`);
  try {
    await mkdir(workspaceDir, { recursive: true, mode: 0o700 });
    const handle = await open(join(workspaceDir, eventName), fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
    await handle.close();
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === 'EEXIST') return false;
    return false;
  }
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && 'code' in value;
}

function defaultService(env: NodeJS.ProcessEnv): FailureService {
  return createService({ timeoutMs: PROVIDER_TIMEOUT_MS, env });
}

/** Run one hook request. All failure paths deliberately return an empty object. */
export async function runHook(raw: string | Uint8Array | unknown, dependencies: HookDependencies = {}): Promise<HookResult> {
  try {
    let parsed: unknown = raw;
    if (typeof raw === 'string' || raw instanceof Uint8Array) {
      if (Buffer.byteLength(raw) > MAX_STDIN_BYTES) return {};
      parsed = JSON.parse(typeof raw === 'string' ? raw : Buffer.from(raw).toString('utf8')) as unknown;
    }
    const env = dependencies.env ?? process.env;
    if (env.JEV_HOOKS_ENABLED !== '1' || env.JEV_ENABLED === '0') return {};
    const event = normalizeHookEvent(parsed, dependencies.cwd);
    if (!event || !(await isAllowedWorkspace(event.cwd, env))) return {};
    if (dependencies.signal?.aborted) return {};
    if (!(await claimEvent(event, env))) return {};

    const service = dependencies.service ?? (dependencies.serviceFactory ? await dependencies.serviceFactory() : await defaultService(env));
    const controller = new AbortController();
    let callerResolve: ((value: undefined) => void) | undefined;
    const callerAbort = dependencies.signal
      ? new Promise<undefined>((resolve) => {
          callerResolve = resolve;
        })
      : undefined;
    const abortFromCaller = () => {
      controller.abort();
      callerResolve?.(undefined);
    };
    dependencies.signal?.addEventListener('abort', abortFromCaller, { once: true });
    let timeoutResolve: ((value: undefined) => void) | undefined;
    const timeout = new Promise<undefined>((resolve) => {
      timeoutResolve = resolve;
    });
    const timer = setTimeout(() => {
      controller.abort();
      timeoutResolve?.(undefined);
    }, PROVIDER_TIMEOUT_MS);
    try {
      const pending: Array<Promise<FailureResult | undefined>> = [service.classifyFailure(event.input, controller.signal), timeout];
      if (callerAbort) pending.push(callerAbort);
      const result = await Promise.race(pending);
      if (!result || typeof result !== 'object') return {};
      return { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: LOCAL_ADVISORY } };
    } finally {
      clearTimeout(timer);
      dependencies.signal?.removeEventListener('abort', abortFromCaller);
    }
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
  const input = await readStdin();
  const result = await runHook(input);
  process.stdout.write(JSON.stringify(result));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch(() => process.stdout.write('{}'));
}
