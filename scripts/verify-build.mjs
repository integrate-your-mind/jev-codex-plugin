import {spawnSync} from 'node:child_process';
import {readFile, readdir} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {entryPoints, standaloneSkills} from '../source/jev-workflows/scripts/build-outputs.mjs';

const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--source')) {
  throw new Error('Usage: node scripts/verify-build.mjs [--source /path/to/source/jev-workflows]');
}
const source = args.length ? resolve(args[1]) : fileURLToPath(new URL('../source/jev-workflows', import.meta.url));
const filesUnder = async (directory, prefix = '') => {
  const files = [];
  for (const entry of await readdir(join(directory, prefix), {withFileTypes: true})) {
    const path = join(prefix, entry.name);
    if (entry.isDirectory()) files.push(...await filesUnder(directory, path));
    else if (entry.isFile()) files.push(path);
    else throw new Error(`Build output must be a plain file: ${path}`);
  }
  return files;
};
const snapshot = async () => {
  const distFiles = (await filesUnder(join(source, 'dist'))).sort();
  const expectedDist = Object.keys(entryPoints).map(name => `${name}.mjs`).sort();
  if (JSON.stringify(distFiles) !== JSON.stringify(expectedDist)) {
    throw new Error(`Unexpected retained dist files. Expected ${expectedDist.join(', ')}; found ${distFiles.join(', ')}. Regenerate and commit the release outputs.`);
  }
  const paths = [
    ...distFiles.map(path => join('dist', path)),
    ...standaloneSkills.map(skill => `skills/${skill}/scripts/jev.mjs`),
  ];
  return new Map(await Promise.all(paths.map(async path => [path, await readFile(join(source, path))])));
};
const before = await snapshot();
const build = spawnSync(process.execPath, ['scripts/build.mjs'], {cwd: source, stdio: 'inherit'});
if (build.error) throw build.error;
if (build.status !== 0) process.exit(build.status ?? 1);
const after = await snapshot();
const changed = [...new Set([...before.keys(), ...after.keys()])].filter(path => !before.get(path)?.equals(after.get(path) ?? Buffer.alloc(0)) || !after.has(path));
if (changed.length) {
  throw new Error(`Build changed retained release outputs: ${changed.join(', ')}. Regenerate and commit the source and both host packages before verification.`);
}
console.log('Retained source runtime and standalone skill bundles match the build');
