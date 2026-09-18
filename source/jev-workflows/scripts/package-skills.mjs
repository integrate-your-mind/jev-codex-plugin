import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { isAbsolute, join, relative, resolve } from 'node:path';

const execFileAsync = promisify(execFile);
const sourceRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const skillNames = ['classify-decision', 'diagnose-failure', 'check-completion'];
const publicSource = 'https://github.com/integrate-your-mind/jev-codex-plugin';

function usage() {
  throw new Error('Usage: node scripts/package-skills.mjs [--source /absolute/source-root] /absolute/output-directory');
}

function parseArgs(argv) {
  let source = sourceRoot;
  let target;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--source') {
      if (source !== sourceRoot || i + 1 >= argv.length) usage();
      source = resolve(argv[++i]);
      continue;
    }
    if (arg.startsWith('--') || target !== undefined) usage();
    target = resolve(arg);
  }
  if (target === undefined || !isAbsolute(target)) usage();
  return {source, target};
}

async function exists(path) {
  try { await stat(path); return true; } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function ensureFreshTarget(target) {
  if (!(await exists(target))) {
    await mkdir(target, {recursive: true});
    return;
  }
  const entries = await readdir(target);
  if (entries.length > 0) {
    throw new Error(`Refusing non-empty skill package target: ${target}`);
  }
}

async function requiredInputs(source) {
  const pluginPath = join(source, '.codex-plugin', 'plugin.json');
  const licensePath = join(source, 'LICENSE');
  const distScriptPath = join(source, 'dist', 'cli.mjs');
  if (!(await exists(pluginPath))) throw new Error(`Missing input: ${pluginPath}`);
  if (!(await exists(licensePath))) throw new Error(`Missing input: ${licensePath}`);
  if (!(await exists(distScriptPath))) throw new Error(`Missing built CLI input: ${distScriptPath}`);
  const plugin = JSON.parse(await readFile(pluginPath, 'utf8'));
  if (typeof plugin.name !== 'string' || typeof plugin.version !== 'string') {
    throw new Error(`Invalid plugin manifest: ${pluginPath}`);
  }
  return {plugin, licensePath, distScriptPath};
}

async function skillFiles(source, name, licensePath, distScriptPath) {
  const root = join(source, 'skills', name);
  const skillPath = join(root, 'SKILL.md');
  const scriptPath = join(root, 'scripts', 'jev.mjs');
  if (!(await exists(skillPath))) throw new Error(`Missing input: ${skillPath}`);
  if (!(await exists(scriptPath))) throw new Error(`Missing generated skill CLI input: ${scriptPath}`);
  const [skillScript, distScript] = await Promise.all([readFile(scriptPath), readFile(distScriptPath)]);
  if (!skillScript.equals(distScript)) throw new Error(`Generated CLI differs from dist/cli.mjs: ${scriptPath}`);
  const files = [{path: skillPath, archive: `${name}/SKILL.md`}];
  const references = join(root, 'references');
  if (await exists(references)) {
    const walk = async (directory) => {
      for (const entry of (await readdir(directory, {withFileTypes: true})).sort((a, b) => a.name.localeCompare(b.name))) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) await walk(path);
        else if (entry.isFile()) files.push({path, archive: `${name}/${relative(root, path)}`});
      }
    };
    await walk(references);
  }
  files.push({path: scriptPath, archive: `${name}/scripts/jev.mjs`});
  files.push({path: licensePath, archive: `${name}/LICENSE`});
  return files;
}

async function zipFiles(files, archivePath) {
  const manifest = JSON.stringify(files.map(({path, archive}) => ({path, archive})));
  const python = String.raw`
import hashlib, json, sys, zipfile
files = json.loads(sys.argv[1])
archive = sys.argv[2]
with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as z:
    for item in files:
        with open(item["path"], "rb") as handle:
            data = handle.read()
        info = zipfile.ZipInfo(item["archive"], (2026, 1, 1, 0, 0, 0))
        info.compress_type = zipfile.ZIP_DEFLATED
        info.external_attr = 0o644 << 16
        z.writestr(info, data)
`;
  await execFileAsync('/usr/bin/python3', ['-c', python, manifest, archivePath]);
}

const {source, target} = parseArgs(process.argv.slice(2));
await ensureFreshTarget(target);
const {plugin, licensePath, distScriptPath} = await requiredInputs(source);
const archives = [];
for (const name of skillNames) {
  const files = await skillFiles(source, name, licensePath, distScriptPath);
  const archive = join(target, `${name}.zip`);
  await zipFiles(files, archive);
  const bytes = await readFile(archive);
  archives.push({
    skill: name,
    archive: `${name}.zip`,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    entries: files.map(({archive: entry}) => entry),
  });
}

const generatedAt = new Date().toISOString();
const metadata = {
  package: 'jev-workflows-standalone-skills',
  version: plugin.version,
  source: publicSource,
  generatedAt,
  archives,
  reviewCaveat: 'These ZIPs package local Codex skills and a bundled CLI for directory review. They are not an OpenAI Plugins Directory submission and do not provide a hosted MCP endpoint or remote service.',
};
await writeFile(join(target, 'manifest.json'), JSON.stringify(metadata, null, 2) + '\n');
await writeFile(join(target, 'SHA256SUMS'), archives.map(({sha256, archive}) => `${sha256}  ${archive}`).join('\n') + '\n');
console.log(`Packaged ${archives.length} standalone skill ZIPs in ${target}`);
