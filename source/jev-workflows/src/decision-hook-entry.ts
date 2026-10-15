import { realpath } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { runDecisionHook } from './decision-hook.js';

export { runDecisionHook };

const MAX_STDIN_BYTES = 128 * 1024;

async function readStdin(): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.byteLength;
    if (total > MAX_STDIN_BYTES) return new Uint8Array(MAX_STDIN_BYTES + 1);
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

async function main(): Promise<void> {
  process.stdout.write(JSON.stringify(await runDecisionHook(await readStdin())));
}

if (process.argv[1] && import.meta.url === pathToFileURL(await realpath(process.argv[1])).href) void main().catch(() => process.stdout.write('{}'));
