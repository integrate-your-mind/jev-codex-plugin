import { mkdir, open, rename, unlink, link, rmdir, readdir, lstat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

export type Receipt = Record<string, unknown>;
export interface Store {
  reserve(bytes: number): Promise<boolean>;
  save(receipt: Receipt): Promise<void>;
}

const MAX_STATE_FILE_BYTES = 65536;
const MAX_BUDGET_FILE_BYTES = 4096;
const LOCK_WAIT_ATTEMPTS = 50;
const LOCK_WAIT_MS = 10;
// A lock is only reclaimed after the owner has had enough time to finish a
// normal write.  A live PID is never reclaimed, even when the lock is old.
const STALE_LOCK_MS = 30_000;

export function validateReservationBytes(bytes: number): void {
  if (!Number.isSafeInteger(bytes) || bytes < 0) throw new TypeError('invalid_reservation_bytes');
}

function validateLimit(value: number | null, name: string): void {
  if (value !== null && (!Number.isSafeInteger(value) || value < 0)) throw new TypeError(`invalid_${name}`);
}

type LockOwner = {pid: number; token: string; createdAt: string};

function lockData(token: string): LockOwner {
  return {pid: process.pid, token, createdAt: new Date().toISOString()};
}

async function processIsAlive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

type ObservedLock = {owner: LockOwner | null; mtimeMs: number; dev: number; ino: number; directory: boolean; entry: string | null};
const OWNER_FILE = /^owner-[a-f0-9-]{36}\.json$/;

async function readLock(path: string): Promise<ObservedLock | null> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink()) return null;
    const directory = info.isDirectory();
    let entry: string | null = null;
    if (directory) {
      const entries = await readdir(path);
      if (entries.length === 0) return {owner: null, mtimeMs: info.mtimeMs, dev: info.dev, ino: info.ino, directory, entry};
      if (entries.length !== 1 || !OWNER_FILE.test(entries[0]!)) return null;
      entry = entries[0]!;
    } else if (!info.isFile()) return null;
    const handle = await open(entry ? join(path, entry) : path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const file = await handle.stat();
      if (!file.isFile() || file.size > 2048) return null;
      let owner: LockOwner | null = null;
      try {
        const value = JSON.parse(await handle.readFile('utf8')) as Partial<LockOwner>;
        if (Number.isSafeInteger(value.pid) && (value.pid as number) > 0 &&
            typeof value.token === 'string' && /^[a-f0-9-]{36}$/.test(value.token) &&
            typeof value.createdAt === 'string' && Number.isFinite(Date.parse(value.createdAt)) &&
            (!entry || entry === `owner-${value.token}.json`)) {
          owner = {pid: value.pid as number, token: value.token, createdAt: value.createdAt};
        }
      } catch { /* malformed legacy files can only be reclaimed after the age check */ }
      if (directory && !owner) return null;
      return {owner, mtimeMs: info.mtimeMs, dev: info.dev, ino: info.ino, directory, entry};
    } finally { await handle.close(); }
  } catch { return null; }
}

async function reclaimStaleLock(path: string): Promise<boolean> {
  const observed = await readLock(path);
  if (!observed || Date.now() - observed.mtimeMs < STALE_LOCK_MS) return false;
  if (observed.owner && await processIsAlive(observed.owner.pid)) return false;
  try {
    if (observed.directory) {
      // Each generation has a different filename. A delayed reclaimer cannot
      // remove a replacement owner's file, and rmdir cannot remove its nonempty directory.
      if (observed.entry) await unlink(join(path, observed.entry));
      await rmdir(path);
    } else {
      // Legacy locks were files. unlink cannot remove a newly published directory.
      const current = await lstat(path);
      if (current.dev !== observed.dev || current.ino !== observed.ino) return false;
      await unlink(path);
    }
    return true;
  } catch { return false; }
}

