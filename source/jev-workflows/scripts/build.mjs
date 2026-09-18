import { build } from 'esbuild';
import { copyFile, mkdir } from 'node:fs/promises';
// dist contains retained installable release assets, not disposable test output.
await build({
  entryPoints: ['src/server.ts', 'src/hook.ts', 'src/decision-hook.ts', 'src/cli.ts'], outdir: 'dist', outExtension: {'.js': '.mjs'},
  bundle: true, platform: 'node', target: 'node22', format: 'esm',
  banner: {js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);"},
  sourcemap: false, minify: false
});
// Each skill can also run independently of MCP. Retain the exact same bundled
// CLI in every standalone skill; never hand-edit these generated copies.
for (const skill of ['classify-decision', 'diagnose-failure', 'check-completion']) {
  const destination = `skills/${skill}/scripts`;
  await mkdir(destination, {recursive: true});
  await copyFile('dist/cli.mjs', `${destination}/jev.mjs`);
}
