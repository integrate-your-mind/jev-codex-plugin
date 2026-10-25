import {mkdir, mkdtemp, readFile, rename, rm, stat, writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {acquireLock} from './local-ci.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const CONTROLLER = 'local-ci.mjs';
const GUEST = 'run-guest.sh';

function git(repoRoot, args, allowMissing = false) {
  const result = spawnSync('git', args, {cwd: repoRoot, encoding: 'utf8'});
  if (result.error) throw result.error;
  if (allowMissing && result.status === 1) return '';
  if (result.status !== 0) throw new Error((result.stderr || `git ${args.join(' ')} failed`).trim());
  return result.stdout.trim();
}

function shellQuote(value) { return `'${value.replaceAll("'", "'\\''")}'`; }

export async function installHook({repoRoot = root, lockRoot} = {}) {
  const commonDir = resolve(repoRoot, git(repoRoot, ['rev-parse', '--git-common-dir']));
  const configuredHooksPath = git(repoRoot, ['config', '--get', 'core.hooksPath'], true) || undefined;
  if (configuredHooksPath) throw new Error(`Refusing to install with configured core.hooksPath: ${configuredHooksPath}`);
  const hooksDir = resolve(repoRoot, git(repoRoot, ['rev-parse', '--git-path', 'hooks']));
  const stateDir = join(commonDir, 'jev-local-ci');
  const trustedDir = join(stateDir, 'trusted');
  const controllerSource = join(repoRoot, 'scripts', CONTROLLER);
  const guestSource = join(repoRoot, '.ci', GUEST);
  const controller = join(trustedDir, CONTROLLER);
  if (!existsSync(controllerSource) || !existsSync(guestSource)) throw new Error('Reviewed local-CI controller and guest runner are both required');
  const release = await acquireLock(stateDir, lockRoot);
  try {
    await mkdir(trustedDir, {recursive: true, mode: 0o700});
    await mkdir(hooksDir, {recursive: true, mode: 0o700});
    const hookPath = join(hooksDir, 'pre-push');
    const hook = `#!/bin/sh\n# jev-local-ci pre-push hook\nexec ${shellQuote(process.execPath)} ${shellQuote(controller)} --pre-push\n`;
    if (existsSync(hookPath)) {
      const existing = await readFile(hookPath, 'utf8');
      if (existing !== hook) throw new Error(`Refusing to overwrite existing pre-push hook: ${hookPath}`);
    }
    const stage = await mkdtemp(join(stateDir, 'install-'));
    const targets = [
      {source: controllerSource, destination: controller, mode: 0o600},
      {source: guestSource, destination: join(trustedDir, GUEST), mode: 0o600},
      {bytes: Buffer.from(`${JSON.stringify({controller: CONTROLLER, guestRunner: GUEST, installedAt: new Date().toISOString()}, null, 2)}\n`), destination: join(trustedDir, 'INSTALL.json'), mode: 0o600},
      {bytes: Buffer.from(hook), destination: hookPath, mode: 0o755},
    ];
    const applied = [];
    try {
      for (const [index, target] of targets.entries()) {
        target.staged = join(stage, String(index));
        target.previous = existsSync(target.destination) ? {bytes: await readFile(target.destination), mode: (await stat(target.destination)).mode & 0o777} : null;
        await writeFile(target.staged, target.bytes ?? await readFile(target.source), {mode: target.mode});
      }
      for (const target of targets) {
        await rename(target.staged, target.destination);
        applied.push(target);
      }
    } catch (error) {
      for (const target of applied.reverse()) {
        if (target.previous) {
          await writeFile(target.staged, target.previous.bytes, {mode: target.previous.mode});
          await rename(target.staged, target.destination);
        } else await rm(target.destination, {force: true});
      }
      throw error;
    } finally { await rm(stage, {recursive: true, force: true}); }
    return {commonDir, stateDir, hooksDir, hookPath, controller, guestRunner: join(trustedDir, GUEST)};
  } finally { await release(); }
}

if (process.argv[1]?.endsWith('/install-local-ci-hook.mjs')) installHook().then(result => console.log(`Installed local CI pre-push hook at ${result.hookPath}`)).catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
