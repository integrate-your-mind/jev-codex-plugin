import { cp, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// Stage the legacy Codex shape used by hosts that do not yet load hooks from
// an Agent Plugin root manifest. The portable root package remains untouched.
// The target must be a caller-selected directory outside this source tree.
const source = resolve(fileURLToPath(new URL('..', import.meta.url)));
const cliArgs = process.argv.slice(2);
let targetArg;
let stateDirectory;
for (let index = 0; index < cliArgs.length; index += 1) {
  const arg = cliArgs[index];
  if (arg === '--state-directory') {
    if (stateDirectory !== undefined || index + 1 >= cliArgs.length) {
      throw new Error('Usage: node scripts/package-host.mjs [--state-directory /absolute/path] /absolute/path/to/jev-workflows');
    }
    stateDirectory = cliArgs[++index];
    continue;
  }
  if (arg.startsWith('--')) {
    throw new Error(`Unknown option: ${arg}`);
  }
  if (targetArg !== undefined) {
    throw new Error('Usage: node scripts/package-host.mjs [--state-directory /absolute/path] /absolute/path/to/jev-workflows');
  }
  targetArg = arg;
}
if (!targetArg) {
  throw new Error('Usage: node scripts/package-host.mjs [--state-directory /absolute/path] /absolute/path/to/jev-workflows');
}
if (stateDirectory !== undefined && (!isAbsolute(stateDirectory) || stateDirectory.includes('\0'))) {
  throw new Error('--state-directory must be an absolute path without NUL characters');
}

const target = resolve(targetArg);
if (basename(target) !== 'jev-workflows') {
  throw new Error(`Host package target must end in jev-workflows: ${target}`);
}
const targetRelativeToSource = relative(source, target);
if (targetRelativeToSource === '' || (!targetRelativeToSource.startsWith('..' + sep) && targetRelativeToSource !== '..')) {
  throw new Error(`Host package target must be outside the source tree: ${target}`);
}

const forbidden = [
  'plugin.json',
  'mcp.json',
  'node_modules',
  'work',
  'receipts',
  'src',
  'tests',
  'scripts',
  'fixtures',
  'package.json',
  'package-lock.json',
  'tsconfig.json',
];

// These are the runtime files required by the legacy Codex loader. In
// particular, the root plugin.json and mcp.json are deliberately absent.
const included = [
  '.codex-plugin',
  '.mcp.json',
  'dist',
  'hooks',
  'skills',
  'docs',
  'README.md',
  'LICENSE',
  '.gitignore',
];

let targetExists = true;
try {
  await stat(target);
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
  targetExists = false;
}

if (targetExists) {
  const entries = await readdir(target);
  const generated = entries.includes('HOST-COMPATIBILITY.json');
  if (!generated && entries.length > 0) {
    throw new Error(`Refusing to stage into a non-empty target without HOST-COMPATIBILITY.json: ${target}`);
  }
  for (const name of forbidden) {
    if (entries.includes(name)) {
      throw new Error(`Host target contains excluded path ${name}; choose a clean target: ${target}`);
    }
  }
  const allowed = new Set([...included, 'HOST-COMPATIBILITY.json']);
  for (const name of entries) {
    if (!allowed.has(name)) {
      throw new Error(`Host target contains an unrecognized path ${name}; choose a clean target: ${target}`);
    }
  }
}

await mkdir(target, { recursive: true });

for (const name of included) {
  await cp(join(source, name), join(target, name), { recursive: true });
}

// The legacy Codex parser does not expand Agent Plugin placeholders in the
// stdio `args` or `cwd` fields. It resolves a relative cwd beneath the plugin
// root and passes args through unchanged. Keep the portable `${PLUGIN_ROOT}`
// declaration canonical in the source package, but emit the equivalent
// relative declaration in this host-only package.
const hostMcpPath = join(target, '.mcp.json');
const hostMcp = JSON.parse(await readFile(hostMcpPath, 'utf8'));
const hostServer = hostMcp?.mcpServers?.['jev-workflows'];
if (!hostServer || hostServer.type !== 'stdio' || !Array.isArray(hostServer.args)) {
  throw new Error('Expected jev-workflows stdio server with an args array in .mcp.json');
}
if (!Array.isArray(hostServer.env_vars) || hostServer.env_vars.some((value) => typeof value !== 'string')) {
  throw new Error('Expected jev-workflows legacy MCP env_vars to be a string array');
}
hostServer.env_vars = [...new Set([...hostServer.env_vars, 'XDG_STATE_HOME', 'JEV_STATE_DIRECTORY'])];
const pluginRootToken = '${PLUGIN_ROOT}';
const toLegacyPath = (value, field) => {
  if (value === pluginRootToken) return '.';
  if (value.startsWith(`${pluginRootToken}/`)) return value.slice(pluginRootToken.length + 1);
  if (value.includes(pluginRootToken)) {
    throw new Error(`Unsupported ${field} placeholder in legacy host package: ${value}`);
  }
  return value;
};
hostServer.args = hostServer.args.map((value) => {
  if (typeof value !== 'string') throw new Error('MCP stdio args must be strings');
  return toLegacyPath(value, 'args');
});
if (typeof hostServer.cwd === 'string') hostServer.cwd = toLegacyPath(hostServer.cwd, 'cwd');
const existingEnv = hostServer.env ?? {};
if (Object.prototype.hasOwnProperty.call(existingEnv, 'PLUGIN_DATA')) {
  throw new Error('Refusing to override reserved MCP environment variable PLUGIN_DATA');
}
const stateEnvironment = stateDirectory === undefined
  ? { JEV_STATE_MODE: 'user' }
  : { JEV_STATE_DIRECTORY: stateDirectory };
hostServer.env = { ...existingEnv, ...stateEnvironment };
await writeFile(hostMcpPath, JSON.stringify(hostMcp, null, 2) + '\n');

const hostHooksPath = join(target, 'hooks/hooks.json');
const hostHooks = JSON.parse(await readFile(hostHooksPath, 'utf8'));
let rewrittenHookCommands = 0;
const shellQuote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const hookStateAssignment = stateDirectory === undefined
  ? `JEV_STATE_MODE=${shellQuote('user')}`
  : `JEV_STATE_DIRECTORY=${shellQuote(stateDirectory)}`;
for (const entries of Object.values(hostHooks.hooks ?? {})) {
  if (!Array.isArray(entries)) throw new Error('Expected hook event entries to be arrays');
  for (const entry of entries) {
    for (const hook of entry?.hooks ?? []) {
      if (hook?.type !== 'command') continue;
      if (typeof hook.command !== 'string') throw new Error('Expected command hook command to be a string');
      hook.command = `${hookStateAssignment} ${hook.command}`;
      rewrittenHookCommands += 1;
    }
  }
}
if (rewrittenHookCommands === 0) throw new Error('No command hooks found to configure with host state mode');
await writeFile(hostHooksPath, JSON.stringify(hostHooks, null, 2) + '\n');

const generatedAt = new Date().toISOString();
const compatibility = {
  name: 'jev-workflows',
  packageKind: 'codex-legacy-host-compatibility',
  generatedAt,
  source: 'Generated from the portable source package; root plugin.json and mcp.json are intentionally omitted.',
  loaderReason: 'Codex hosts that select the legacy .codex-plugin/plugin.json shape can discover hooks/hooks.json.',
  retained: ['.codex-plugin/plugin.json', '.mcp.json', 'hooks/hooks.json', 'skills/', 'dist/', 'LICENSE'],
  omitted: ['plugin.json', 'mcp.json', 'node_modules/', 'work/', 'receipts/', 'src/', 'tests/'],
  credentialHandling: 'The .mcp.json env_vars field contains names only; the host must provide values.',
  legacyMcpPathSemantics: 'Relative cwd is resolved beneath the plugin root; stdio args are passed through unchanged.',
  legacyMcpDeclaration: { args: hostServer.args, cwd: hostServer.cwd ?? null },
  legacyMcpSource: 'https://github.com/openai/codex/blob/main/codex-rs/codex-mcp/src/plugin_config.rs',
  stateDirectory: stateDirectory === undefined ? null : {
    path: stateDirectory,
    source: '--state-directory',
    mcpEnvironment: 'JEV_STATE_DIRECTORY',
    rewrittenHookCommands,
    pluginDataReserved: true,
  },
  stateMode: stateDirectory === undefined ? {
    mode: 'user',
    source: 'neutral-legacy-host-default',
    mcpEnvironment: 'JEV_STATE_MODE',
    rewrittenHookCommands,
    pluginDataReserved: true,
  } : null,
};
await writeFile(join(target, 'HOST-COMPATIBILITY.json'), JSON.stringify(compatibility, null, 2) + '\n');

const readmePath = join(target, 'README.md');
const readme = await readFile(readmePath, 'utf8');
const marker = '<!-- generated: codex legacy host compatibility -->';
const stateNote = stateDirectory === undefined
  ? ' It was generated with the neutral legacy-host user-state mode; the same `JEV_STATE_MODE=user` setting is passed to MCP and hook commands without embedding a machine-specific path.'
  : ` It was generated with the host-local state directory override from \`--state-directory\`; the same path is passed as \`JEV_STATE_DIRECTORY\` to MCP and hook commands. \`PLUGIN_DATA\` remains reserved and unchanged.`;
const note = `\n\n${marker}\n## Codex legacy host package\n\nThis generated directory is the Codex compatibility variant of Jev Workflows. It intentionally omits the portable root \`plugin.json\` and \`mcp.json\` so a legacy Codex loader selects \`.codex-plugin/plugin.json\`, discovers \`hooks/hooks.json\`, and uses the \`.mcp.json\` environment-name overlay. The overlay contains no credential values.${stateNote} See \`HOST-COMPATIBILITY.json\` for the generated file set and loader rationale.\n`;
const withoutPriorNote = readme.replace(new RegExp(`\\n?${marker}[\\s\\S]*$`), '');
await writeFile(readmePath, withoutPriorNote.trimEnd() + note);

console.log(`Codex legacy host package staged: ${target}${stateDirectory === undefined ? ' (neutral user state mode)' : ' (state directory override configured)'}`);
