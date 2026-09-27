import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const verifier = join(repositoryRoot, 'scripts/verify-distribution.mjs');

const copyFixture = async (targetRoot, sourceRepository = repositoryRoot) => {
  const sourceRoot = join(sourceRepository, 'source/jev-workflows');
  await cp(join(sourceRepository, '.agents/plugins/marketplace.json'), join(targetRoot, '.agents/plugins/marketplace.json'), { recursive: true });
  await cp(sourceRoot, join(targetRoot, 'source/jev-workflows'), {
    recursive: true,
    filter: (source) => !relative(sourceRoot, source).split(sep).some(part => ['node_modules', 'work', 'receipts'].includes(part)),
  });
  await cp(join(sourceRepository, 'plugins/jev-workflows'), join(targetRoot, 'plugins/jev-workflows'), { recursive: true });
  await cp(join(sourceRepository, 'scripts/verify-distribution.mjs'), join(targetRoot, 'scripts/verify-distribution.mjs'));
  await cp(join(sourceRepository, 'source/jev-workflows/scripts/package-host.mjs'), join(targetRoot, 'source/jev-workflows/scripts/package-host.mjs'));
};

test('distribution verifier accepts the checked-in package', async () => {
  await execFileAsync(process.execPath, [verifier], { cwd: repositoryRoot });
});

test('fixture filtering ignores work directory names above the source root', async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'jev-distribution-ancestor-'));
  try {
    const nestedSource = join(temporaryRoot, 'work', 'repository');
    const target = join(temporaryRoot, 'target');
    await copyFixture(nestedSource);
    await copyFixture(target, nestedSource);
    await execFileAsync(process.execPath, [verifier, '--root', target], { cwd: target });
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
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