async function acquireLock(path: string, attempts = LOCK_WAIT_ATTEMPTS): Promise<{handle: Awaited<ReturnType<typeof open>>; token: string}> {
  const token = randomUUID();
  const entry = `owner-${token}.json`;
  const temporary = join(dirname(path), `.${basename(path)}-${token}.tmp`);
  await mkdir(temporary, {mode: 0o700});
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let published = false;
  try {
    handle = await open(join(temporary, entry), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    await handle.writeFile(JSON.stringify(lockData(token)));
    await handle.sync();
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        // A complete nonempty directory is published in one operation. rename
        // cannot replace another owner's nonempty directory.
        await rename(temporary, path);
        published = true;
        return {handle, token};
      } catch (error) {
        if (!['EEXIST', 'ENOTEMPTY', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      }
      await reclaimStaleLock(path);
      if (attempt + 1 < attempts) await delay(LOCK_WAIT_MS);
    }
    throw new Error('budget_busy');
  } finally {
    if (!published) await handle?.close().catch(() => {});
    await unlink(join(temporary, entry)).catch(() => {});
    await rmdir(temporary).catch(() => {});
  }
}

async function releaseLock(path: string, handle: Awaited<ReturnType<typeof open>>, token: string): Promise<void> {
  await handle.close().catch(() => {});
  try {
    await unlink(join(path, `owner-${token}.json`));
    await rmdir(path);
  } catch { /* preserve a lock owned by a different writer */ }
}

async function readBudget(path: string): Promise<{calls: number; bytes: number}> {
  let handle;
  try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {calls: 0, bytes: 0}; throw error; }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_BUDGET_FILE_BYTES) throw new Error('invalid_budget');
    const data = JSON.parse(await handle.readFile('utf8')) as {calls?: unknown; bytes?: unknown};
    if (!Number.isSafeInteger(data.calls) || (data.calls as number) < 0 ||
        !Number.isSafeInteger(data.bytes) || (data.bytes as number) < 0) throw new Error('invalid_budget');
    return {calls: data.calls as number, bytes: data.bytes as number};
  } finally { await handle.close(); }
}

async function writeBudget(path: string, temporary: string, usage: {calls: number; bytes: number}): Promise<void> {
  const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    await handle.writeFile(JSON.stringify(usage));
    await handle.sync();
  } finally { await handle.close(); }
  await rename(temporary, path);
}

export interface BudgetUsage {
  date: string;
  countingBasis: 'local_pre_dispatch_reservations';
  reservedAttempts: number | null;
  reservedPayloadBytes: number | null;
  note: string;
  /** Compatibility alias for reservedAttempts, never successful requests. */
  callsUsed: number | null;
  bytesUsed: number | null;
  callsRemaining: number | null;
  bytesRemaining: number | null;
  resetsAt: string;
  status: 'ok' | 'unavailable';
}

/** Read today's budget without creating or changing any state. */
export async function readBudgetUsage(
  directory: string,
  maxCalls: number | null,
  maxBytes: number | null,
  now = new Date(),
): Promise<BudgetUsage> {
  const date = now.toISOString().slice(0, 10);
  const semantics = {
    countingBasis: 'local_pre_dispatch_reservations' as const,
    note: 'Reserved before provider dispatch, including attempts that fail or never receive a response. callsUsed and bytesUsed are compatibility aliases, not successful-request counts or billed usage. See evaluations for retained response evidence.',
  };
  const resetsAt = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)).toISOString();
  const unavailable = (): BudgetUsage => ({
    date,
    ...semantics,
    reservedAttempts: null,
    reservedPayloadBytes: null,
    callsUsed: null,
    bytesUsed: null,
    callsRemaining: 0,
    bytesRemaining: 0,
    resetsAt,
    status: 'unavailable',
  });
  const available = (callsUsed: number, bytesUsed: number): BudgetUsage => ({
    date,
    ...semantics,
    reservedAttempts: callsUsed,
    reservedPayloadBytes: bytesUsed,
    callsUsed,
    bytesUsed,
    callsRemaining: maxCalls === null ? null : Math.max(0, maxCalls - callsUsed),
    bytesRemaining: maxBytes === null ? null : Math.max(0, maxBytes - bytesUsed),
    resetsAt,
    status: 'ok',
  });

  const path = join(directory, `budget-${date}.json`);
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return available(0, 0);
    return unavailable();
  }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_BUDGET_FILE_BYTES) return unavailable();
    const data = JSON.parse(await handle.readFile('utf8')) as {calls?: unknown; bytes?: unknown};
    if (!Number.isSafeInteger(data.calls) || (data.calls as number) < 0 ||
        !Number.isSafeInteger(data.bytes) || (data.bytes as number) < 0) return unavailable();
    return available(data.calls as number, data.bytes as number);
  } catch {
    return unavailable();
  } finally {
    await handle.close();
  }
}

