import {createHash} from 'node:crypto';
import {execFile as execFileCallback} from 'node:child_process';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join, relative, resolve, sep} from 'node:path';
import {promisify} from 'node:util';
import {fileURLToPath, pathToFileURL} from 'node:url';

const execFile = promisify(execFileCallback);
const experimentDir = dirname(fileURLToPath(import.meta.url));
export const publicationRoot = resolve(experimentDir, '../../..');
export const BASE_COMMIT = '7dfe432d7463bab7186a8dacf50924af282f9a20';
export const PATCH_SHA256 = 'f3b3d35a0fec2e62f3b2c2a025fdafe1d4516ee360a21f67e959d24e2fcfd5f2';
export const EXPECTED_PROVIDER_MODEL = 'jev-1.13.0';
export const EXPECTED_PROVIDER_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
export const EXPECTED_PLUGIN_RUNTIME_VERSION = '0.4.0';
export const patchPath = join(experimentDir, 'variants/repair-bundled/repair-source.patch');
export const sharedNodeModules = join(publicationRoot, 'source/jev-workflows/node_modules');

const variantSourceRoots = Object.freeze({
  'control-released': join(experimentDir, 'variants/baseline/source/src'),
  'candidate-bundled-repair': join(experimentDir, 'variants/repair-bundled/source/jev-workflows/src'),
});

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export async function hashFile(path) {
  const bytes = await readFile(path);
  return {sha256: sha256(bytes), bytes: bytes.byteLength};
}

async function walkFiles(root, current = root, files = []) {
  const entries = await readdir(current, {withFileTypes: true});
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const absolute = join(current, entry.name);
    const path = relative(root, absolute).split(sep).join('/');
    if (entry.isSymbolicLink()) throw new Error(`source tree contains symlink: ${path}`);
    if (entry.isDirectory()) await walkFiles(root, absolute, files);
    else if (entry.isFile()) files.push({absolute, path});
    else throw new Error(`source tree contains unsupported entry: ${path}`);
  }
  return files;
}

export async function hashTree(root) {
  const files = [];
  for (const item of await walkFiles(root)) {
    const [bytes, stat] = await Promise.all([readFile(item.absolute), lstat(item.absolute)]);
    const mode = (stat.mode & 0o111) === 0 ? '100644' : '100755';
    files.push({path: item.path, mode, bytes: bytes.byteLength, sha256: sha256(bytes)});
  }
  const encoded = files.map(file => `${file.path}\0${file.mode}\0${file.bytes}\0${file.sha256}\n`).join('');
  return {sha256: sha256(encoded), files};
}

async function compareTrees(expectedRoot, actualRoot, label) {
  const [expected, actual] = await Promise.all([hashTree(expectedRoot), hashTree(actualRoot)]);
  if (expected.sha256 !== actual.sha256 || JSON.stringify(expected.files) !== JSON.stringify(actual.files)) {
    throw new Error(`${label} source tree differs from reproducible Git materialization`);
  }
  return actual;
}

async function gitArchive(destination) {
  const archive = join(destination, 'base.tar');
  const {stdout} = await execFile('git', [
    'archive', '--format=tar', BASE_COMMIT, 'source/jev-workflows',
  ], {cwd: publicationRoot, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024});
  await writeFile(archive, stdout, {mode: 0o600});
  try {
    await execFile('tar', ['-xf', archive, '-C', destination], {cwd: destination});
  } finally {
    await unlink(archive).catch(() => {});
  }
}

/** Materialize the exact released tree, optionally with the reviewed patch. */
export async function materializeVariant(arm, {withDependencies = false} = {}) {
  if (!(arm in variantSourceRoots)) throw new Error(`unknown experiment arm: ${arm}`);
  const root = await mkdtemp(join(tmpdir(), `jev-plugin-development-${arm}-`));
  let keep = false;
  try {
    await gitArchive(root);
    if (arm === 'candidate-bundled-repair') {
      const patch = await hashFile(patchPath);
      if (patch.sha256 !== PATCH_SHA256) throw new Error('repair patch hash mismatch');
      await execFile('git', ['apply', '--check', patchPath], {cwd: root});
      await execFile('git', ['apply', patchPath], {cwd: root});
    }
    const packageRoot = join(root, 'source/jev-workflows');
    const sourceRoot = join(packageRoot, 'src');
    if (withDependencies) {
      const dependencyInfo = await lstat(sharedNodeModules);
      if (!dependencyInfo.isDirectory() && !dependencyInfo.isSymbolicLink()) {
        throw new Error('shared dependency path is unavailable');
      }
      await symlink(sharedNodeModules, join(packageRoot, 'node_modules'), 'dir');
    }
    keep = true;
    return {
      arm,
      root,
      packageRoot,
      sourceRoot,
      async cleanup() { await rm(root, {recursive: true, force: true}); },
    };
  } finally {
    if (!keep) await rm(root, {recursive: true, force: true});
  }
}

export async function verifyMaterializedVariants() {
  const patch = await hashFile(patchPath);
  if (patch.sha256 !== PATCH_SHA256) throw new Error('repair patch hash mismatch');
  const baseline = await materializeVariant('control-released');
  const repair = await materializeVariant('candidate-bundled-repair');
  try {
    for (const materialized of [baseline, repair]) {
      const [contracts, packageMetadata] = await Promise.all([
        readFile(join(materialized.sourceRoot, 'contracts.ts'), 'utf8'),
        readFile(join(materialized.packageRoot, 'package.json'), 'utf8').then(JSON.parse),
      ]);
      if (!contracts.includes(`export const MODEL = '${EXPECTED_PROVIDER_MODEL}';`)
        || !contracts.includes(`export const ENDPOINT = '${EXPECTED_PROVIDER_ENDPOINT}';`)) {
        throw new Error(`${materialized.arm} provider contract differs from the frozen model or endpoint`);
      }
      if (packageMetadata.version !== EXPECTED_PLUGIN_RUNTIME_VERSION) {
        throw new Error(`${materialized.arm} runtime version differs from the frozen version`);
      }
    }
    const [baselineTree, repairTree] = await Promise.all([
      compareTrees(baseline.sourceRoot, variantSourceRoots['control-released'], 'control-released'),
      compareTrees(repair.sourceRoot, variantSourceRoots['candidate-bundled-repair'], 'candidate-bundled-repair'),
    ]);
    return {
      baseCommit: BASE_COMMIT,
      patch: {path: relative(publicationRoot, patchPath).split(sep).join('/'), ...patch},
      trees: {
        'control-released': {
          path: relative(publicationRoot, variantSourceRoots['control-released']).split(sep).join('/'),
          ...baselineTree,
        },
        'candidate-bundled-repair': {
          path: relative(publicationRoot, variantSourceRoots['candidate-bundled-repair']).split(sep).join('/'),
          ...repairTree,
        },
      },
    };
  } finally {
    await Promise.all([baseline.cleanup(), repair.cleanup()]);
  }
}

export async function loadVariantModules(arm) {
  const runtime = await materializeVariant(arm, {withDependencies: true});
  try {
    const base = pathToFileURL(`${runtime.sourceRoot}${sep}`);
    const [{runDecisionHook}, {configurePolicy}] = await Promise.all([
      import(new URL('./decision-hook.ts', base)),
      import(new URL('./policy.ts', base)),
    ]);
    return {...runtime, runDecisionHook, configurePolicy};
  } catch (error) {
    await runtime.cleanup();
    throw error;
  }
}
