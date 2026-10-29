import { constants } from 'node:fs';
import { mkdir, open, rename, lstat, realpath, unlink } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { isAbsolute, join, sep } from 'node:path';
import { z } from 'zod';
import { acquireStateLock, releaseStateLock } from './state-lock.js';
import { dataDirectory } from './store.js';

const POLICY_FILE = 'policy.json';
const POLICY_MODE_FILE = 'policy-mode-v1.json';
const MAX_POLICY_BYTES = 8 * 1024;
const DEFAULT_CALL_CAP = null;
const DEFAULT_CALLS_PER_DAY = null;
const DEFAULT_BYTES_PER_DAY = null;
const MAX_WORKSPACES = 64;

export type ConsultationMode = 'changed_state' | 'always';
export type HookScope = 'all-workspaces' | 'workspaces';
export type HookPolicy = {
  enabled: boolean;
  consultationMode?: ConsultationMode;
  scope: HookScope;
  workspaces: string[];
  maxHookCallsPerSession: number | null;
  maxCallsPerDay: number | null;
  maxBytesPerDay: number | null;
};

export const automationPolicySchema = z.strictObject({
  enabled: z.boolean(),
  consultationMode: z.enum(['changed_state', 'always']).optional(),
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
  consultationMode: 'changed_state',
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

const v1PolicySchema = automationPolicySchema.omit({consultationMode: true});
const policyModeSchema = z.strictObject({
  version: z.literal(1), policyDigest: z.string().regex(/^[a-f0-9]{64}$/), consultationMode: z.enum(['changed_state', 'always']),
});

function policyDigest(contents: string): string {
  return createHash('sha256').update(contents).digest('hex');
}

async function readMode(path: string, digest: string): Promise<ConsultationMode> {
  try {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > 512) return 'always';
      const parsed = policyModeSchema.safeParse(JSON.parse(await handle.readFile('utf8')));
      return parsed.success && parsed.data.policyDigest === digest ? parsed.data.consultationMode : 'always';
    } finally { await handle.close(); }
  } catch { return 'always'; }
}

/** V1 authority remains readable by cached strict readers. The sidecar controls mode only. */
export async function readPolicy(env: NodeJS.ProcessEnv = process.env): Promise<HookPolicy> {
  try {
    const path = policyPath(env);
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    let contents: string;
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > MAX_POLICY_BYTES) return {...DEFAULT_POLICY};
      contents = await handle.readFile('utf8');
    } finally { await handle.close(); }
    const policy = v1PolicySchema.parse(JSON.parse(contents));
    if (policy.enabled && policy.scope === 'workspaces' && policy.workspaces.length === 0) return {...DEFAULT_POLICY};
    const consultationMode = await readMode(join(dataDirectory(env), POLICY_MODE_FILE), policyDigest(contents));
    return {...policy, consultationMode};
  } catch { return {...DEFAULT_POLICY}; }
}

async function assertPolicyTarget(path: string): Promise<void> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw new Error('policy_symlink');
    if (!info.isFile()) throw new Error('policy_not_file');
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}

async function stagePolicyFile(path: string, contents: string): Promise<void> {
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(contents, 'utf8'); await handle.sync(); }
  finally { await handle.close(); }
}

/** Publish the mode binding before committing V1 authority; incomplete bindings never grant scope. */
export async function configurePolicy(raw: unknown, env: NodeJS.ProcessEnv = process.env): Promise<HookPolicy> {
  const parsed = normalizePolicy(raw);
  const canonicalWorkspaces: string[] = [];
  for (const workspace of parsed.workspaces) {
    const resolved = await realpath(workspace);
    const info = await lstat(resolved);
    if (!info.isDirectory()) throw new Error('workspace_not_directory');
    canonicalWorkspaces.push(resolved);
  }
  const path = policyPath(env);
  const directory = dataDirectory(env);
  await mkdir(directory, {recursive: true, mode: 0o700});
  const modePath = join(directory, POLICY_MODE_FILE);
  const lockPath = join(directory, 'policy.lock');
  const lock = await acquireStateLock(lockPath);
  const token = randomUUID();
  const temporary = join(directory, `.policy-${token}.tmp`);
  const modeTemporary = join(directory, `.policy-mode-${token}.tmp`);
  try {
    await assertPolicyTarget(path);
    await assertPolicyTarget(modePath);
    const previous = await readPolicy(env);
    const policy: HookPolicy = {...parsed, workspaces: canonicalWorkspaces, consultationMode: parsed.consultationMode ?? previous.consultationMode ?? 'always'};
    const {consultationMode, ...v1Policy} = policy;
    const contents = JSON.stringify(v1Policy) + '\n';
    if (Buffer.byteLength(contents) > MAX_POLICY_BYTES) throw new Error('policy_too_large');
    const modeContents = JSON.stringify({version: 1, policyDigest: policyDigest(contents), consultationMode}) + '\n';
    await stagePolicyFile(temporary, contents);
    await stagePolicyFile(modeTemporary, modeContents);
    await rename(modeTemporary, modePath);
    await rename(temporary, path);
    return policy;
  } finally {
    await unlink(temporary).catch(() => {});
    await unlink(modeTemporary).catch(() => {});
    await releaseStateLock(lockPath, lock.handle, lock.token);
  }
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
