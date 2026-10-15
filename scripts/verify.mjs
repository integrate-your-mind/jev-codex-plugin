import {spawnSync} from 'node:child_process';
import {dirname, join, delimiter} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const source = join(root, 'source/jev-workflows');
const major = Number(process.versions.node.split('.')[0]);
if (major < 22) throw new Error('Jev Workflows verification requires Node.js 22 or newer');
if (process.argv.length > 2) throw new Error('Usage: node scripts/verify.mjs');

const env = {...process.env, PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ''}`};
const steps = [
  ['npm', ['ci', '--ignore-scripts'], source],
  ['npm', ['run', 'typecheck'], source],
  [process.execPath, ['scripts/verify-build.mjs'], root],
  ...['test', 'validate'].map(name => ['npm', ['run', name], source]),
  [process.execPath, ['scripts/verify-distribution.mjs'], root],
  [process.execPath, ['--test', 'scripts/verify-build.test.mjs', 'scripts/verify-distribution.test.mjs', 'scripts/sync-jev-contract.test.mjs'], root],
];

console.log(`Verifying Jev Workflows on Node ${process.versions.node} (${process.platform}/${process.arch})`);
for (const [command, args, cwd] of steps) {
  const result = spawnSync(command, args, {cwd, env, stdio: 'inherit', shell: process.platform === 'win32' && command === 'npm'});
  if (result.error) throw result.error;
  if (result.status !== 0) {
    console.error(`Verification failed: ${command} ${args.join(' ')}${result.signal ? ` (${result.signal})` : ''}`);
    process.exit(result.status ?? 1);
  }
}
console.log('Jev Workflows verification passed');
