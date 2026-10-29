import {mkdir, open, rename, unlink, rmdir, readdir, lstat} from 'node:fs/promises';
import {constants} from 'node:fs';
import {basename, dirname, join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';

const LOCK_WAIT_ATTEMPTS = 50;
const LOCK_WAIT_MS = 10;
const STALE_LOCK_MS = 30_000;

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

export async function acquireStateLock(path: string, attempts = LOCK_WAIT_ATTEMPTS): Promise<{handle: Awaited<ReturnType<typeof open>>; token: string}> {
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

export async function releaseStateLock(path: string, handle: Awaited<ReturnType<typeof open>>, token: string): Promise<void> {
  await handle.close().catch(() => {});
  try {
    await unlink(join(path, `owner-${token}.json`));
    await rmdir(path);
  } catch { /* preserve a lock owned by a different writer */ }
}
