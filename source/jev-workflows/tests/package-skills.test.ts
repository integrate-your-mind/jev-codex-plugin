import {copyFile, mkdtemp, mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile, spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {describe, it} from 'node:test';
import assert from 'node:assert/strict';

const execFileAsync = promisify(execFile);
const script = fileURLToPath(new URL('../scripts/package-skills.mjs', import.meta.url));
const names = ['classify-decision', 'diagnose-failure', 'check-completion'];

function runNode(args: string[], env: NodeJS.ProcessEnv, input = ''): Promise<{stdout: string; stderr: string; code: number}> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {env});
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({stdout, stderr, code: code ?? -1}));
    child.stdin.end(input);
  });
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'jev-package-skills-'));
  await mkdir(join(root, '.codex-plugin'), {recursive: true});
  await mkdir(join(root, 'scripts'), {recursive: true});
  await mkdir(join(root, 'skills'), {recursive: true});
  await writeFile(join(root, '.codex-plugin/plugin.json'), JSON.stringify({name: 'jev-workflows', version: '0.3.0'}));
  await writeFile(join(root, 'LICENSE'), 'MIT fixture license\n');
  const builtCli = fileURLToPath(new URL('../dist/cli.mjs', import.meta.url));
  await copyFile(builtCli, join(root, 'dist-cli.mjs'));
  for (const name of names) {
    await mkdir(join(root, 'skills', name, 'references'), {recursive: true});
    await mkdir(join(root, 'skills', name, 'scripts'), {recursive: true});
    await writeFile(join(root, 'skills', name, 'SKILL.md'), `# ${name}\n`);
    await writeFile(join(root, 'skills', name, 'references/example.md'), 'reference bytes\n');
    await copyFile(builtCli, join(root, 'skills', name, 'scripts/jev.mjs'));
  }
  await mkdir(join(root, 'dist'), {recursive: true});
  await copyFile(builtCli, join(root, 'dist/cli.mjs'));
  // These paths prove the packager is allowlisted rather than recursive.
  await mkdir(join(root, 'node_modules/secret'), {recursive: true});
  await writeFile(join(root, 'node_modules/secret/token.txt'), 'must not ship\n');
  await mkdir(join(root, 'work/private'), {recursive: true});
  await writeFile(join(root, 'work/private/state.json'), 'must not ship\n');
  return root;
}

async function inspectArchive(archive: string) {
  const python = `
import json, sys, zipfile
with zipfile.ZipFile(sys.argv[1]) as z:
    print(json.dumps({"names": z.namelist(), "skill": z.read(sys.argv[2]).decode(), "cli": z.read(sys.argv[3]).decode()}))
`;
  const {stdout} = await execFileAsync('/usr/bin/python3', ['-c', python, archive, `${archive.split('/').at(-1)?.replace('.zip', '')}/SKILL.md`, `${archive.split('/').at(-1)?.replace('.zip', '')}/scripts/jev.mjs`]);
  return JSON.parse(stdout) as {names: string[]; skill: string; cli: string};
}

