import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import test, {after, before} from 'node:test';

import {exportTranscript} from './export.mjs';
import {hash} from './freeze.mjs';

const execFileAsync = promisify(execFile);
const dir = dirname(fileURLToPath(import.meta.url));
const repo = join(dir, '..', '..', '..');
const source = join(repo, 'source/jev-workflows');
const node22 = process.env.NODE22_BIN ?? process.execPath;
const runner = join(dir, 'run.mjs');
const exporter = join(dir, 'export.mjs');
const sourcePaths = [
  'package.json', 'src/service.ts', 'src/batch.ts', 'src/provider.ts', 'src/contracts.ts',
  'src/redact.ts', 'src/store.ts', 'src/policy.ts', 'src/credential.ts',
];

let temp;
let transcriptPath;
let exportPath;
let transcriptBytes;
let records;
let exported;

async function invoke(script, args) {
  try {
    const result = await execFileAsync(node22, [script, ...args], {maxBuffer: 8 * 1024 * 1024});
    return {exitCode: 0, ...result};
  } catch (error) {
    return {exitCode: typeof error.code === 'number' ? error.code : 255, stdout: error.stdout ?? '', stderr: error.stderr ?? ''};
  }
}

async function writeTranscript(path, changed) {
  await writeFile(path, `${changed.map(record => JSON.stringify(record)).join('\n')}\n`, {mode: 0o600, flag: 'wx'});
}

function allKeys(value, found = new Set()) {
  if (!value || typeof value !== 'object') return found;
  for (const [key, child] of Object.entries(value)) {
    found.add(key);
    allKeys(child, found);
  }
  return found;
}

before(async () => {
  const version = await execFileAsync(node22, ['--version']);
  assert.equal(version.stdout.trim(), 'v22.23.2', 'Set NODE22_BIN to Node v22.23.2');
  temp = await mkdtemp(join(process.env.TMPDIR ?? dir, 'jev-batch-export-test-'));
  transcriptPath = join(temp, 'private.jsonl');
  exportPath = join(temp, 'sanitized.json');
  const run = await invoke(runner, ['--source', source, '--out', transcriptPath]);
  assert.equal(run.exitCode, 0, run.stderr);
  transcriptBytes = await readFile(transcriptPath);
  records = transcriptBytes.toString('utf8').trim().split('\n').map(JSON.parse);
  const result = await invoke(exporter, ['--source', source, '--input', transcriptPath, '--output', exportPath]);
  assert.equal(result.exitCode, 0, result.stderr);
  exported = JSON.parse(await readFile(exportPath, 'utf8'));
});

after(async () => {
  if (temp) await rm(temp, {recursive: true, force: true});
});

test('export independently re-grades frozen provenance and emits numeric allowlisted results', async () => {
  assert.equal(exported.schemaVersion, 'jev-batch-component-sanitized-export-v1');
  assert.equal(exported.provenance.verified, true);
  assert.equal(exported.provenance.storedSummaryVerified, true);
  assert.equal(exported.provenance.exporterSha256, hash(await readFile(exporter)));
  assert.equal(exported.privateTranscript.sha256, hash(transcriptBytes));
  assert.equal(exported.privateTranscript.recordCount, records.length);
  assert.equal(exported.privateTranscript.receiptsPersisted, 32);
  assert.equal(exported.privateTranscript.providerResponseIdsPresent, 32);
  assert.equal(exported.privateTranscript.localReceiptIdsPresent, 32);
  assert.equal(exported.run.attempts.length, 16);
  assert.equal(exported.summary.byArm.serial.plannedProviderRequests, 24);
  assert.equal(exported.summary.byArm.batch.plannedProviderRequests, 8);
  assert.ok(exported.run.attempts.every(attempt => attempt.providerCostUsd === null));
  assert.ok(exported.run.attempts.every(attempt => attempt.actualActionExecuted === null && attempt.actualHarmfulAction === null));
  assert.equal(exported.summary.providerCostUsd, null);
  assert.equal(exported.summary.actualHarmfulActions, null);
  assert.equal(exported.summary.independentlyVerifiedTaskActionBenefits, null);
  assert.equal((await stat(exportPath)).mode & 0o777, 0o600);
});

test('sanitized output omits private IDs, fingerprints, payloads, errors, receipts, and absolute paths', () => {
  const outputText = JSON.stringify(exported);
  const privateValues = records.flatMap(record => {
    if (record.kind === 'private_provider_response_received') return [record.providerRequestId];
    if (record.kind === 'private_receipt_persisted') return [record.localReceiptId, record.providerRequestId, record.receipt?.credentialFingerprint];
    return [];
  }).filter(value => typeof value === 'string' && value.length > 0);
  for (const value of new Set(privateValues)) assert.equal(outputText.includes(value), false, `private value leaked: ${value.slice(0, 8)}`);
  for (const absolutePath of [temp, transcriptPath, exportPath, source]) assert.equal(outputText.includes(absolutePath), false);
  const forbiddenKeys = ['providerRequestId', 'localReceiptId', 'receiptId', 'credentialFingerprint', 'payload', 'rawResponse', 'rawResponseError', 'receipt', 'error', 'harnessError', 'privatePersistenceFailures'];
  const keys = allKeys(exported);
  for (const key of forbiddenKeys) assert.equal(keys.has(key), false, `forbidden output key: ${key}`);
});

test('export rejects transcript freeze, summary, record-kind, and private reconciliation tampering', async () => {
  const cases = [
    ['freeze', changed => { changed[0].freezeSha256 = '0'.repeat(64); }, /freeze mismatch/],
    ['summary', changed => { changed.find(record => record.kind === 'summary').byArm.serial.providerRequests += 1; }, /stored summary differs/],
    ['record-kind', changed => { changed.splice(-1, 0, {kind: 'unexpected_private_record'}); }, /unsupported record kind/],
    ['provider-id', changed => { changed.find(record => record.kind === 'private_provider_response_received').providerRequestId += '_tampered'; }, /receipt\/provider response ID mismatch/],
  ];
  for (const [name, mutate, pattern] of cases) {
    const changed = structuredClone(records);
    mutate(changed);
    const path = join(temp, `${name}.jsonl`);
    await writeTranscript(path, changed);
    await assert.rejects(exportTranscript({input: path, source, write: false}), pattern);
  }
});

test('export rejects source provenance drift and refuses to overwrite output', async () => {
  const sourceCopy = join(temp, 'source-copy');
  for (const relativePath of sourcePaths) {
    const destination = join(sourceCopy, relativePath);
    await mkdir(dirname(destination), {recursive: true});
    await copyFile(join(source, relativePath), destination);
  }
  await writeFile(join(sourceCopy, 'src/service.ts'), '\n// synthetic provenance drift\n', {flag: 'a'});
  await assert.rejects(exportTranscript({input: transcriptPath, source: sourceCopy, write: false}), /service source changed/);

  const before = hash(await readFile(exportPath));
  const duplicate = await invoke(exporter, ['--source', source, '--input', transcriptPath, '--output', exportPath]);
  assert.notEqual(duplicate.exitCode, 0);
  assert.equal(hash(await readFile(exportPath)), before);
});
