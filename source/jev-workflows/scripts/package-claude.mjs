import { cp, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const source = resolve(fileURLToPath(new URL('..', import.meta.url)));
const args = process.argv.slice(2);
let targetArg;
let stateDirectory;
let credentialFile;
for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (arg === '--state-directory') {
    if (stateDirectory !== undefined || index + 1 >= args.length) throw new Error('Usage: node scripts/package-claude.mjs [--state-directory /absolute/path] /absolute/path/to/jev-workflows-claude');
    stateDirectory = args[++index];
  } else if (arg === '--credential-file') {
    if (credentialFile !== undefined || index + 1 >= args.length) throw new Error('Usage: node scripts/package-claude.mjs [--state-directory /absolute/path] [--credential-file /absolute/path] /absolute/path/to/jev-workflows-claude');
    credentialFile = args[++index];
  } else if (arg.startsWith('--')) throw new Error(`Unknown option: ${arg}`);
  else if (targetArg === undefined) targetArg = arg;
  else throw new Error('Usage: node scripts/package-claude.mjs [--state-directory /absolute/path] /absolute/path/to/jev-workflows-claude');
}
if (!targetArg) throw new Error('Usage: node scripts/package-claude.mjs [--state-directory /absolute/path] [--credential-file /absolute/path] /absolute/path/to/jev-workflows-claude');
if (stateDirectory !== undefined && (!isAbsolute(stateDirectory) || stateDirectory.includes('\0'))) throw new Error('--state-directory must be an absolute path without NUL characters');
if (credentialFile !== undefined && (!isAbsolute(credentialFile) || credentialFile.includes('\0'))) throw new Error('--credential-file must be an absolute path without NUL characters');
const target = resolve(targetArg);
if (!new Set(['jev-workflows', 'jev-workflows-claude']).has(basename(target))) throw new Error(`Claude package target must end in jev-workflows or jev-workflows-claude: ${target}`);
const targetRelativeToSource = relative(source, target);
if (targetRelativeToSource === '' || (!targetRelativeToSource.startsWith('..' + sep) && targetRelativeToSource !== '..')) throw new Error(`Claude package target must be outside the source tree: ${target}`);
let reconcileExisting = false;
try {
  const existing = await lstat(target);
  if (existing.isSymbolicLink() || !existing.isDirectory()) throw new Error(`Refusing to stage into a non-directory target: ${target}`);
  if (existing) {
    const allowed = new Set(['.claude-plugin', '.mcp.json', 'hooks', 'dist', 'skills', 'docs', 'README.md', 'LICENSE', 'CLAUDE-HOST-COMPATIBILITY.json']);
    const entries = await readdir(target);
    const markerPath = join(target, 'CLAUDE-HOST-COMPATIBILITY.json');
    let marker;
    try { marker = JSON.parse(await readFile(markerPath, 'utf8')); } catch { marker = undefined; }
    if (entries.length > 0 && marker?.packageKind !== 'claude-code-plugin') {
      throw new Error(`Refusing to stage into a non-empty target without Claude compatibility marker: ${target}`);
    }
    for (const entry of entries) if (!allowed.has(entry)) throw new Error(`Refusing to overwrite unrecognized target entry ${entry}: ${target}`);
    reconcileExisting = entries.length > 0;
  }
} catch (error) {
  if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
}
const stagingTarget = reconcileExisting ? join(dirname(target), `.jev-claude-stage-${randomUUID()}`) : target;
try {
await mkdir(stagingTarget, {recursive: true});
await cp(join(source, 'templates/claude'), stagingTarget, {recursive: true});
for (const name of ['server.mjs', 'claude-hook.mjs']) await cp(join(source, 'dist', name), join(stagingTarget, 'dist', name));
for (const name of ['skills', 'docs']) await cp(join(source, name), join(stagingTarget, name), {recursive: true});
for (const name of ['README.md', 'LICENSE']) await cp(join(source, name), join(stagingTarget, name));
if (process.env.JEV_PACKAGE_TEST_FAIL_AFTER_STAGE === '1') throw new Error('injected Claude package staging failure');

const mcpPath = join(stagingTarget, '.mcp.json');
const mcp = JSON.parse(await readFile(mcpPath, 'utf8'));
const server = mcp.mcpServers?.['jev-workflows'];
if (!server || server.type !== 'stdio' || !Array.isArray(server.args) || server.args.some(value => typeof value !== 'string' || !value.includes('${CLAUDE_PLUGIN_ROOT}'))) throw new Error('Expected native Claude MCP declaration');
if (stateDirectory !== undefined) server.env = {...server.env, JEV_STATE_DIRECTORY: stateDirectory};
if (credentialFile !== undefined) server.env = {...server.env, JEV_API_KEY_FILE: credentialFile};
await writeFile(mcpPath, JSON.stringify(mcp, null, 2) + '\n');

const hooksPath = join(stagingTarget, 'hooks/hooks.json');
const hooks = JSON.parse(await readFile(hooksPath, 'utf8'));
  if (stateDirectory !== undefined || credentialFile !== undefined) {
  const shellQuote = value => `'${value.replaceAll("'", "'\\''")}'`;
  const assignments = [
    ...(stateDirectory === undefined ? [] : [`JEV_STATE_DIRECTORY=${shellQuote(stateDirectory)}`]),
    ...(credentialFile === undefined ? [] : [`JEV_API_KEY_FILE=${shellQuote(credentialFile)}`]),
  ].join(' ');
  for (const groups of Object.values(hooks.hooks ?? {})) for (const group of groups) for (const hook of group.hooks ?? []) {
    if (hook.type === 'command') hook.command = `${assignments} ${hook.command}`;
  }
}
await writeFile(hooksPath, JSON.stringify(hooks, null, 2) + '\n');
await writeFile(join(stagingTarget, 'CLAUDE-HOST-COMPATIBILITY.json'), JSON.stringify({
  name: 'jev-workflows', packageKind: 'claude-code-plugin', generatedAt: new Date().toISOString(),
  stateDirectory: stateDirectory ?? null,
  credentialFile: credentialFile ?? null,
  stateMode: stateDirectory === undefined ? 'user-default' : 'explicit-directory',
  supportedEvents: Object.keys(hooks.hooks ?? {}),
  credentialHandling: 'Environment names and paths only. No credential values are packaged.',
}, null, 2) + '\n');
if (reconcileExisting) {
  const backupTarget = join(dirname(target), `.jev-claude-backup-${randomUUID()}`);
  await rename(target, backupTarget);
  try {
    await rename(stagingTarget, target);
  } catch (error) {
    try { await rename(backupTarget, target); }
    catch (rollbackError) {
      throw new Error(`Claude package replacement failed and rollback failed; preserved backup at ${backupTarget}: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
    }
    throw error;
  }
  await rm(backupTarget, {recursive: true, force: true});
}
console.log(`Claude plugin package staged: ${target}${stateDirectory === undefined ? ' (user state default)' : ' (state directory override configured)'}`);
} finally {
  if (reconcileExisting) await rm(stagingTarget, {recursive: true, force: true});
}
