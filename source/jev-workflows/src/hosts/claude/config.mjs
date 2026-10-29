export const BRIDGE_VERSION = 'jev-claude-routing-v1';
const object = v => typeof v === 'object' && v !== null && !Array.isArray(v);
const text = v => typeof v === 'string' && v.length > 0 && v.length <= 4096 && !/[\0\r\n]/.test(v);
const identity = v => text(v) && v.length <= 160;
const absolute = v => text(v) && v.startsWith('/') && !v.split('/').includes('..') && !v.endsWith('/');
export function parseConfig(value) {
  if (!object(value) || value.version !== BRIDGE_VERSION || typeof value.enabled !== 'boolean' || !absolute(value.stateDirectory) ||
      !identity(value.hostId) || !identity(value.providerId) || !identity(value.catalogGeneration) || !identity(value.policyGeneration) || !Array.isArray(value.profiles)) return undefined;
  if (Object.keys(value).some(key => !['version', 'enabled', 'stateDirectory', 'hostId', 'providerId', 'catalogGeneration', 'policyGeneration', 'profiles', 'transitions'].includes(key))) return undefined;
  for (const p of value.profiles) {
    if (!object(p) || !identity(p.id) || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,79}$/.test(p.id) || !identity(p.model) || !identity(p.hostId) || !identity(p.providerId) ||
        typeof p.effort !== 'string' || !['low', 'medium', 'high', 'xhigh', 'max'].includes(p.effort) || !['verified', 'unknown', 'unavailable'].includes(p.availability)) return undefined;
    if (Object.keys(p).some(key => !['id', 'model', 'effort', 'hostId', 'providerId', 'availability'].includes(key))) return undefined;
  }
  if (new Set(value.profiles.map(p => p.id)).size !== value.profiles.length) return undefined;
  if (value.transitions !== undefined && (!Array.isArray(value.transitions) || value.transitions.some(t => !object(t) || !identity(t.from) || !identity(t.to) || !['upshift', 'lateral', 'downshift'].includes(t.kind) || !value.profiles.some(p => p.id === t.from) || !value.profiles.some(p => p.id === t.to) || Object.keys(t).some(key => !['from', 'to', 'kind'].includes(key))))) return undefined;
  return value;
}
