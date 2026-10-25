import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test, { after, before } from 'node:test';

import { exportSmoke } from '../export-smoke.mjs';

const execFileAsync = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');
const EXPORTER = join(REPO_ROOT, 'benchmarks/cross-agent/export-smoke.mjs');
const SOURCE_TASKS = join(REPO_ROOT, 'source/jev-workflows/benchmarks/paired-v1/tasks.json');
const SOURCE_GRADER = join(REPO_ROOT, 'source/jev-workflows/benchmarks/paired-v1/grade.mjs');
const IDS = ['interval-repair', 'retry-repair', 'csv-parser'];

let tempRoot;
let outputA;
let outputB;
let source;

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function walk(root) {
  const files = [];
  async function visit(dir) {
    const entries = await readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await visit(path);
      else files.push(relative(root, path));
    }
  }
  await visit(root);
  return files;
}

async function tree(root) {
  const entries = {};
  for (const path of await walk(root)) entries[path] = await readFile(join(root, path));
  return entries;
}

async function parseToml(path) {
  const { stdout } = await execFileAsync('python3', [
    '-c',
    'import json,sys,tomllib; print(json.dumps(tomllib.load(open(sys.argv[1], "rb"))))',
    path,
  ]);
  return JSON.parse(stdout);
}

async function run(path, args, options = {}) {
  try {
    const result = await execFileAsync(path, args, options);
    return { status: 0, ...result };
  } catch (error) {
    return { status: error.code, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

const CORRECT = {
  'interval-repair': `export function mergeIntervals(xs) {
  const sorted = xs.filter(([a,b]) => a < b).map(([a,b]) => [a,b]).sort((a,b) => a[0]-b[0] || a[1]-b[1]);
  const result = [];
  for (const interval of sorted) {
    const last = result.at(-1);
    if (last && interval[0] <= last[1]) last[1] = Math.max(last[1], interval[1]);
    else result.push(interval);
  }
  return result;
}
`,
  'retry-repair': `export function retryDelay({status,attempt,retryAfter,nowMs}) {
  if (![429,502,503,504].includes(status) || attempt >= 3) return null;
  let delay = 1000 * 2 ** attempt;
  if (typeof retryAfter === 'string' && /^\\d+$/.test(retryAfter)) delay = Number(retryAfter) * 1000;
  else if (typeof retryAfter === 'string') {
    const parsed = Date.parse(retryAfter);
    if (Number.isFinite(parsed)) delay = parsed - nowMs;
  }
  return Math.max(0, Math.min(10000, delay));
}
`,
  'csv-parser': `export function parseCsv(text) {
  if (text === '') return [];
  const rows = []; let row = []; let field = ''; let quoted = false;
  for (let i=0; i<text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i+1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"' && field === '') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\\n' || (c === '\\r' && text[i+1] === '\\n')) {
      if (c === '\\r') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (quoted) throw new Error('unterminated quoted field');
  if (!text.endsWith('\\n')) { row.push(field); rows.push(row); }
  return rows;
}
`,
};

before(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), 'jev-cross-agent-export-'));
  outputA = join(tempRoot, 'a');
  outputB = join(tempRoot, 'b');
  source = JSON.parse(await readFile(SOURCE_TASKS, 'utf8'));
  await exportSmoke({ tasksPath: SOURCE_TASKS, graderPath: SOURCE_GRADER, outputPath: outputA });
  await exportSmoke({ tasksPath: SOURCE_TASKS, graderPath: SOURCE_GRADER, outputPath: outputB });
});

after(async () => {
  if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
});

test('export is byte-for-byte deterministic and records source provenance', async () => {
  const [a, b, exporterBytes, sourceTaskBytes, sourceGraderBytes] = await Promise.all([
    tree(outputA),
    tree(outputB),
    readFile(EXPORTER),
    readFile(SOURCE_TASKS),
    readFile(SOURCE_GRADER),
  ]);
  assert.deepEqual(Object.keys(a), Object.keys(b));
  for (const path of Object.keys(a)) assert.deepEqual(a[path], b[path], path);

  const manifest = JSON.parse(a['manifest.json'].toString());
  assert.equal(manifest.schemaVersion, 'cross-agent-smoke-v1');
  assert.equal(manifest.label, 'smoke-only');
  assert.equal(manifest.harborTaskSchema, '1.3');
  assert.deepEqual(manifest.exportedTaskIds, IDS);
  assert.deepEqual(manifest.unsupportedTasks, [
    { id: 'changed-route', reason: 'multi_turn_followup_not_flattened' },
  ]);
  assert.equal(manifest.source.exporterSha256, sha256(exporterBytes));
  assert.equal(manifest.source.tasksSha256, sha256(sourceTaskBytes));
  assert.equal(manifest.source.graderSha256, sha256(sourceGraderBytes));
  assert.equal(manifest.runtime.nodeImageDigest, 'sha256:dd9d21971ec4395903fa6143c2b9267d048ae01ca6d3ea96f16cb30df6187d94');
  assert.equal(manifest.runtime.nodeImage, `node:22.22.0-bookworm-slim@${manifest.runtime.nodeImageDigest}`);
  assert.ok(!Object.values(manifest).some((value) => String(value).includes(tempRoot)));
  for (const entry of manifest.files) {
    const bytes = a[entry.path];
    assert.ok(bytes, `manifest path missing: ${entry.path}`);
    assert.equal(entry.bytes, bytes.length, entry.path);
    assert.equal(entry.sha256, sha256(bytes), entry.path);
  }
});

