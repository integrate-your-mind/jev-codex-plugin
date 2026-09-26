#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '..', '..');
const DEFAULT_TASKS = join(REPO_ROOT, 'source/jev-workflows/benchmarks/paired-v1/tasks.json');
const DEFAULT_GRADER = join(REPO_ROOT, 'source/jev-workflows/benchmarks/paired-v1/grade.mjs');
const DEFAULT_OUTPUT = join(SCRIPT_DIR, 'smoke');
const EXPORTED_IDS = ['interval-repair', 'retry-repair', 'csv-parser'];
const NODE_IMAGE_TAG = 'node:22.22.0-bookworm-slim';
const NODE_IMAGE_DIGEST = 'sha256:dd9d21971ec4395903fa6143c2b9267d048ae01ca6d3ea96f16cb30df6187d94';
const NODE_IMAGE = `${NODE_IMAGE_TAG}@${NODE_IMAGE_DIGEST}`;

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function json(value) {
  return JSON.stringify(value);
}

function parseArgs(argv) {
  const result = {
    tasksPath: DEFAULT_TASKS,
    graderPath: DEFAULT_GRADER,
    outputPath: DEFAULT_OUTPUT,
    force: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--force') {
      result.force = true;
      continue;
    }
    const value = argv[++i];
    if (!value || !['--tasks', '--grader', '--output'].includes(arg)) {
      throw new Error(`Unknown or incomplete argument: ${arg}`);
    }
    if (arg === '--tasks') result.tasksPath = resolve(value);
    if (arg === '--grader') result.graderPath = resolve(value);
    if (arg === '--output') result.outputPath = resolve(value);
  }
  return result;
}

function validateFixturePath(name) {
  if (
    typeof name !== 'string'
    || name.length === 0
    || name.startsWith('/')
    || name.split(/[\\/]/u).includes('..')
    || name.includes('\\')
  ) {
    throw new Error(`Unsafe fixture path: ${json(name)}`);
  }
}

function validateSource(source) {
  if (!source || source.schemaVersion !== 'paired-codex-v1' || !Array.isArray(source.tasks)) {
    throw new Error('Expected paired-codex-v1 source tasks');
  }
  const byId = new Map();
  for (const task of source.tasks) {
    if (!task || typeof task.id !== 'string' || byId.has(task.id)) {
      throw new Error('Source task IDs must be unique strings');
    }
    byId.set(task.id, task);
  }
  for (const id of EXPORTED_IDS) {
    const task = byId.get(id);
    if (!task) throw new Error(`Missing source task: ${id}`);
    if (task.followupPrompt !== undefined) {
      throw new Error(`Refusing to flatten multi-turn source task: ${id}`);
    }
    if (typeof task.prompt !== 'string' || !task.files || typeof task.files !== 'object') {
      throw new Error(`Malformed source task: ${id}`);
    }
    for (const [name, contents] of Object.entries(task.files)) {
      validateFixturePath(name);
      if (typeof contents !== 'string') throw new Error(`Non-text fixture in ${id}: ${name}`);
    }
    if (
      task.verification?.command !== '$NODE'
      || task.verification?.args?.[0] !== '$TASKS_DIR/grade.mjs'
      || task.verification?.args?.[1] !== id
      || task.verification?.expectedExitCode !== 0
    ) {
      throw new Error(`Unsupported verification contract for ${id}`);
    }
  }
  const changedRoute = byId.get('changed-route');
  if (!changedRoute?.followupPrompt) {
    throw new Error('Expected changed-route to remain an explicit multi-turn task');
  }
  return { byId, changedRoute };
}

function taskToml(id, tasksHash, graderHash) {
  return `schema_version = "1.3"
artifacts = ["/logs/artifacts/solution.mjs"]

[task]
name = "jev-workflows/smoke-${id}"
description = "Portable single-turn coding-agent wiring smoke; not a quality benchmark."
authors = []
keywords = ["smoke-only", "javascript", "coding-agent", "harbor", "pier"]

[metadata]
task_id = ${json(id)}
benchmark_label = "smoke-only"
source_schema = "paired-codex-v1"
source_tasks_sha256 = ${json(tasksHash)}
source_grader_sha256 = ${json(graderHash)}
deep_swe_commit = "0b9fabbb63b9104d678fe965e1632f2dd9eaa2ea"
pier_commit = "4f3441fb3e7c21ce8a4ed0b6155a8d9a176a645a"
multi_turn = false

[verifier]
network_mode = "no-network"
environment_mode = "separate"
timeout_sec = 60.0

[verifier.environment]
build_timeout_sec = 300.0
os = "linux"
cpus = 1
memory_mb = 1024
storage_mb = 2048
gpus = 0
network_mode = "no-network"

[[verifier.collect]]
command = "set -eu; test -f /app/solution.mjs; mkdir -p /logs/artifacts; cp /app/solution.mjs /logs/artifacts/solution.mjs"
timeout_sec = 30.0

[agent]
network_mode = "no-network"
timeout_sec = 180.0

[environment]
build_timeout_sec = 300.0
os = "linux"
workdir = "/app"
cpus = 1
memory_mb = 1024
storage_mb = 2048
gpus = 0
network_mode = "no-network"
mcp_servers = []
`;
}

function agentDockerfile() {
  return `FROM ${NODE_IMAGE}\nWORKDIR /app\nCOPY workspace/ /app/\n`;
}

function verifierDockerfile() {
  return `FROM ${NODE_IMAGE}\nWORKDIR /verify\nCOPY test.sh /tests/test.sh\nCOPY grade.mjs /tests/grade.mjs\nRUN chmod 0555 /tests/test.sh && chmod 0444 /tests/grade.mjs\n`;
}

