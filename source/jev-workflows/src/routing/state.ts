import {constants} from 'node:fs';
import {mkdir, open, lstat, link, rename, unlink, readdir} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {acquireStateLock, releaseStateLock} from '../state-lock.js';
import {ROUTING_SCHEMA_VERSION, sameScope, type RoutingRecord, type RoutingScope} from './contracts.js';

const DAY = 24 * 60 * 60 * 1000;
const FACT_RETENTION = 7 * DAY;
const METADATA_RETENTION = 90 * DAY;
const MAX_ROUTING_FILE_BYTES = 64 * 1024 * 1024;
export interface RoutingStateStoreOptions {
  readonly stateDirectory: string;
  readonly scope: RoutingScope;
  readonly now?: () => Date;
  readonly readOnly?: boolean;
}
export interface RoutingCurrent {
  readonly schemaVersion: typeof ROUTING_SCHEMA_VERSION;
  readonly scope: RoutingScope;
  readonly revision: number;
  readonly updatedAt: string;
  readonly records: Readonly<Record<string, string>>;
}
export type RoutingCommit = Readonly<{status: 'committed'; current: RoutingCurrent} | {status: 'conflict'; current: RoutingCurrent}>;
export interface RoutingSnapshot {readonly current: RoutingCurrent; readonly records: readonly RoutingRecord[]}

function hash(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function scopeKey(scope: RoutingScope): string {
  const values = [scope.hostId, scope.accountId, scope.workspaceId, scope.sessionId, scope.agentId];
  if (values.some(value => typeof value !== 'string' || !value || value.includes('\0'))) throw new Error('invalid_routing_scope');
  return hash(JSON.stringify(values));
}
function recordName(id: string): string {
  if (typeof id !== 'string' || !id || id.includes('\0')) throw new Error('invalid_record_id');
  return `${hash(id)}.json`;
}
function validTime(value: unknown): value is string { return typeof value === 'string' && Number.isFinite(Date.parse(value)); }

async function privateDirectory(path: string): Promise<void> {
  await mkdir(path, {recursive: true, mode: 0o700});
  await inspectPrivateDirectory(path);
}
async function inspectPrivateDirectory(path: string): Promise<boolean> {
  let info;
  try { info = await lstat(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) throw new Error('unsafe_routing_directory');
  return true;
}
async function readJson(path: string): Promise<unknown | null> {
  let handle;
  try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_ROUTING_FILE_BYTES || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) throw new Error('unsafe_routing_file');
    return JSON.parse(await handle.readFile('utf8')) as unknown;
  } finally { await handle.close(); }
}
async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}
async function writeJson(path: string, directory: string, value: unknown, immutable: boolean): Promise<void> {
  const temporary = join(directory, `.publish-${randomUUID()}.json`);
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized) > MAX_ROUTING_FILE_BYTES) throw new Error('routing_file_too_large');
  const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(serialized); await handle.sync(); } finally { await handle.close(); }
  try {
    if (immutable) {
      try { await link(temporary, path); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        if (JSON.stringify(await readJson(path)) !== serialized) throw new Error('immutable_record_conflict');
      }
    } else { await rename(temporary, path); }
    await syncDirectory(directory);
  } finally { await unlink(temporary).catch(() => {}); }
}

export class RoutingStateStore {
  readonly directory: string;
  readonly #scope: RoutingScope;
  readonly #now: () => Date;
  readonly #records: string;
  readonly #revisions: string;
  readonly #directories: readonly string[];
  readonly #readOnly: boolean;
  readonly #ready: Promise<void>;

  constructor(input: RoutingStateStoreOptions) {
    this.#scope = structuredClone(input.scope);
    const root = join(resolve(input.stateDirectory), ROUTING_SCHEMA_VERSION);
    const directory = join(root, scopeKey(this.#scope));
    const records = join(directory, 'records');
    const revisions = join(directory, 'revisions');
    this.directory = directory;
    this.#records = records;
    this.#revisions = revisions;
    this.#directories = [root, directory, records, revisions];
    this.#readOnly = input.readOnly ?? false;
    this.#now = input.now ?? (() => new Date());
    this.#ready = this.#readOnly ? Promise.resolve() : (async () => {
      await privateDirectory(root);
      await privateDirectory(directory);
      await privateDirectory(records);
      await privateDirectory(revisions);
    })();
  }

  async #prepareRead(): Promise<void> {
    await this.#ready;
    if (this.#readOnly) for (const directory of this.#directories) if (!await inspectPrivateDirectory(directory)) return;
  }
  #assertWritable(): void { if (this.#readOnly) throw new Error('routing_store_read_only'); }

