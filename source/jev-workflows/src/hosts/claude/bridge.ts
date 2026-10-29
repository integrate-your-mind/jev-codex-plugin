import {BRIDGE_VERSION} from './config.mjs';
export {BRIDGE_VERSION, parseConfig} from './config.mjs';
export const BRIDGE_DIRECTORY = 'routing-v1/claude';
export const CONFIG_FILE = 'claude-routing.json';
export const MAX_RECORD_BYTES = 32 * 1024;

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type Profile = {id: string; model: string; effort: Effort; hostId: string; providerId: string; availability: 'verified' | 'unknown' | 'unavailable'};
export type BridgeConfig = {
  version: typeof BRIDGE_VERSION; enabled: boolean; stateDirectory: string;
  hostId: string; providerId: string; catalogGeneration: string; policyGeneration: string;
  profiles: Profile[];
  transitions?: Array<{from: string; to: string; kind: 'upshift' | 'lateral' | 'downshift'}>;
};
export type DecisionRecord = {
  version: typeof BRIDGE_VERSION; producer: 'trusted-post-tool-batch';
  sessionId: string; agentId: string; workspace: string; toolUseIds: string[];
  createdAt: number; expiresAt: number; hostId: string; providerId: string;
  catalogGeneration: string; policyGeneration: string;
  status: 'assessed' | 'abstained' | 'unavailable'; selection: string | null;
  receiptId?: string;
  objectiveDigest: string; evidenceDigest: string;
  retention?: 'metadata' | 'pinned';
};
export type Inference = {turnId: string; index: number; model: string; effort?: Effort | number; agentId?: string};
type Batch = {inference: Inference; generation: number; startedAt: number; ids: Set<string>; completed: Set<string>; streamComplete: boolean; invalid: boolean};

const text = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 4096 && !/[\0\r\n]/.test(v);
const object = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const identity = (v: unknown): v is string => text(v) && v.length <= 160;
const absolute = (v: unknown): v is string => text(v) && v.startsWith('/') && !v.split('/').includes('..') && !v.endsWith('/');
export const agentKey = (agentId?: string): string => agentId ?? 'main';

export function toolIds(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || !value.every(identity)) return undefined;
  const sorted = [...value].sort() as string[];
  return new Set(sorted).size === sorted.length ? sorted : undefined;
}

export function parseRecord(value: unknown): DecisionRecord | undefined {
  if (!object(value) || value.version !== BRIDGE_VERSION || value.producer !== 'trusted-post-tool-batch' ||
      !identity(value.sessionId) || !identity(value.agentId) || !absolute(value.workspace) || !toolIds(value.toolUseIds) ||
      !identity(value.hostId) || !identity(value.providerId) || !identity(value.catalogGeneration) || !identity(value.policyGeneration) ||
      !Number.isSafeInteger(value.createdAt) || !Number.isSafeInteger(value.expiresAt) || Number(value.expiresAt) <= Number(value.createdAt) ||
      !['assessed', 'abstained', 'unavailable'].includes(String(value.status)) || !(value.selection === null || identity(value.selection)) ||
      typeof value.objectiveDigest !== 'string' || !/^[a-f0-9]{64}$/.test(value.objectiveDigest) || typeof value.evidenceDigest !== 'string' || !/^[a-f0-9]{64}$/.test(value.evidenceDigest) ||
      (value.retention !== undefined && value.retention !== 'metadata' && value.retention !== 'pinned') ||
      (value.receiptId !== undefined && !identity(value.receiptId))) return undefined;
  return {...value, toolUseIds: toolIds(value.toolUseIds)} as DecisionRecord;
}

// This is a lookup key, not an authentication digest. Exact IDs are checked after reading.
export function batchKey(ids: readonly string[]): string {
  let a = 2166136261; let b = 2246822507;
  for (const ch of JSON.stringify([...ids].sort())) {
    a = Math.imul(a ^ ch.charCodeAt(0), 16777619);
    b = Math.imul(b ^ ch.charCodeAt(0), 3266489909);
  }
  return `${(a >>> 0).toString(16).padStart(8, '0')}${(b >>> 0).toString(16).padStart(8, '0')}`;
}

