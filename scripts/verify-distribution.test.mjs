import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const verifier = join(repositoryRoot, 'scripts/verify-distribution.mjs');

const copyFixture = async (targetRoot) => {
  await cp(join(repositoryRoot, '.agents/plugins/marketplace.json'), join(targetRoot, '.agents/plugins/marketplace.json'), { recursive: true });
  await cp(join(repositoryRoot, 'source/jev-workflows'), join(targetRoot, 'source/jev-workflows'), {
    recursive: true,
    filter: (source) => !source.includes('/node_modules/') && !source.includes('/work/') && !source.includes('/receipts/'),
  });
  await cp(join(repositoryRoot, 'plugins/jev-workflows'), join(targetRoot, 'plugins/jev-workflows'), { recursive: true });
  await cp(verifier, join(targetRoot, 'scripts/verify-distribution.mjs'));
  await cp(join(repositoryRoot, 'source/jev-workflows/scripts/package-host.mjs'), join(targetRoot, 'source/jev-workflows/scripts/package-host.mjs'));
};

test('distribution verifier accepts the checked-in package', async () => {
  await execFileAsync(process.execPath, [verifier], { cwd: repositoryRoot });
});

test('distribution verifier rejects drift in a disposable fixture', async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'jev-distribution-test-'));
  try {
    await copyFixture(temporaryRoot);
    const readmePath = join(temporaryRoot, 'plugins/jev-workflows/README.md');
    const readme = await readFile(readmePath, 'utf8');
    await writeFile(readmePath, `${readme}\nfixture drift\n`);
    await assert.rejects(
      execFileAsync(process.execPath, [verifier, '--root', temporaryRoot], { cwd: temporaryRoot }),
      /Generated host file differs: README\.md/,
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
