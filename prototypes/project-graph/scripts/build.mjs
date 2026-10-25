import {createHash} from 'node:crypto';
import {mkdir, readdir, readFile, rm} from 'node:fs/promises';
import {dirname, relative, resolve, sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {build} from '../../../source/jev-workflows/node_modules/esbuild/lib/main.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = resolve(root, 'dist');
const nodeModules = resolve(root, '../../source/jev-workflows/node_modules');
const localNodeModules = resolve(root, 'node_modules');
async function engineIdentity() {
  const paths = [];
  async function visit(directory) {
    const entries = await readdir(directory, {withFileTypes: true});
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.name === 'dist' || entry.name === 'node_modules') continue;
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && !path.includes(`${sep}tests${sep}`) && entry.name !== 'README.md') paths.push(path);
    }
  }
  await visit(root);
  const digest = createHash('sha256');
  for (const path of paths) digest.update(relative(root, path)).update('\0').update(await readFile(path)).update('\0');
  return digest.digest('hex');
}
const engineVersion = await engineIdentity();
await rm(dist, {recursive: true, force: true});
await mkdir(dist, {recursive: true});

for (const entry of ['server', 'cli']) {
  await build({
    entryPoints: [resolve(root, `src/${entry}.ts`)],
    outfile: resolve(dist, `${entry}.mjs`),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    sourcemap: false,
    legalComments: 'none',
    nodePaths: [localNodeModules, nodeModules],
    define: {__PROJECT_GRAPH_ENGINE_VERSION__: JSON.stringify(engineVersion)},
    banner: {js: `import {createRequire as __createRequire} from 'node:module';import {fileURLToPath as __fileURLToPath} from 'node:url';import {dirname as __pathDirname} from 'node:path';const require=__createRequire(import.meta.url);const __filename=__fileURLToPath(import.meta.url);const __dirname=__pathDirname(__filename);`},
  });
}