export function recordPath(config: BridgeConfig, sessionId: string, agentId: string, ids: readonly string[]): string {
  return `${config.stateDirectory}/${BRIDGE_DIRECTORY}/${encodeURIComponent(sessionId)}/${encodeURIComponent(agentId)}/${batchKey(ids)}.json`;
}

export class CausalBridge {
  private generation = 0;
  private batches = new Map<string, Batch>();
  private active = new Map<string, number>();
  private blockedTurns = new Set<string>();

  invalidate(): void {
    this.generation++;
    for (const batch of this.batches.values()) this.blockedTurns.add(batch.inference.turnId);
    this.batches.clear();
  }

  revision(): number { return this.generation; }

  begin(e: Inference, now: number, generation = this.generation): void {
    const key = agentKey(e.agentId);
    const count = this.active.get(key) ?? 0;
    this.active.set(key, count + 1);
    this.batches.set(key, {inference: {...e}, generation: this.generation, startedAt: now, ids: new Set(), completed: new Set(), streamComplete: false, invalid: count > 0 || generation !== this.generation || this.blockedTurns.has(e.turnId)});
  }

  streamTool(e: Inference, id: string): void {
    const batch = this.batches.get(agentKey(e.agentId));
    if (!batch || batch.inference !== e && (batch.inference.turnId !== e.turnId || batch.inference.index !== e.index)) return;
    if (!identity(id) || batch.ids.has(id)) batch.invalid = true;
    else batch.ids.add(id);
  }

  completeTool(agentId: string | undefined, id: string): void {
    const batch = this.batches.get(agentKey(agentId));
    if (!batch) return;
    if (!batch.ids.has(id) || batch.completed.has(id)) batch.invalid = true;
    else batch.completed.add(id);
  }

  finish(e: Inference, ok: boolean, expectedToolCount?: number): void {
    const key = agentKey(e.agentId);
    const count = this.active.get(key) ?? 0;
    if (count <= 1) this.active.delete(key); else this.active.set(key, count - 1);
    const batch = this.batches.get(key);
    if (!batch || batch.inference.turnId !== e.turnId || batch.inference.index !== e.index) return;
    batch.streamComplete = ok;
    if (!ok || expectedToolCount !== undefined && batch.ids.size !== expectedToolCount) batch.invalid = true;
  }

  preceding(e: Inference): {ids: string[]; startedAt: number; generation: number} | undefined {
    const batch = this.batches.get(agentKey(e.agentId));
    if (!batch || batch.invalid || this.active.has(agentKey(e.agentId)) || !batch.streamComplete || batch.generation !== this.generation ||
        batch.inference.turnId !== e.turnId || batch.inference.index + 1 !== e.index || batch.ids.size === 0 || batch.ids.size !== batch.completed.size) return undefined;
    if (batch.inference.model !== e.model || batch.inference.effort !== e.effort) return undefined;
    return {ids: [...batch.ids].sort(), startedAt: batch.startedAt, generation: batch.generation};
  }

  select(e: Inference, record: DecisionRecord, config: BridgeConfig, scope: {sessionId: string; workspace: string}, now: number): Inference {
    const batch = this.preceding(e);
    if (!batch || !config.enabled || record.status !== 'assessed' || record.sessionId !== scope.sessionId || record.workspace !== scope.workspace ||
        record.agentId !== agentKey(e.agentId) || JSON.stringify(record.toolUseIds) !== JSON.stringify(batch.ids) || record.createdAt < batch.startedAt ||
        record.createdAt > now || record.expiresAt <= now || record.expiresAt - record.createdAt > 60_000 || record.hostId !== config.hostId || record.providerId !== config.providerId ||
        record.catalogGeneration !== config.catalogGeneration || record.policyGeneration !== config.policyGeneration) return e;
    const profile = config.profiles.find(p => p.id === record.selection && p.availability === 'verified' && p.hostId === config.hostId && p.providerId === config.providerId);
    const current = config.profiles.find(p => p.availability === 'verified' && p.model === e.model && p.effort === e.effort && p.hostId === config.hostId && p.providerId === config.providerId);
    const transition = current && profile && config.transitions?.find(t => t.from === current.id && t.to === profile.id);
    // A resolved tool batch does not establish completed-subtask evidence.
    return profile && transition && transition.kind !== 'downshift' ? {...e, model: profile.model, effort: profile.effort} : e;
  }
}