test('each task uses schema 1.3 and a single-artifact separate verifier', async () => {
  for (const id of IDS) {
    const config = await parseToml(join(outputA, id, 'task.toml'));
    assert.equal(config.schema_version, '1.3');
    assert.deepEqual(config.artifacts, ['/logs/artifacts/solution.mjs']);
    assert.equal(config.task.name, `jev-workflows/smoke-${id}`);
    assert.equal(config.metadata.task_id, id);
    assert.equal(config.metadata.benchmark_label, 'smoke-only');
    assert.equal(config.metadata.multi_turn, false);
    assert.equal(config.verifier.environment_mode, 'separate');
    assert.equal(config.verifier.network_mode, 'no-network');
    assert.equal(config.verifier.environment.network_mode, 'no-network');
    assert.equal(config.agent.network_mode, 'no-network');
    assert.equal(config.environment.network_mode, 'no-network');
    assert.deepEqual(config.environment.mcp_servers, []);
    assert.equal(config.verifier.collect.length, 1);
    assert.match(config.verifier.collect[0].command, /cp \/app\/solution\.mjs \/logs\/artifacts\/solution\.mjs/);
    const agentDockerfile = await readFile(join(outputA, id, 'environment/Dockerfile'), 'utf8');
    const verifierDockerfile = await readFile(join(outputA, id, 'tests/Dockerfile'), 'utf8');
    for (const dockerfile of [agentDockerfile, verifierDockerfile]) {
      assert.match(dockerfile, /^FROM node:22\.22\.0-bookworm-slim@sha256:[0-9a-f]{64}$/m);
    }
  }
  await assert.rejects(stat(join(outputA, 'changed-route')), { code: 'ENOENT' });
});

test('agent build contexts contain initial fixtures but no grader or verifier files', async () => {
  const grader = await readFile(SOURCE_GRADER);
  for (const id of IDS) {
    const task = source.tasks.find((candidate) => candidate.id === id);
    const envRoot = join(outputA, id, 'environment');
    const paths = await walk(envRoot);
    assert.deepEqual(paths, [
      'Dockerfile',
      ...Object.keys(task.files).sort().map((name) => `workspace/${name}`),
    ]);
    assert.equal((await readFile(join(envRoot, 'Dockerfile'), 'utf8')).split('\n').filter(Boolean).at(-1), 'COPY workspace/ /app/');
    for (const path of paths) assert.notDeepEqual(await readFile(join(envRoot, path)), grader, `${id}/${path}`);
    assert.deepEqual(await readFile(join(outputA, id, 'tests/grade.mjs')), grader);
    await assert.rejects(stat(join(outputA, id, 'solution')), { code: 'ENOENT' });
  }
});

test('independent grader rejects initial fixtures and accepts known-good controls', async () => {
  for (const id of IDS) {
    const task = source.tasks.find((candidate) => candidate.id === id);
    const work = join(tempRoot, `grader-${id}`);
    await mkdir(work);
    for (const [name, contents] of Object.entries(task.files)) {
      await writeFile(join(work, name), contents);
    }
    const negative = await run(process.execPath, [SOURCE_GRADER, id], { cwd: work });
    assert.notEqual(negative.status, 0, `${id} initial fixture unexpectedly passed`);
    await writeFile(join(work, 'solution.mjs'), CORRECT[id]);
    const positive = await run(process.execPath, [SOURCE_GRADER, id], { cwd: work });
    assert.equal(positive.status, 0, `${id}: ${positive.stderr}`);
    assert.match(positive.stdout, /"passed":true/);
  }
});

test('verifier entrypoint grades only collected solution and writes reward zero on every failure', async () => {
  for (const id of IDS) {
    const task = source.tasks.find((candidate) => candidate.id === id);
    const root = join(tempRoot, `verifier-${id}`);
    const artifacts = join(root, 'artifacts');
    const logs = join(root, 'logs');
    await mkdir(artifacts, { recursive: true });
    await writeFile(join(artifacts, 'solution.mjs'), task.files['solution.mjs']);
    const script = join(outputA, id, 'tests/test.sh');
    const env = {
      ...process.env,
      HARBOR_ARTIFACTS_DIR: artifacts,
      HARBOR_VERIFIER_LOG_DIR: logs,
      HARBOR_TESTS_DIR: join(outputA, id, 'tests'),
    };
    const negative = await run(script, [], { env });
    assert.notEqual(negative.status, 0);
    assert.equal(await readFile(join(logs, 'reward.txt'), 'utf8'), '0\n');

    await writeFile(join(artifacts, 'solution.mjs'), CORRECT[id]);
    const positive = await run(script, [], { env });
    assert.equal(positive.status, 0, `${id}: ${positive.stderr}`);
    assert.equal(await readFile(join(logs, 'reward.txt'), 'utf8'), '1\n');

    await rm(join(artifacts, 'solution.mjs'));
    const missing = await run(script, [], { env });
    assert.notEqual(missing.status, 0);
    assert.equal(await readFile(join(logs, 'reward.txt'), 'utf8'), '0\n');
  }
});
