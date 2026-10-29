import {createHash} from 'node:crypto';
import {ROUTING_SCHEMA_VERSION, type CatalogEntry, type CatalogSnapshot, type RoutingScope} from './contracts.js';
import {redactText, sanitize} from '../redact.js';

export interface CatalogPage {
  readonly entries: readonly CatalogEntry[];
  readonly nextCursor?: string;
  readonly inaccessibleCategories?: readonly string[];
}
export type CatalogPageReader = (cursor: string | undefined, signal?: AbortSignal) => Promise<CatalogPage>;

export async function discoverCatalog(input: {scope: RoutingScope; sourceRevision: string; readPage: CatalogPageReader; now?: Date; inaccessibleCategories?: readonly string[]; secrets?: string[]}, signal?: AbortSignal): Promise<CatalogSnapshot> {
  const entries = new Map<string, CatalogEntry>();
  const cursors = new Set<string>();
  const inaccessible = new Set(input.inaccessibleCategories ?? []);
  let cursor: string | undefined;
  let pages = 0;
  do {
    signal?.throwIfAborted();
    const page = await input.readPage(cursor, signal);
    pages += 1;
    for (const entry of page.entries) {
      if (!entry.id || !entry.category || !entry.source || typeof entry.description !== 'string' || typeof entry.available !== 'boolean') throw new Error('invalid_catalog_entry');
      if (redactText(entry.id, input.secrets) !== entry.id) throw new Error('unsafe_catalog_id');
      const metadata = entry.metadata ? Object.fromEntries(Object.entries(entry.metadata).filter(([key]) => !/^(?:password|passwd|secret|api.?key|access.?token|refresh.?token|session.?token|id.?token|authorization|cookie)$/i.test(key))) : undefined;
      const sanitized = sanitize({...entry, ...(metadata ? {metadata} : {})}, input.secrets ?? []);
      const previous = entries.get(entry.id);
      if (previous && JSON.stringify(previous) !== JSON.stringify(sanitized)) throw new Error('conflicting_catalog_entry');
      entries.set(entry.id, sanitized);
    }
    for (const category of page.inaccessibleCategories ?? []) inaccessible.add(category);
    cursor = page.nextCursor;
    if (cursor !== undefined) {
      if (!cursor || cursors.has(cursor)) throw new Error('catalog_cursor_cycle');
      cursors.add(cursor);
    }
  } while (cursor !== undefined);
  const ordered = [...entries.values()].sort((a, b) => Buffer.compare(Buffer.from(a.id), Buffer.from(b.id)));
  const coverage = {discovery: 'complete_supported_inventory' as const, pages, inventoryCount: ordered.length, inaccessibleCategories: [...inaccessible].sort()};
  const createdAt = (input.now ?? new Date()).toISOString();
  const identity = {scope: input.scope, sourceRevision: input.sourceRevision, entries: ordered, coverage, createdAt};
  return deepFreeze({schemaVersion: ROUTING_SCHEMA_VERSION, id: createHash('sha256').update(JSON.stringify(identity)).digest('hex'), kind: 'catalog_snapshot', retention: 'facts', ...identity});
}

export function shortlistCatalog(snapshot: CatalogSnapshot, ids: readonly string[]): {entries: readonly CatalogEntry[]; coverage: {catalogId: string; inventoryCount: number; includedCount: number; omittedIds: readonly string[]}} {
  const selected = new Set(ids);
  if (selected.size !== ids.length || ids.some(id => !snapshot.entries.some(entry => entry.id === id))) throw new Error('invalid_catalog_shortlist');
  return deepFreeze({entries: ids.map(id => snapshot.entries.find(entry => entry.id === id)!), coverage: {catalogId: snapshot.id, inventoryCount: snapshot.entries.length, includedCount: ids.length, omittedIds: snapshot.entries.filter(entry => !selected.has(entry.id)).map(entry => entry.id)}});
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') { Object.freeze(value); for (const child of Object.values(value)) deepFreeze(child); }
  return value;
}
