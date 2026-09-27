import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {once} from 'node:events';
import {
  appendFile,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  unlink,
  writeFile,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, isAbsolute, join, relative, resolve, sep} from 'node:path';
import {createInterface} from 'node:readline';
import {isDeepStrictEqual} from 'node:util';
import {fileURLToPath} from 'node:url';

const casesDir = dirname(fileURLToPath(import.meta.url));
const sandboxProfile = '(version 1) (allow default) (deny network*)';

export function resolveInside(root, path) {
  if (typeof path !== 'string' || path.length === 0 || isAbsolute(path)) {
    throw new Error(`fixture path must be a non-empty relative path: ${String(path)}`);
  }
  const target = resolve(root, path);
  if (target !== root && !target.startsWith(`${root}${sep}`)) {
    throw new Error(`fixture path escapes owned workspace: ${path}`);
  }
  return target;
}

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function exists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function listTree(root, current = root, result = []) {
  if (!(await exists(current))) return result;
  for (const entry of await readdir(current, {withFileTypes: true})) {
    const absolute = join(current, entry.name);
    const rel = relative(root, absolute);
    if (entry.isSymbolicLink()) throw new Error(`symlinks are forbidden in fixtures: ${rel}`);
    if (entry.isDirectory()) await listTree(root, absolute, result);
    else if (entry.isFile()) result.push(rel);
    else throw new Error(`unsupported fixture entry: ${rel}`);
  }
  return result.sort();
}

async function snapshot(root) {
  const result = {};
  for (const path of await listTree(root)) result[path] = digest(await readFile(resolveInside(root, path)));
  return result;
}

async function writeOwned(root, path, value, options = {}) {
  const target = resolveInside(root, path);
  await mkdir(dirname(target), {recursive: true});
  await writeFile(target, value, options);
}

function restrictedEnvironment(root) {
  return {
    HOME: join(root, '.home'),
    LANG: 'C',
    PATH: '/usr/bin:/bin',
    TMPDIR: join(root, '.tmp'),
  };
}

function sandboxedNode(root, nodeArgs, {write = false} = {}) {
  if (process.platform !== 'darwin') throw new Error('authored action sandbox requires macOS sandbox-exec');
  if (!process.allowedNodeEnvironmentFlags.has('--permission')) throw new Error('authored action sandbox requires Node permission support');
  const permissions = ['--permission', `--allow-fs-read=${root}`];
  if (write) permissions.push(`--allow-fs-write=${root}`);
  return {
    command: '/usr/bin/sandbox-exec',
    args: ['-p', sandboxProfile, process.execPath, ...permissions, ...nodeArgs],
  };
}

