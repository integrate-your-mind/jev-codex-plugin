import { build } from 'esbuild';
import { copyFile, mkdir } from 'node:fs/promises';
import {entryPoints, standaloneSkills} from './build-outputs.mjs';
const {'claude-mod': nativeMod, ...nodeEntryPoints} = entryPoints;
// dist contains retained installable release assets, not disposable test output.
await build({
  entryPoints: nodeEntryPoints, outdir: 'dist', outExtension: {'.js': '.mjs'},
  bundle: true, platform: 'node', target: 'node22', format: 'esm',
  banner: {js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);"},
  sourcemap: false, minify: false
});
await build({
  entryPoints: {'claude-mod': nativeMod}, outdir: 'dist', outExtension: {'.js': '.mjs'},
  bundle: true, platform: 'neutral', target: 'es2022', format: 'esm',
  sourcemap: false, minify: false,
});
// Each skill can also run independently of MCP. Retain the exact same bundled
// CLI in every standalone skill; never hand-edit these generated copies.
for (const skill of standaloneSkills) {
  const destination = `skills/${skill}/scripts`;
  await mkdir(destination, {recursive: true});
  await copyFile('dist/cli.mjs', `${destination}/jev.mjs`);
}
