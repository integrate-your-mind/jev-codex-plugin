import {createHash, randomUUID} from 'node:crypto';
import {mkdir, readFile, rename, unlink, writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';

const source = 'https://raw.githubusercontent.com/anthropics/claude-code/58d6da1e34d6cd1c6379dcbf568bd66f5f9b6102/mods/types/claude-code.d.ts';
const expected = 'e51e637fbbebb2a6a49c4bdc3860a251c2ca2295884822dff0f4c3e3ec802163';
const path = fileURLToPath(new URL('../tests/fixtures/claude-code.d.ts', import.meta.url));
const digest = value => createHash('sha256').update(value).digest('hex');
let cached;
try { cached = await readFile(path); } catch (error) { if (error.code !== 'ENOENT') throw error; }
if (cached && digest(cached) === expected) process.exit(0);
const response = await fetch(source, {signal: AbortSignal.timeout(30_000)});
if (!response.ok) throw new Error(`Official Claude declarations fetch failed: HTTP ${response.status}`);
const bytes = Buffer.from(await response.arrayBuffer());
if (digest(bytes) !== expected) throw new Error('Official Claude declarations hash mismatch; cached types were not changed');
await mkdir(fileURLToPath(new URL('../tests/fixtures/', import.meta.url)), {recursive: true});
const temporary = `${path}.${randomUUID()}.partial`;
try { await writeFile(temporary, bytes, {flag: 'wx'}); await rename(temporary, path); }
finally { await unlink(temporary).catch(() => {}); }
