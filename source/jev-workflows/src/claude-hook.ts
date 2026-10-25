import { constants } from 'node:fs';
import { mkdir, open, realpath, rename, unlink, lstat } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { join, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { dataDirectory } from './store.js';
import { readPolicy, workspaceAllowed } from './policy.js';
import { runDecisionHook, type DecisionService } from './decision-hook.js';

type RecordValue = Record<string, unknown>;
type ClaudeHookResult = {
  hookSpecificOutput?: {hookEventName: string; additionalContext: string};
  systemMessage?: string;
};

const SUPPORTED_EVENTS = new Set([
  'SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse',
  'PostToolUseFailure', 'PermissionRequest', 'PreCompact', 'PostCompact',
  'SubagentStart', 'SubagentStop', 'Stop',
]);
const TURN_EVENTS = new Set([
  'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure',
  'PermissionRequest', 'PreCompact', 'PostCompact', 'SubagentStart',
  'SubagentStop', 'Stop',
]);
const TURN_DIRECTORY = 'claude-turns-v1';
const HOST_PREFIX = 'claude:';
const MAX_STDIN_BYTES = 128 * 1024;
const CLAUDE_INTERNAL_TOOL_PREFIX = 'mcp__plugin_jev-workflows_jev-workflows__';

function isRecord(value: unknown): value is RecordValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function validIdentity(raw: RecordValue): boolean {
  return typeof raw.session_id === 'string' && raw.session_id.length > 0 &&
    typeof raw.cwd === 'string' && isAbsolute(raw.cwd) &&
    typeof raw.hook_event_name === 'string' && SUPPORTED_EVENTS.has(raw.hook_event_name);
}

function isClaudeInternalTool(raw: RecordValue): boolean {
  return typeof raw.tool_name === 'string' && raw.tool_name.startsWith(CLAUDE_INTERNAL_TOOL_PREFIX);
}

async function turnStatePath(raw: RecordValue, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  if (!validIdentity(raw)) return undefined;
  const directory = dataDirectory(env);
  if (!isAbsolute(directory) || directory.includes('\0')) return undefined;
  try {
    const canonicalDirectory = await realpath(directory);
    const info = await lstat(canonicalDirectory);
    if (!info.isDirectory() || info.isSymbolicLink()) return undefined;
    return join(canonicalDirectory, TURN_DIRECTORY, hash(raw.cwd as string), hash(`${HOST_PREFIX}${raw.session_id as string}`), 'turn.json');
  } catch {
    return undefined;
  }
}

export async function ensurePrivateDirectory(path: string): Promise<boolean> {
  if (!isAbsolute(path) || path.includes('\0')) return false;
  const parts = path.split('/').filter(Boolean);
  let current = '/';
  try {
    for (const part of parts) {
      current = join(current, part);
      try {
        const info = await lstat(current);
        if (info.isSymbolicLink() || !info.isDirectory()) return false;
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) return false;
        await mkdir(current, {mode: 0o700});
        const info = await lstat(current);
        if (info.isSymbolicLink() || !info.isDirectory()) return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

async function readStoredTurn(path: string): Promise<string | undefined> {
  try {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > 512) return undefined;
      const value = JSON.parse(await handle.readFile('utf8')) as RecordValue;
      return typeof value.turnId === 'string' && /^[a-f0-9-]{36}$/.test(value.turnId) ? value.turnId : undefined;
    } finally {
      await handle.close();
    }
  } catch {
    return undefined;
  }
}

async function writeStoredTurn(path: string, turnId: string): Promise<boolean> {
  const directory = join(path, '..');
  try {
    if (!await ensurePrivateDirectory(directory)) return false;
    const existing = await lstat(path).catch(() => undefined);
    if (existing && (!existing.isFile() || existing.isSymbolicLink())) return false;
    const temporary = join(directory, `.turn-${randomUUID()}.tmp`);
    const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      await handle.writeFile(JSON.stringify({turnId, updatedAt: Date.now()}) + '\n', 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await rename(temporary, path);
    } finally {
      await unlink(temporary).catch(() => {});
    }
    return true;
  } catch {
    return false;
  }
}

async function resolveTurn(raw: RecordValue, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  const eventName = raw.hook_event_name as string;
  const path = await turnStatePath(raw, env);
  if (!path) return undefined;
  if (!await ensurePrivateDirectory(join(path, '..'))) return undefined;
  if (eventName === 'UserPromptSubmit') {
    const turnId = randomUUID();
    return await writeStoredTurn(path, turnId) ? turnId : undefined;
  }
  if (!TURN_EVENTS.has(eventName)) return undefined;
  return await readStoredTurn(path);
}

function commonEvent(raw: RecordValue, turnId: string | undefined): RecordValue {
  const originalName = raw.hook_event_name as string;
  const eventName = originalName === 'PostToolUseFailure' ? 'PostToolUse' : originalName;
  const sessionId = `${HOST_PREFIX}${raw.session_id as string}`;
  const event: RecordValue = {...raw, hook_event_name: eventName, session_id: sessionId};
  if (turnId) event.turn_id = turnId;
  if (originalName === 'PostToolUseFailure') {
    event.tool_response = {
      isError: true,
      status: 'failed',
      error: typeof raw.error === 'string' ? raw.error : 'tool failed',
    };
  }
  return event;
}

function restoreOutput(result: ClaudeHookResult, originalName: string): ClaudeHookResult {
  if (result.hookSpecificOutput) {
    return { ...result, hookSpecificOutput: {...result.hookSpecificOutput, hookEventName: originalName} };
  }
  return result;
}

export async function runClaudeHook(
  raw: string | Uint8Array | unknown,
  options: {env?: NodeJS.ProcessEnv; service?: DecisionService; hookTimeoutMs?: number; fetchFn?: typeof fetch} = {},
): Promise<ClaudeHookResult> {
  try {
    if ((typeof raw === 'string' && Buffer.byteLength(raw) > MAX_STDIN_BYTES) ||
        (raw instanceof Uint8Array && raw.byteLength > MAX_STDIN_BYTES)) return {};
    const parsed = typeof raw === 'string' || raw instanceof Uint8Array
      ? JSON.parse(typeof raw === 'string' ? raw : Buffer.from(raw).toString('utf8')) as unknown
      : raw;
    if (!isRecord(parsed) || !validIdentity(parsed)) return {};
    const originalName = parsed.hook_event_name as string;
    const env = options.env ?? process.env;
    const policy = await readPolicy(env);
    if (!policy.enabled || env.JEV_ENABLED === '0' || !await workspaceAllowed(policy, parsed.cwd as string)) return {};
    if (isClaudeInternalTool(parsed)) return {};
    const turnId = await resolveTurn(parsed, env);
    if (TURN_EVENTS.has(originalName) && !turnId) return {};
    const result = await runDecisionHook(commonEvent(parsed, turnId), options);
    return restoreOutput(result, originalName);
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
  process.stdout.write(JSON.stringify(await runClaudeHook(await readStdin())));
}

if (process.argv[1] && import.meta.url === pathToFileURL(await realpath(process.argv[1])).href) void main().catch(() => process.stdout.write('{}'));

