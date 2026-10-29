import {constants} from 'node:fs';
import {lstat, open, readdir, unlink} from 'node:fs/promises';
import {basename, dirname, join} from 'node:path';
import {acquireStateLock, releaseStateLock} from '../../state-lock.js';
import {MAX_RECORD_BYTES, batchKey, parseRecord, type DecisionRecord} from './bridge.js';

const MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;
const RECORD_NAME = /^[a-f0-9]{16}\.json$/;
const CLAIM_NAME = /^[a-f0-9]{16}\.json\.claim$/;
async function owned(path: string, before: number) {
  try {
    const info = await lstat(path);
    return info.isFile() && !info.isSymbolicLink() && info.uid === process.getuid?.() && (info.mode & 0o077) === 0 && info.mtimeMs < before ? info : undefined;
  } catch { return undefined; }
}
async function historicalRecord(path: string): Promise<DecisionRecord | undefined> {
  try {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { const info = await file.stat(); return info.isFile() && info.size <= MAX_RECORD_BYTES ? parseRecord(JSON.parse(await file.readFile('utf8'))) : undefined; }
    finally { await file.close(); }
  } catch { return undefined; }
}
async function pruneLocked(directory: string, now: number): Promise<string[]> {
  const cutoff = now - MAX_AGE_MS;
  const removed: string[] = [];
  for (const entry of await readdir(directory, {withFileTypes: true})) {
    if (!entry.isFile() || !RECORD_NAME.test(entry.name) && !CLAIM_NAME.test(entry.name)) continue;
    const path = join(directory, entry.name);
    const recordPath = path.endsWith('.claim') ? path.slice(0, -6) : path;
    // A retained proof marker of any kind, including an unknown link, protects its dependencies.
    if (await lstat(`${recordPath}.pinned`).catch(() => undefined)) continue;
    const info = await owned(path, cutoff);
    if (!info) continue;
    const recordInfo = await lstat(recordPath).catch(() => undefined);
    if (recordInfo) {
      const record = await historicalRecord(recordPath);
      if (!record || batchKey(record.toolUseIds) + '.json' !== basename(recordPath) || record.retention === 'pinned' || record.createdAt >= cutoff || !await owned(recordPath, cutoff)) continue;
      const claimInfo = await lstat(`${recordPath}.claim`).catch(() => undefined);
      if (claimInfo && !await owned(`${recordPath}.claim`, cutoff)) continue;
    } else if (!path.endsWith('.claim') || info.size !== 0) continue;
    const current = await lstat(path).catch(() => undefined);
    if (!current || current.dev !== info.dev || current.ino !== info.ino) continue;
    await unlink(path); removed.push(path);
  }
  return removed;
}
async function locked<T>(directory: string, action: () => Promise<T>): Promise<T> {
  const path = join(directory, '.batch-records.lock');
  const lease = await acquireStateLock(path, 1);
  try { return await action(); }
  finally { await releaseStateLock(path, lease.handle, lease.token); }
}
export async function pruneClaudeBatchRecords(directory: string, now = Date.now()): Promise<string[]> {
  return await locked(directory, () => pruneLocked(directory, now));
}
export async function prepareBatchClaim(path: string, now = Date.now()): Promise<void> {
  if (!RECORD_NAME.test(basename(path))) throw new Error('invalid_batch_record_path');
  await locked(dirname(path), async () => {
    await pruneLocked(dirname(path), now);
    const claim = await open(`${path}.claim`, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    await claim.close();
  });
}
