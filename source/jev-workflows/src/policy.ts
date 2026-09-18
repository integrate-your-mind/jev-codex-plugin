import { constants } from 'node:fs';
import { mkdir, open, rename, lstat, realpath, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { isAbsolute, join, sep } from 'node:path';
import { z } from 'zod';
import { dataDirectory } from './store.js';

const POLICY_FILE = 'policy.json';
const MAX_POLICY_BYTES = 8 * 1024;
const DEFAULT_CALL_CAP = null;
const DEFAULT_CALLS_PER_DAY = null;
const DEFAULT_BYTES_PER_DAY = null;
const MAX_WORKSPACES = 64;

export type HookScope = 'all-workspaces' | 'workspaces';
export type HookPolicy = {
  enabled: boolean;
  scope: HookScope;
  workspaces: string[];
  maxHookCallsPerSession: number | null;
  maxCallsPerDay: number | null;
  maxBytesPerDay: number | null;
};

export const automationPolicySchema = z.strictObject({
  enabled: z.boolean(),
  scope: z.enum(['all-workspaces', 'workspaces']).default('workspaces'),
  workspaces: z.array(z.string().min(1).max(4096).refine(validRoot, 'workspace must be absolute')).max(MAX_WORKSPACES).default([]),
  // These are optional user-selected caps. Safe-integer validation protects
  // accounting arithmetic; the plugin imposes no independent usage ceiling.
  maxHookCallsPerSession: z.number().int().nonnegative().nullable().default(DEFAULT_CALL_CAP),
  maxCallsPerDay: z.number().int().nonnegative().nullable().default(DEFAULT_CALLS_PER_DAY),
  maxBytesPerDay: z.number().int().nonnegative().nullable().default(DEFAULT_BYTES_PER_DAY),
});

export const DEFAULT_POLICY: HookPolicy = {
  enabled: false,
  scope: 'workspaces',
  workspaces: [],
  maxHookCallsPerSession: DEFAULT_CALL_CAP,
  maxCallsPerDay: DEFAULT_CALLS_PER_DAY,
  maxBytesPerDay: DEFAULT_BYTES_PER_DAY,
};

function policyPath(env: NodeJS.ProcessEnv): string {
  const directory = dataDirectory(env);
  if (!isAbsolute(directory) || directory.includes('\0')) throw new Error('invalid_policy_directory');
  return join(directory, POLICY_FILE);
}

function validRoot(value: unknown): value is string {
  return typeof value === 'string' && isAbsolute(value) && !value.includes('\0') && value.length <= 4096;
}

function normalizePolicy(raw: unknown): HookPolicy {
  const parsed = automationPolicySchema.safeParse(raw);
  if (!parsed.success) throw new Error('invalid_policy');
  if (parsed.data.scope === 'workspaces' && parsed.data.workspaces.length === 0 && parsed.data.enabled) throw new Error('no_allowed_roots');
  return parsed.data;
}

/** Read only the exact bounded policy file. Malformed or symlinked state fails closed. */
export async function readPolicy(env: NodeJS.ProcessEnv = process.env): Promise<HookPolicy> {
  try {
    const path = policyPath(env);
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > MAX_POLICY_BYTES) return {...DEFAULT_POLICY};
      const value = JSON.parse(await handle.readFile('utf8')) as unknown;
      return normalizePolicy(value);
    } finally {
      await handle.close();
    }
  } catch {
    return {...DEFAULT_POLICY};
  }
}

/** Atomically write validated private policy state for the MCP configure handler. */
export async function configurePolicy(raw: unknown, env: NodeJS.ProcessEnv = process.env): Promise<HookPolicy> {
  const parsed = normalizePolicy(raw);
  const canonicalWorkspaces: string[] = [];
  for (const workspace of parsed.workspaces) {
    const resolved = await realpath(workspace);
    const info = await lstat(resolved);
    if (!info.isDirectory()) throw new Error('workspace_not_directory');
    canonicalWorkspaces.push(resolved);
  }
  const policy: HookPolicy = {...parsed, workspaces: canonicalWorkspaces};
  const directory = dataDirectory(env);
  if (!isAbsolute(directory) || directory.includes('\0')) throw new Error('invalid_policy_directory');
  await mkdir(directory, {recursive: true, mode: 0o700});
  const path = policyPath(env);
  try {
    const link = await lstat(path);
    if (link.isSymbolicLink()) throw new Error('policy_symlink');
    if (!link.isFile()) throw new Error('policy_not_file');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const temporary = join(directory, `.policy-${randomUUID()}.tmp`);
  const contents = JSON.stringify(policy) + '\n';
  if (Buffer.byteLength(contents) > MAX_POLICY_BYTES) throw new Error('policy_too_large');
  const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    await handle.writeFile(contents, 'utf8');
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
  return policy;
}

export async function workspaceAllowed(policy: HookPolicy, cwd: string): Promise<boolean> {
  if (!isAbsolute(cwd) || cwd.includes('\0')) return false;
  let resolvedCwd: string;
  try {
    resolvedCwd = await realpath(cwd);
  } catch {
    return false;
  }
  if (policy.scope === 'all-workspaces') return true;
  for (const root of policy.workspaces) {
    try {
      const rootInfo = await lstat(root);
      if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) continue;
      const resolvedRoot = await realpath(root);
      // Configured roots are canonicalized. If the path is replaced or
      // retargeted after configuration, fail closed rather than broadening it.
      if (resolvedRoot !== root) continue;
      if (resolvedCwd === resolvedRoot || resolvedCwd.startsWith(`${resolvedRoot}${sep}`)) return true;
    } catch {
      // Missing roots cannot authorize a hook.
    }
  }
  return false;
}
