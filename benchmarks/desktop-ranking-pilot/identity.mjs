import {createHash} from 'node:crypto';

const canonical = value => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;

export const hash = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
