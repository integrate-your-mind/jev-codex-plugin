import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {access, mkdir, mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const dir = dirname(fileURLToPath(import.meta.url));
const publicationRoot = resolve(dir, '../../..');
const loader = join(publicationRoot, 'source/jev-workflows/node_modules/tsx/dist/loader.mjs');
await access(loader);

if (process.versions.node !== '22.23.2') {
  throw new Error(`offline validation requires pinned Node 22.23.2; got ${process.version}`);
}
if (process.platform !== 'darwin') throw new Error('fixture engine validation requires macOS sandbox-exec');

const checkRoot = await mkdtemp(join(tmpdir(), 'jev-explicit-outcomes-check-'));
let code;
let signal;
try {
  const home = join(checkRoot, 'home');
  const temporary = join(checkRoot, 'tmp');
  await Promise.all([mkdir(home, {mode: 0o700}), mkdir(temporary, {mode: 0o700})]);
  const child = spawn('/usr/bin/sandbox-exec', [
    '-p',
    '(version 1) (allow default) (deny network*)',
    process.execPath,
    '--import',
    loader,
    '--test',
    '--test-concurrency=1',
    join(dir, 'run.test.ts'),
  ], {
    cwd: dir,
    env: {
      HOME: home,
      LANG: 'C',
      PATH: '/usr/bin:/bin:/opt/homebrew/bin',
      TMPDIR: temporary,
      TSX_DISABLE_CACHE: '1',
    },
    stdio: 'inherit',
  });
  [code, signal] = await once(child, 'close');
} finally {
  await rm(checkRoot, {recursive: true, force: true});
}
if (code !== 0) throw new Error(`offline validation failed: ${code ?? signal}`);
process.stdout.write(`${JSON.stringify({status: 'passed', nodeVersion: process.version, network: 'denied', providerCalls: 0, modelCalls: 0, temporaryStateRemoved: true})}\n`);