function testScript(id) {
  return `#!/bin/sh
set -u

logs_dir="\${HARBOR_VERIFIER_LOG_DIR:-/logs/verifier}"
artifacts_dir="\${HARBOR_ARTIFACTS_DIR:-/logs/artifacts}"
tests_dir="\${HARBOR_TESTS_DIR:-/tests}"
mkdir -p "$logs_dir" || exit 1
printf '0\\n' > "$logs_dir/reward.txt" || exit 1

work_dir="$(mktemp -d "\${TMPDIR:-/tmp}/jev-smoke-verifier.XXXXXX")" || exit 1
cleanup() { rm -rf "$work_dir"; }
trap cleanup EXIT HUP INT TERM

if [ ! -f "$artifacts_dir/solution.mjs" ]; then
  printf '%s\\n' 'missing collected solution.mjs' > "$logs_dir/grader.stderr.log"
  exit 1
fi
cp "$artifacts_dir/solution.mjs" "$work_dir/solution.mjs" || exit 1

if (cd "$work_dir" && node "$tests_dir/grade.mjs" ${json(id)}) \
  > "$logs_dir/grader.stdout.log" 2> "$logs_dir/grader.stderr.log"; then
  printf '1\\n' > "$logs_dir/reward.txt"
  exit 0
fi
exit 1
`;
}

async function write(path, contents, mode = 0o644) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents, { mode });
}

async function inventory(root) {
  const { readdir } = await import('node:fs/promises');
  const found = [];
  async function visit(dir) {
    const entries = await readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) {
        const bytes = await readFile(path);
        found.push({ path: relative(root, path).split(sep).join('/'), bytes: bytes.length, sha256: sha256(bytes) });
      } else {
        throw new Error(`Unexpected generated filesystem entry: ${path}`);
      }
    }
  }
  await visit(root);
  return found;
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

export async function exportSmoke(options = {}) {
  const tasksPath = resolve(options.tasksPath ?? DEFAULT_TASKS);
  const graderPath = resolve(options.graderPath ?? DEFAULT_GRADER);
  const outputPath = resolve(options.outputPath ?? DEFAULT_OUTPUT);
  const force = options.force ?? false;
  const [tasksBytes, graderBytes, exporterBytes] = await Promise.all([
    readFile(tasksPath),
    readFile(graderPath),
    readFile(fileURLToPath(import.meta.url)),
  ]);
  const source = JSON.parse(tasksBytes.toString('utf8'));
  const { byId, changedRoute } = validateSource(source);
  const tasksHash = sha256(tasksBytes);
  const graderHash = sha256(graderBytes);

  if (await exists(outputPath)) {
    if (!force) throw new Error(`Output already exists (pass --force to replace generated smoke output): ${outputPath}`);
    const existingManifest = JSON.parse(await readFile(join(outputPath, 'manifest.json'), 'utf8'));
    if (existingManifest.schemaVersion !== 'cross-agent-smoke-v1') {
      throw new Error(`Refusing to replace unrecognized output: ${outputPath}`);
    }
  }

  const staging = `${outputPath}.tmp-${process.pid}`;
  if (await exists(staging)) throw new Error(`Staging path already exists: ${staging}`);
  await mkdir(staging, { recursive: true });
  try {
    for (const id of EXPORTED_IDS) {
      const task = byId.get(id);
      const taskRoot = join(staging, id);
      await write(join(taskRoot, 'task.toml'), taskToml(id, tasksHash, graderHash));
      await write(join(taskRoot, 'instruction.md'), `${task.prompt.trimEnd()}\n`);
      await write(join(taskRoot, 'environment/Dockerfile'), agentDockerfile());
      for (const [name, contents] of Object.entries(task.files).sort(([a], [b]) => a.localeCompare(b))) {
        await write(join(taskRoot, 'environment/workspace', name), contents);
      }
      await write(join(taskRoot, 'tests/Dockerfile'), verifierDockerfile());
      await write(join(taskRoot, 'tests/grade.mjs'), graderBytes);
      await write(join(taskRoot, 'tests/test.sh'), testScript(id), 0o755);
    }

    const files = await inventory(staging);
    const manifest = {
      schemaVersion: 'cross-agent-smoke-v1',
      label: 'smoke-only',
      harborTaskSchema: '1.3',
      exportedTaskIds: EXPORTED_IDS,
      unsupportedTasks: [{
        id: changedRoute.id,
        reason: 'multi_turn_followup_not_flattened',
      }],
      source: {
        exporter: 'benchmarks/cross-agent/export-smoke.mjs',
        exporterSha256: sha256(exporterBytes),
        tasks: 'source/jev-workflows/benchmarks/paired-v1/tasks.json',
        tasksSha256: tasksHash,
        grader: 'source/jev-workflows/benchmarks/paired-v1/grade.mjs',
        graderSha256: graderHash,
      },
      upstream: {
        deepSWECommit: '0b9fabbb63b9104d678fe965e1632f2dd9eaa2ea',
        pierCommit: '4f3441fb3e7c21ce8a4ed0b6155a8d9a176a645a',
      },
      runtime: {
        nodeImage: NODE_IMAGE,
        nodeImageTag: NODE_IMAGE_TAG,
        nodeImageDigest: NODE_IMAGE_DIGEST,
      },
      files,
    };
    await write(join(staging, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    if (await exists(outputPath)) await rm(outputPath, { recursive: true });
    await mkdir(dirname(outputPath), { recursive: true });
    await rename(staging, outputPath);
    return manifest;
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const manifest = await exportSmoke(options);
  process.stdout.write(`${JSON.stringify({
    status: 'exported',
    output: options.outputPath,
    tasks: manifest.exportedTaskIds,
    unsupported: manifest.unsupportedTasks,
  })}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
