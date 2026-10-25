import {copyFile, mkdir, readFile, lstat} from 'node:fs/promises';
import {resolve, dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const write = args.includes('--write');
const positional = args.filter(arg => arg !== '--write');
if (positional.length !== 1 || positional[0].startsWith('--')) throw new Error('Usage: node scripts/sync-jev-contract.mjs [--write] /path/to/qq');
const target = resolve(positional[0]);
// Refuse an unrelated path: this command updates only the identified QQ source copy.
const cargo = await readFile(join(target, 'Cargo.toml'), 'utf8');
if (!/^name\s*=\s*"qq"\s*$/m.test(cargo)) throw new Error('Target is not the QQ repository');
const source = join(root, 'contracts/jev');
const destination = join(target, 'contracts/jev');
for (const component of [join(target, 'contracts'), destination]) {
  try { if (!(await lstat(component)).isDirectory()) throw new Error('Contract path is not a plain directory'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
if (write) await mkdir(destination, {recursive: true});
for (const file of ['contract.json', 'conformance.json']) {
  const expected = await readFile(join(source, file));
  const path = join(destination, file);
  try { if (!(await lstat(path)).isFile()) throw new Error(`Contract path is not a plain file: ${file}`); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (write) await copyFile(join(source, file), path);
  const actual = await readFile(path);
  if (!expected.equals(actual)) throw new Error(`Jev contract drift: ${file}. Review the changes, then run with --write and both test suites.`);
}
console.log(`Jev contract ${JSON.parse(await readFile(join(source, 'contract.json'), 'utf8')).revision}: ${write ? 'synced and verified' : 'verified'}`);