async function runSandboxedTest(root, testPath) {
  const absoluteTest = resolveInside(root, testPath);
  const relativeTest = relative(root, absoluteTest);
  const invocation = sandboxedNode(root, [relativeTest]);
  const child = spawn(invocation.command, invocation.args, {
    cwd: root,
    env: restrictedEnvironment(root),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.stdout.resume();
  const timeout = setTimeout(() => child.kill('SIGKILL'), 5_000);
  const [code, signal] = await once(child, 'close');
  clearTimeout(timeout);
  return {exitCode: typeof code === 'number' ? code : 1, signal: signal ?? null, stderr};
}

function capabilities(root) {
  const resolvePath = path => resolveInside(root, path);
  return Object.freeze({
    appendText: async (path, value) => {
      const target = resolvePath(path);
      await mkdir(dirname(target), {recursive: true});
      await appendFile(target, value, 'utf8');
    },
    exists: async path => exists(resolvePath(path)),
    listFiles: async path => {
      const base = resolvePath(path);
      return (await listTree(base)).map(child => join(path, child).split(sep).join('/'));
    },
    readJson: async path => JSON.parse(await readFile(resolvePath(path), 'utf8')),
    readText: async path => readFile(resolvePath(path), 'utf8'),
    removeFile: async path => unlink(resolvePath(path)),
    sha256: async path => digest(await readFile(resolvePath(path))),
    writeJson: async (path, value) => writeOwned(root, path, `${JSON.stringify(value, null, 2)}\n`),
    writeText: async (path, value) => writeOwned(root, path, value),
    runNodeTest: async (testPath, receiptPath) => {
      const result = await runSandboxedTest(root, testPath);
      const receipt = {command: `node ${testPath}`, exitCode: result.exitCode, passed: result.exitCode === 0};
      await writeOwned(root, receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
      return receipt;
    },
  });
}

export async function loadCases() {
  const [inputs, oracle] = await Promise.all([
    readFile(join(casesDir, 'inputs.json'), 'utf8').then(JSON.parse),
    readFile(join(casesDir, 'oracle.json'), 'utf8').then(JSON.parse),
  ]);
  return {inputs, oracle};
}

export async function prepareCase(caseId) {
  const {inputs, oracle} = await loadCases();
  const input = inputs.cases.find(item => item.id === caseId);
  const expected = oracle.cases[caseId];
  if (!input || !expected) throw new Error(`unknown authored case: ${caseId}`);
  const fixtureDir = join(casesDir, 'fixtures', caseId);
  const root = await realpath(await mkdtemp(join(tmpdir(), `jev-development-${caseId}-`)));
  await mkdir(join(root, '.home'), {recursive: true});
  await mkdir(join(root, '.tmp'), {recursive: true});
  const seed = join(fixtureDir, 'workspace');
  if (await exists(seed)) await cp(seed, root, {recursive: true});
  const journal = join(fixtureDir, 'journal.json');
  if (await exists(journal)) await cp(journal, join(root, 'journal.json'));
  await mkdir(join(root, '.harness'), {recursive: true});
  await cp(join(casesDir, 'action-worker.mjs'), join(root, '.harness', 'action-worker.mjs'));
  await cp(join(fixtureDir, 'source.mjs'), join(root, '.harness', 'source.mjs'));
  await writeFile(join(root, '.harness', 'input.json'), `${JSON.stringify(input, null, 2)}\n`);
  return {caseId, expected, fixtureDir, input, root, before: await snapshot(root)};
}

async function runActionWorker(prepared, actionId) {
  const {root} = prepared;
  const workerPath = join(root, '.harness', 'action-worker.mjs');
  const invocation = sandboxedNode(root, [workerPath, actionId], {write: true});
  const child = spawn(invocation.command, invocation.args, {
    cwd: root,
    env: restrictedEnvironment(root),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const caps = capabilities(root);
  const messages = [];
  const requests = [];
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { stderr += chunk; });
  const lines = createInterface({input: child.stdout, crlfDelay: Infinity});
  lines.on('line', line => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      messages.push({kind: 'protocol_error', error: `non-JSON worker output: ${line}`});
      return;
    }
    messages.push(message);
    if (message.kind !== 'capability_request') return;
    requests.push((async () => {
      const capability = caps[message.method];
      if (typeof capability !== 'function' || !Array.isArray(message.args)) {
        child.stdin.write(`${JSON.stringify({id: message.id, ok: false, error: 'unknown capability request'})}\n`);
        return;
      }
      try {
        const value = await capability(...message.args);
        child.stdin.write(`${JSON.stringify({id: message.id, ok: true, value})}\n`);
      } catch (error) {
        child.stdin.write(`${JSON.stringify({id: message.id, ok: false, error: error instanceof Error ? error.message : String(error)})}\n`);
      }
    })());
  });
  const timeout = setTimeout(() => child.kill('SIGKILL'), 10_000);
  const [code, signal] = await once(child, 'close');
  clearTimeout(timeout);
  await Promise.all(requests);
  const protocolError = messages.find(message => message.kind === 'protocol_error');
  if (protocolError) throw new Error(protocolError.error);
  const actionError = messages.find(message => message.kind === 'action_error');
  if (actionError) throw new Error(`sandboxed action failed: ${actionError.error}`);
  if (code !== 0) throw new Error(`sandboxed action exited ${code ?? signal}: ${stderr.trim()}`);
  const terminal = messages.find(message => message.kind === (actionId === '--list' ? 'action_list' : 'action_done'));
  if (!terminal) throw new Error(`sandboxed action produced no terminal message: ${stderr.trim()}`);
  return terminal;
}

export async function inspectActionIds(prepared) {
  const result = await runActionWorker(prepared, '--list');
  const after = await snapshot(prepared.root);
  if (!isDeepStrictEqual(after, prepared.before)) throw new Error(`action module mutated workspace during load: ${prepared.caseId}`);
  return result.actionIds;
}

export async function executeCaseAction(prepared, actionId) {
  const {input, root} = prepared;
  const catalog = Array.isArray(input.candidates) ? input.candidates : null;
  if (catalog) {
    const candidate = catalog.find(item => item.id === actionId);
    if (!candidate) return {status: 'rejected', reason: 'foreign_candidate', after: await snapshot(root)};
    if (candidate.available === false) return {status: 'rejected', reason: 'unavailable_candidate', after: await snapshot(root)};
  }
  await runActionWorker(prepared, actionId);
  return {status: 'completed', after: await snapshot(root)};
}

function violation(code, path, message, details = {}) {
  return {code, path, message, ...details};
}

async function expectedFileViolation(root, path, expected) {
  const target = resolveInside(root, path);
  if (!(await exists(target))) return violation('missing_expected_file', path, `missing expected file ${path}`);
  const actualText = await readFile(target, 'utf8');
  if (typeof expected === 'string') {
    if (actualText !== expected) return violation('file_content_mismatch', path, `text differs for ${path}`);
  } else {
    let actual;
    try {
      actual = JSON.parse(actualText);
    } catch {
      return violation('invalid_json', path, `invalid JSON in ${path}`);
    }
    if (!isDeepStrictEqual(actual, expected)) return violation('file_content_mismatch', path, `JSON differs for ${path}`);
  }
  return null;
}

export async function verifyPostconditions(prepared) {
  const {before, expected, root} = prepared;
  const spec = expected.postconditions;
  const violations = [];
  for (const [path, value] of Object.entries(spec.expectedFiles ?? {})) {
    const found = await expectedFileViolation(root, path, value);
    if (found) violations.push(found);
  }
  for (const path of spec.absentPaths ?? []) {
    if (await exists(resolveInside(root, path))) violations.push(violation('expected_absent', path, `expected absent path exists: ${path}`));
  }
  for (const path of spec.unchangedPaths ?? []) {
    const target = resolveInside(root, path);
    if (!(await exists(target))) violations.push(violation('preserved_path_missing', path, `preserved path missing: ${path}`));
    else if (before[path] === undefined || before[path] !== digest(await readFile(target))) violations.push(violation('preserved_path_changed', path, `preserved path changed: ${path}`));
  }
  for (const {path, count} of spec.lineCounts ?? []) {
    const target = resolveInside(root, path);
    const lines = (await exists(target)) ? (await readFile(target, 'utf8')).split('\n').filter(Boolean) : [];
    if (lines.length !== count) violations.push(violation(
      'line_count_mismatch',
      path,
      `line count for ${path} is ${lines.length}, expected ${count}`,
      {actualCount: lines.length, expectedCount: count},
    ));
  }
  for (const {under, text} of spec.forbiddenContent ?? []) {
    const base = resolveInside(root, under);
    if (!(await exists(base))) continue;
    for (const child of await listTree(base)) {
      if ((await readFile(join(base, child), 'utf8')).includes(text)) {
        const path = join(under, child).split(sep).join('/');
        violations.push(violation('forbidden_content', path, `forbidden content found in ${path}`));
      }
    }
  }
  const journalPath = resolveInside(root, 'journal.json');
  if (await exists(journalPath)) {
    let journal;
    try {
      journal = JSON.parse(await readFile(journalPath, 'utf8'));
    } catch {
      journal = null;
    }
    if (journal?.phase === 'acknowledged') {
      const acknowledgementReceiptIds = [
        ...(typeof journal.acknowledgement?.evidenceReceiptId === 'string' ? [journal.acknowledgement.evidenceReceiptId] : []),
        ...(Array.isArray(journal.acknowledgement?.evidenceReceiptIds) ? journal.acknowledgement.evidenceReceiptIds : []),
      ];
      const availableReceiptIds = new Set();
      const evidenceRoot = resolveInside(root, 'evidence');
      if (await exists(evidenceRoot)) {
        for (const evidencePath of await listTree(evidenceRoot)) {
          if (!evidencePath.endsWith('.json')) continue;
          try {
            const receipt = JSON.parse(await readFile(join(evidenceRoot, evidencePath), 'utf8'));
            if (typeof receipt.receiptId === 'string') availableReceiptIds.add(receipt.receiptId);
          } catch {
            // Invalid evidence JSON is handled by exact expected-file checks when relevant.
          }
        }
      }
      const acknowledgementSupported = journal.acknowledgement?.status === 'sent'
        && journal.action?.status === 'applied'
        && acknowledgementReceiptIds.length > 0
        && acknowledgementReceiptIds.every(receiptId => availableReceiptIds.has(receiptId));
      if (!acknowledgementSupported) {
        violations.push(violation('unsupported_acknowledgement', 'journal.json', 'acknowledgement lacks an applied action and resolvable evidence receipt'));
      }
    }
  }
  const allowedChanges = new Set([
    ...Object.keys(spec.expectedFiles ?? {}),
    ...(spec.lineCounts ?? []).map(item => item.path),
  ]);
  const after = await snapshot(root);
  for (const path of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (before[path] !== after[path] && !allowedChanges.has(path)) {
      violations.push(violation('unexpected_workspace_change', path, `unexpected workspace change: ${path}`));
    }
  }
  return {pass: violations.length === 0, violations};
}

export async function cleanupCase(prepared) {
  await rm(prepared.root, {recursive: true, force: true});
}

export {casesDir};
