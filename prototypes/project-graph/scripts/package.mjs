import {cp, mkdir, rm} from 'node:fs/promises';
import {basename, dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const destinationValue = process.argv[2];
if (!destinationValue) throw new Error('usage: npm run package:plugin -- /absolute/new/destination');
const destination = resolve(destinationValue);
if (destination === root || destination.startsWith(`${root}/`)) throw new Error('destination must be outside the source prototype');
await mkdir(dirname(destination), {recursive: true});
await mkdir(destination, {recursive: false, mode: 0o700}).catch(error => {
  throw new Error(`destination must not exist: ${error instanceof Error ? error.message : 'unknown error'}`);
});
try {
  await cp(resolve(root, 'dist'), resolve(destination, 'dist'), {recursive: true});
  await cp(resolve(root, '.mcp.json'), resolve(destination, '.mcp.json'));
  await cp(resolve(root, 'mcp.json'), resolve(destination, 'mcp.json'));
  await cp(resolve(root, '.codex-plugin'), resolve(destination, '.codex-plugin'), {recursive: true});
  await cp(resolve(root, 'plugin.json'), resolve(destination, 'plugin.json'));
  await cp(resolve(root, 'README.md'), resolve(destination, 'README.md'));
} catch (error) {
  await rm(destination, {recursive: true, force: true});
  throw error;
}
process.stdout.write(`${basename(destination)} packaged\n`);