describe('standalone skill packaging', () => {
  it('creates exactly three isolated ZIPs, manifest, and checksums', async () => {
    const source = await fixture();
    const output = await mkdtemp(join(tmpdir(), 'jev-package-output-'));
    try {
      await execFileAsync(process.execPath, [script, '--source', source, output]);
      const manifest = JSON.parse(await readFile(join(output, 'manifest.json'), 'utf8')) as {version: string; archives: Array<{skill: string; archive: string; entries: string[]; sha256: string}>; reviewCaveat: string};
      assert.equal(manifest.version, '0.3.0');
      assert.match(manifest.reviewCaveat, /not an OpenAI Plugins Directory submission/);
      assert.deepEqual(manifest.archives.map((item) => item.skill), names);
      for (const item of manifest.archives) {
        const inspected = await inspectArchive(join(output, item.archive));
        assert.deepEqual(inspected.names.sort(), [`${item.skill}/LICENSE`, `${item.skill}/SKILL.md`, `${item.skill}/references/example.md`, `${item.skill}/scripts/jev.mjs`].sort());
        assert.equal(inspected.skill, `# ${item.skill}\n`);
        assert.equal(inspected.cli.includes('missing_api_key'), true);
        assert.equal(inspected.names.some((name) => name.includes('node_modules') || name.includes('work/')), false);
      }
      const sums = await readFile(join(output, 'SHA256SUMS'), 'utf8');
      assert.equal(sums.trim().split('\n').length, 3);
    } finally {
      await rm(source, {recursive: true, force: true});
      await rm(output, {recursive: true, force: true});
    }
  });

  it('runs each actual bundled CLI for status, preview, and no-key evaluation after extraction', async () => {
    const source = await fixture();
    const output = await mkdtemp(join(tmpdir(), 'jev-package-output-'));
    const extracted = await mkdtemp(join(tmpdir(), 'jev-package-extract-'));
    try {
      await execFileAsync(process.execPath, [script, '--source', source, output]);
      const inputs: Record<string, object> = {
        'classify-decision': {domain: 'task', question: 'Which task?', context: 'Need bounded task.', candidates: [{id: 'a', description: 'first'}, {id: 'b', description: 'second'}], evidence: []},
        'diagnose-failure': {task: 'diagnose the failing command', command: 'npm test', exitCode: 1, output: 'AssertionError', evidence: [{id: 'log:1', text: 'AssertionError'}]},
        'check-completion': {claim: 'The task is complete', acceptanceCriteria: ['A result exists'], evidence: [{id: 'e1', text: 'A result exists'}]},
      };
      for (const name of names) {
        const archive = join(output, `${name}.zip`);
        await execFileAsync('/usr/bin/python3', ['-c', 'import sys, zipfile; z=zipfile.ZipFile(sys.argv[1]); z.extractall(sys.argv[2])', archive, extracted]);
        const cli = join(extracted, name, 'scripts/jev.mjs');
        const state = await mkdtemp(join(tmpdir(), 'jev-package-state-'));
        try {
          const env = {...process.env, JEV_ENABLED: '1', TYPESAFE_API_KEY: '', JEV_API_KEY: undefined, JEV_STATE_MODE: undefined, PLUGIN_DATA: undefined, JEV_STATE_DIRECTORY: state};
          const statusRun = await runNode([cli, 'status'], env);
          const status = JSON.parse(statusRun.stdout);
          const input = JSON.stringify(inputs[name]);
          const command = name === 'diagnose-failure' ? 'classify-failure' : name;
          const previewRun = await runNode([cli, command], env, input);
          const preview = JSON.parse(previewRun.stdout);
          const unavailableRun = await runNode([cli, command, '--evaluate'], env, input);
          const unavailable = JSON.parse(unavailableRun.stdout);
          assert.equal(statusRun.code, 0);
          assert.equal(statusRun.stderr, '');
          assert.equal(status.version, '0.3.0');
          assert.equal(status.credentialConfigured, false);
          assert.equal(previewRun.code, 0);
          assert.equal(previewRun.stderr, '');
          assert.equal(preview.status, 'preview');
          assert.ok(Array.isArray(preview.evidenceIds));
          assert.equal(unavailableRun.code, 0);
          assert.equal(unavailableRun.stderr, '');
          assert.deepEqual(unavailable, {status: 'unavailable', reasonCode: 'missing_api_key'});
        } finally {
          await rm(state, {recursive: true, force: true});
          await rm(join(extracted, name), {recursive: true, force: true});
        }
      }
    } finally {
      await rm(source, {recursive: true, force: true});
      await rm(output, {recursive: true, force: true});
      await rm(extracted, {recursive: true, force: true});
    }
  });

  it('rejects a non-empty output directory before creating artifacts', async () => {
    const source = await fixture();
    const output = await mkdtemp(join(tmpdir(), 'jev-package-output-'));
    try {
      await writeFile(join(output, 'existing.txt'), 'preserve\n');
      await assert.rejects(execFileAsync(process.execPath, [script, '--source', source, output]), /non-empty skill package target/);
      assert.equal(await readFile(join(output, 'existing.txt'), 'utf8'), 'preserve\n');
    } finally {
      await rm(source, {recursive: true, force: true});
      await rm(output, {recursive: true, force: true});
    }
  });
});