export function dataDirectory(env = process.env): string {
  const override = env.JEV_STATE_DIRECTORY;
  if (override !== undefined && isAbsolute(override) && !override.includes('\0')) return override;
  const userDirectory = join(env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'jev-workflows');
  if (env.JEV_STATE_MODE === 'user') return userDirectory;
  return env.PLUGIN_DATA || userDirectory;
}
export class FileStore implements Store {
  constructor(readonly directory: string, readonly maxCalls: number | null = null, readonly maxBytes: number | null = null) {
    validateLimit(maxCalls, 'max_calls');
    validateLimit(maxBytes, 'max_bytes');
  }
  async reserve(bytes: number): Promise<boolean> {
    validateReservationBytes(bytes);
    await mkdir(this.directory, {recursive: true, mode: 0o700});
    const day = new Date().toISOString().slice(0, 10);
    const path = join(this.directory, `budget-${day}.json`);
    const lock = `${path}.lock`;
    // Unlimited usage is the default.  Keep a best-effort local observation,
    // but never make an advisory reservation wait on a shared accounting lock
    // or fail because another unlimited writer is recording usage.
    const unlimited = this.maxCalls === null && this.maxBytes === null;
    // Even without a configured quota, refuse to proceed over malformed or
    // symlinked state. This protects observability integrity while the lock
    // itself remains best-effort for unlimited callers.
    if (unlimited) await readBudget(path);
    let acquired: Awaited<ReturnType<typeof acquireLock>> | undefined;
    try { acquired = await acquireLock(lock, unlimited ? 1 : LOCK_WAIT_ATTEMPTS); }
    catch (error) {
      if (unlimited && (error as Error).message === 'budget_busy') return true;
      throw error;
    }
    const temporary = join(this.directory, `.budget-${randomUUID()}.tmp`);
    try {
      let usage: {calls: number; bytes: number};
      usage = await readBudget(path);
      if ((this.maxCalls !== null && usage.calls + 1 > this.maxCalls) ||
          (this.maxBytes !== null && usage.bytes + bytes > this.maxBytes)) return false;
      const next = {calls: usage.calls + 1, bytes: usage.bytes + bytes};
      if (!Number.isSafeInteger(next.calls) || !Number.isSafeInteger(next.bytes)) throw new Error('budget_overflow');
      await writeBudget(path, temporary, next);
      return true;
    } finally {
      await releaseLock(lock, acquired.handle, acquired.token);
      await unlink(temporary).catch(() => {});
    }
  }
  async save(receipt: Receipt): Promise<void> {
    const directory = join(this.directory, 'receipts');
    await mkdir(directory, {recursive: true, mode: 0o700});
    // Receipt IDs are generated locally, never taken from tool arguments.
    const receiptId = typeof receipt.receiptId === 'string' && /^[a-f0-9-]{36}$/.test(receipt.receiptId) ? receipt.receiptId : randomUUID();
    const name = `${receiptId}.json`;
    const temporary = join(directory, `.receipt-${randomUUID()}.tmp`);
    try {
      const contents = JSON.stringify(receipt, null, 2) + '\n';
      if (Buffer.byteLength(contents) > MAX_STATE_FILE_BYTES) throw new Error('receipt_too_large');
      const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { await handle.writeFile(contents); await handle.sync(); }
      finally { await handle.close(); }
      // Publish a complete receipt atomically, without overwriting an existing ID.
      await link(temporary, join(directory, name));
      // The receipt is authoritative. Index maintenance is best effort so an
      // interrupted/corrupt index cannot make a successfully published receipt
      // look like a failed save; accounting reports the fallback explicitly.
      await this.updateReceiptIndex(receiptId, receipt.timestamp).catch(() => {});
    } finally { await unlink(temporary).catch(() => {}); }
  }

  /** Add a filename to the per-day index after its receipt is published. */
  private async updateReceiptIndex(receiptId: string, timestamp: unknown): Promise<void> {
    if (typeof timestamp !== 'string' || !Number.isFinite(Date.parse(timestamp))) return;
    const date = new Date(timestamp).toISOString().slice(0, 10);
    const path = join(this.directory, `receipt-index-${date}.json`);
    const lockPath = `${path}.lock`;
    // An index that has outgrown its bound is never updated again (the locked
    // read below rejects it too), so do not contend for its lock on every save.
    const existing = await lstat(path).catch(() => undefined);
    if (existing && (!existing.isFile() || existing.size > MAX_STATE_FILE_BYTES)) return;
    let acquired: Awaited<ReturnType<typeof acquireLock>>;
    try { acquired = await acquireLock(lockPath); }
    catch { return; } // Indexing is observability only; never lose a receipt on a lock failure.
    const temporary = join(this.directory, `.receipt-index-${randomUUID()}.tmp`);
    try {
      let ids: string[] = [];
      try {
        const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
          const info = await handle.stat();
          if (!info.isFile() || info.size > MAX_STATE_FILE_BYTES) throw new Error('invalid_receipt_index');
          const value = JSON.parse(await handle.readFile('utf8')) as {version?: unknown; date?: unknown; receiptIds?: unknown};
          if (value.version !== 1 || value.date !== date || !Array.isArray(value.receiptIds) ||
              value.receiptIds.some(id => typeof id !== 'string' || !/^[a-f0-9-]{36}$/i.test(id))) throw new Error('invalid_receipt_index');
          ids = value.receiptIds as string[];
        } finally { await handle.close(); }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return;
      }
      if (!ids.includes(receiptId)) ids.push(receiptId);
      const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { await handle.writeFile(JSON.stringify({version: 1, date, receiptIds: ids}) + '\n'); await handle.sync(); }
      finally { await handle.close(); }
      await rename(temporary, path);
    } finally {
      await releaseLock(lockPath, acquired.handle, acquired.token);
      await unlink(temporary).catch(() => {});
    }
  }
}
