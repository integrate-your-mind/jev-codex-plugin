import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const defaultRoot = resolve(scriptDirectory, '..');

const args = process.argv.slice(2);
let repositoryRoot = defaultRoot;
for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (arg === '--root' && index + 1 < args.length) {
    repositoryRoot = resolve(args[++index]);
    continue;
  }
  throw new Error('Usage: node scripts/verify-distribution.mjs [--root /absolute/repository/root]');
}

const sourceRoot = join(repositoryRoot, 'source/jev-workflows');
const committedHostRoot = join(repositoryRoot, 'plugins/jev-workflows');
const marketplacePath = join(repositoryRoot, '.agents/plugins/marketplace.json');

const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'));

const filesUnder = async (root, prefix = '') => {
  const entries = await readdir(join(root, prefix), { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relativePath = join(prefix, entry.name);
    if (entry.isDirectory()) {
      files.push(...await filesUnder(root, relativePath));
    } else if (entry.isFile()) {
      files.push(relativePath);
    } else {
      throw new Error(`Unsupported non-file entry in distribution: ${relativePath}`);
    }
  }
  return files;
};

const normalizedCompatibility = (contents, path) => {
  if (path !== 'HOST-COMPATIBILITY.json') return null;
  const parsed = JSON.parse(contents);
  delete parsed.generatedAt;
  return parsed;
};

const compareHostPackage = async (generatedRoot) => {
  const expectedFiles = (await filesUnder(committedHostRoot)).sort();
  const generatedFiles = (await filesUnder(generatedRoot)).sort();
  if (!isDeepStrictEqual(expectedFiles, generatedFiles)) {
    throw new Error(`Generated host file set differs. committed=${expectedFiles.join(',')} generated=${generatedFiles.join(',')}`);
  }

  for (const path of expectedFiles) {
    const committed = await readFile(join(committedHostRoot, path));
    const generated = await readFile(join(generatedRoot, path));
    const committedCompatibility = normalizedCompatibility(committed, path);
    const generatedCompatibility = normalizedCompatibility(generated, path);
    if (committedCompatibility !== null || generatedCompatibility !== null) {
      if (!isDeepStrictEqual(committedCompatibility, generatedCompatibility)) {
        throw new Error(`Generated host file differs: ${path}`);
      }
    } else if (!committed.equals(generated)) {
      throw new Error(`Generated host file differs: ${path}`);
    }
  }
};

const verifyMarketplace = async () => {
  const marketplace = await readJson(marketplacePath);
  if (marketplace.name !== 'jev-workflows') throw new Error('Unexpected marketplace name');
  const entries = marketplace.plugins?.filter((plugin) => plugin?.name === 'jev-workflows');
  if (entries?.length !== 1) throw new Error('Marketplace must contain exactly one jev-workflows plugin entry');
  const entry = entries[0];
  if (entry.source?.source !== 'local' || entry.source?.path !== './plugins/jev-workflows') {
    throw new Error('Marketplace jev-workflows entry must use local path ./plugins/jev-workflows');
  }
  const resolvedSource = resolve(repositoryRoot, entry.source.path);
  if (relative(repositoryRoot, resolvedSource).startsWith('..') || resolvedSource !== committedHostRoot) {
    throw new Error(`Marketplace source does not resolve to the committed host package: ${entry.source.path}`);
  }
  await stat(resolvedSource);
};

const versionPaths = [
  'source/jev-workflows/package.json',
  'source/jev-workflows/plugin.json',
  'source/jev-workflows/.codex-plugin/plugin.json',
  'plugins/jev-workflows/.codex-plugin/plugin.json',
];
const verifyVersionParity = async () => {
  const versions = [];
  for (const path of versionPaths) {
    const manifest = await readJson(join(repositoryRoot, path));
    if (typeof manifest.version !== 'string' || manifest.version.length === 0) {
      throw new Error(`Missing version in ${path}`);
    }
    versions.push([path, manifest.version]);
  }
  const distinctVersions = new Set(versions.map(([, version]) => version));
  if (distinctVersions.size !== 1) {
    throw new Error(`Manifest versions differ: ${versions.map(([path, version]) => `${path}=${version}`).join(', ')}`);
  }
  return versions[0][1];
};

await verifyMarketplace();
const version = await verifyVersionParity();
let temporaryRoot;
try {
  temporaryRoot = await mkdtemp(join(tmpdir(), 'jev-distribution-'));
  const generatedRoot = join(temporaryRoot, 'jev-workflows');
  await execFileAsync(process.execPath, ['scripts/package-host.mjs', generatedRoot], { cwd: sourceRoot });
  await compareHostPackage(generatedRoot);
  console.log(`Distribution verified: marketplace path, version ${version}, generated host package parity`);
} finally {
  if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
}