  #empty(): RoutingCurrent { return {schemaVersion: ROUTING_SCHEMA_VERSION, scope: structuredClone(this.#scope), revision: 0, updatedAt: this.#now().toISOString(), records: {}}; }
  #validateRecord(value: unknown): RoutingRecord {
    if (!value || typeof value !== 'object') throw new Error('invalid_routing_record');
    const record = value as RoutingRecord;
    if (record.schemaVersion !== ROUTING_SCHEMA_VERSION || !record.scope || !sameScope(record.scope, this.#scope) || typeof record.id !== 'string' || !record.id || typeof record.kind !== 'string' || !record.kind || !validTime(record.createdAt) || !['facts', 'metadata', 'pinned'].includes(record.retention) || record.expiresAt !== undefined && !validTime(record.expiresAt) || record.dependsOn !== undefined && (!Array.isArray(record.dependsOn) || record.dependsOn.some(id => typeof id !== 'string' || !id))) throw new Error('invalid_routing_record');
    return record;
  }
  #validateCurrent(value: unknown): RoutingCurrent {
    if (!value || typeof value !== 'object') throw new Error('invalid_routing_current');
    const current = value as RoutingCurrent;
    if (current.schemaVersion !== ROUTING_SCHEMA_VERSION || !current.scope || !sameScope(current.scope, this.#scope) || !Number.isSafeInteger(current.revision) || current.revision < 1 || !validTime(current.updatedAt) || !current.records || typeof current.records !== 'object' || Array.isArray(current.records) || Object.values(current.records).some(id => typeof id !== 'string' || !id)) throw new Error('invalid_routing_current');
    return current;
  }

  async publish<T extends RoutingRecord>(input: T): Promise<T> {
    this.#assertWritable();
    await this.#ready;
    this.#validateRecord(input);
    const record = structuredClone(input);
    if (record.retention !== 'pinned') {
      const deadline = Date.parse(record.createdAt) + (record.retention === 'facts' ? FACT_RETENTION : METADATA_RETENTION);
      Object.assign(record, {expiresAt: new Date(Math.min(deadline, record.expiresAt ? Date.parse(record.expiresAt) : deadline)).toISOString()});
    }
    await writeJson(join(this.#records, recordName(record.id)), this.#records, record, true);
    return record;
  }

  async read<T extends RoutingRecord = RoutingRecord>(id: string, input: {includeExpired?: boolean} = {}): Promise<T | null> {
    await this.#prepareRead();
    const value = await readJson(join(this.#records, recordName(id)));
    if (value === null) return null;
    const record = this.#validateRecord(value);
    if (record.id !== id) throw new Error('routing_record_identity_mismatch');
    if (!input.includeExpired && record.retention !== 'pinned' && record.expiresAt && Date.parse(record.expiresAt) <= this.#now().getTime()) return null;
    return structuredClone(record) as T;
  }

  async current(): Promise<RoutingCurrent> {
    await this.#prepareRead();
    const value = await readJson(join(this.directory, 'current.json'));
    if (value === null) return this.#empty();
    const current = this.#validateCurrent(value);
    await this.#checkReferences(current);
    return structuredClone(current);
  }
  async #checkReferences(current: RoutingCurrent, includeExpired = true): Promise<void> {
    const checked = new Set<string>();
    const visit = async (id: string): Promise<void> => {
      if (checked.has(id)) return;
      const record = await this.read(id, {includeExpired});
      if (!record) throw new Error('routing_current_missing_record');
      checked.add(id);
      for (const dependency of record.dependsOn ?? []) await visit(dependency);
    };
    for (const id of Object.values(current.records)) await visit(id);
  }

  async compareAndSet(expectedRevision: number, records: Readonly<Record<string, string>>): Promise<RoutingCommit> {
    this.#assertWritable();
    await this.#ready;
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new Error('invalid_expected_revision');
    const lockPath = join(this.directory, 'current.lock');
    const lock = await acquireStateLock(lockPath);
    try {
      const current = await this.#recoverCurrentUnlocked();
      if (current.revision !== expectedRevision) return {status: 'conflict', current};
      const next = this.#validateCurrent({schemaVersion: ROUTING_SCHEMA_VERSION, scope: this.#scope, revision: expectedRevision + 1, updatedAt: this.#now().toISOString(), records: structuredClone(records)});
      await this.#checkReferences(next, false);
      await writeJson(join(this.#revisions, `${next.revision}.json`), this.#revisions, next, true);
      await writeJson(join(this.directory, 'current.json'), this.directory, next, false);
      return {status: 'committed', current: next};
    } finally { await releaseStateLock(lockPath, lock.handle, lock.token); }
  }

  async recoverCurrent(): Promise<RoutingCurrent> {
    this.#assertWritable();
    await this.#ready;
    const lockPath = join(this.directory, 'current.lock');
    const lock = await acquireStateLock(lockPath);
    try {
      return await this.#recoverCurrentUnlocked();
    } finally { await releaseStateLock(lockPath, lock.handle, lock.token); }
  }

  async #recoverCurrentUnlocked(): Promise<RoutingCurrent> {
    const versions = (await readdir(this.#revisions)).filter(name => /^[1-9][0-9]*\.json$/.test(name)).sort((a, b) => Number.parseInt(b) - Number.parseInt(a));
    for (const version of versions) {
      const current = this.#validateCurrent(await readJson(join(this.#revisions, version)));
      await this.#checkReferences(current);
      const pointer = await readJson(join(this.directory, 'current.json')).catch(() => null);
      if (JSON.stringify(pointer) !== JSON.stringify(current)) await writeJson(join(this.directory, 'current.json'), this.directory, current, false);
      return current;
    }
    return await this.current();
  }

  async snapshot(): Promise<RoutingSnapshot> {
    this.#assertWritable();
    await this.#ready;
    const lockPath = join(this.directory, 'current.lock');
    const lock = await acquireStateLock(lockPath);
    try {
      const current = await this.#recoverCurrentUnlocked();
      const records = new Map<string, RoutingRecord>();
      const visit = async (id: string): Promise<void> => {
        if (records.has(id)) return;
        const record = await this.read(id, {includeExpired: true});
        if (!record) throw new Error('routing_snapshot_missing_dependency');
        records.set(id, record);
        for (const dependency of record.dependsOn ?? []) await visit(dependency);
      };
      for (const id of Object.values(current.records)) await visit(id);
      return {current, records: [...records.values()]};
    } finally { await releaseStateLock(lockPath, lock.handle, lock.token); }
  }

  async prune(): Promise<readonly string[]> {
    this.#assertWritable();
    await this.#ready;
    const lockPath = join(this.directory, 'current.lock');
    const lock = await acquireStateLock(lockPath);
    try {
      const records = new Map<string, {record: RoutingRecord; path: string}>();
      for (const name of await readdir(this.#records)) {
        if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
        const record = this.#validateRecord(await readJson(join(this.#records, name)));
        records.set(record.id, {record, path: join(this.#records, name)});
      }
      const protectedIds = new Set<string>();
      const protect = (id: string): void => {
        if (protectedIds.has(id)) return;
        protectedIds.add(id);
        for (const dependency of records.get(id)?.record.dependsOn ?? []) protect(dependency);
      };
      for (const {record} of records.values()) if (record.retention === 'pinned') protect(record.id);
      const expired = new Set<string>();
      for (const [id, {record}] of records) {
        if (!protectedIds.has(id) && record.expiresAt && Date.parse(record.expiresAt) <= this.#now().getTime()) expired.add(id);
      }
      const current = await this.#recoverCurrentUnlocked();
      const hasExpiredDependency = (id: string, visited = new Set<string>()): boolean => {
        if (expired.has(id)) return true;
        if (visited.has(id)) return false;
        visited.add(id);
        return (records.get(id)?.record.dependsOn ?? []).some(dependency => hasExpiredDependency(dependency, visited));
      };
      const retained = Object.fromEntries(Object.entries(current.records).filter(([, id]) => !hasExpiredDependency(id)));
      if (Object.keys(retained).length !== Object.keys(current.records).length) {
        const next = {...current, revision: current.revision + 1, updatedAt: this.#now().toISOString(), records: retained};
        await writeJson(join(this.#revisions, `${next.revision}.json`), this.#revisions, next, true);
        await writeJson(join(this.directory, 'current.json'), this.directory, next, false);
      }
      for (const id of expired) await unlink(records.get(id)!.path);
      for (const name of await readdir(this.#revisions)) {
        if (!/^[1-9][0-9]*\.json$/.test(name)) continue;
        const revision = this.#validateCurrent(await readJson(join(this.#revisions, name)));
        if (revision.revision === current.revision && Object.keys(retained).length === Object.keys(current.records).length) continue;
        if (Date.parse(revision.updatedAt) + METADATA_RETENTION <= this.#now().getTime() || Object.values(revision.records).some(id => expired.has(id))) await unlink(join(this.#revisions, name));
      }
      return [...expired];
    } finally { await releaseStateLock(lockPath, lock.handle, lock.token); }
  }
}
