import { mkdir, open, rename, unlink, writeFile, link } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

export type Receipt = Record<string, unknown>;
export interface Store {
  reserve(bytes: number): Promise<boolean>;
  save(receipt: Receipt): Promise<void>;
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
    if (!info.isFile() || info.size > 4096) return unavailable();
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
  constructor(readonly directory: string, readonly maxCalls: number | null = null, readonly maxBytes: number | null = null) {}
  async reserve(bytes: number): Promise<boolean> {
    await mkdir(this.directory, {recursive: true, mode: 0o700});
    const day = new Date().toISOString().slice(0, 10);
    const path = join(this.directory, `budget-${day}.json`);
    const lock = `${path}.lock`;
    let handle;
    for (let attempt = 0; attempt < 50; attempt++) {
      try { handle = await open(lock, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600); break; }
      catch (err) { if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err; await delay(10); }
    }
    if (!handle) throw new Error('budget_busy');
    const temporary = join(this.directory, `.budget-${randomUUID()}.tmp`);
    try {
      let usage = {calls: 0, bytes: 0};
      try {
        const f = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          if ((await f.stat()).size > 4096) throw new Error('invalid_budget');
          const data = JSON.parse(await f.readFile('utf8'));
          if (!Number.isSafeInteger(data.calls) || data.calls < 0 || !Number.isSafeInteger(data.bytes) || data.bytes < 0) throw new Error('invalid_budget');
          usage = {calls: data.calls, bytes: data.bytes};
        } finally { await f.close(); }
      } catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err; }
      if ((this.maxCalls !== null && usage.calls + 1 > this.maxCalls) ||
          (this.maxBytes !== null && usage.bytes + bytes > this.maxBytes)) return false;
      await writeFile(temporary, JSON.stringify({calls: usage.calls + 1, bytes: usage.bytes + bytes}), {mode: 0o600, flag: 'wx'});
      await rename(temporary, path);
      return true;
    } finally {
      await handle.close();
      await unlink(temporary).catch(() => {});
      await unlink(lock);
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
      await writeFile(temporary, JSON.stringify(receipt, null, 2) + '\n', {mode: 0o600, flag: 'wx'});
      // Publish a complete receipt atomically, without overwriting an existing ID.
      await link(temporary, join(directory, name));
    } finally { await unlink(temporary).catch(() => {}); }
  }
}
