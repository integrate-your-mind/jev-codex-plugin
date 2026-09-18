import { build } from 'esbuild';
// dist contains retained installable release assets, not disposable test output.
await build({
  entryPoints: ['src/server.ts', 'src/hook.ts', 'src/decision-hook.ts'], outdir: 'dist', outExtension: {'.js': '.mjs'},
  bundle: true, platform: 'node', target: 'node22', format: 'esm',
  banner: {js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);"},
  sourcemap: false, minify: false
});
