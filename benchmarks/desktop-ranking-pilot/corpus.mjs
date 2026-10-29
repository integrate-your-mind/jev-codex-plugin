import {createHash} from 'node:crypto';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {dirname} from 'node:path';
import {hash} from './identity.mjs';

const SHA = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const repo = value => String(value).replace(/^https:\/\/github.com\//, '').replace(/\.git$/, '').replace(/\/$/, '').toLowerCase();
const issueIdentity = value => String(value).replace(/\/$/, '').toLowerCase();
const assert = (condition, message) => { if (!condition) throw new Error(message); };

export async function acquirePinnedCatalog({url, revision, expectedHash, destination}) {
  const source = new URL(url);
  assert(source.protocol === 'https:' && ['raw.githubusercontent.com', 'huggingface.co'].includes(source.hostname), 'Use an official pinned public catalog URL');
  assert(SHA.test(revision) && source.pathname.split('/').includes(revision), 'Catalog URL must contain its full immutable revision');
  assert(SHA256.test(expectedHash), 'Freeze the catalog SHA-256 before acquisition');
  const response = await fetch(source, {redirect: 'follow', signal: AbortSignal.timeout(30_000)});
  assert(response.ok, `Catalog retrieval failed with HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const actualHash = createHash('sha256').update(bytes).digest('hex');
  assert(actualHash === expectedHash, 'Catalog content does not match the frozen identity');
  await mkdir(dirname(destination), {recursive: true});
  try { await writeFile(destination, bytes, {flag: 'wx'}); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    assert(createHash('sha256').update(await readFile(destination)).digest('hex') === expectedHash, 'Existing catalog has another identity');
  }
  return {url: source.href, revision, sha256: actualHash, bytes: bytes.length};
}

export function checkCorpus(catalog, reservations) {
  assert(catalog?.schemaVersion === 'desktop-pilot-corpus-v1' && SHA.test(catalog.source?.revision)
    && SHA256.test(catalog.source?.artifactHash), 'Pin corpus source revision and artifact');
  assert(Array.isArray(catalog.tasks) && catalog.tasks.length === 6, 'Choose exactly six real bugs');
  assert(Array.isArray(reservations?.tasks) && SHA256.test(reservations.sourceHash), 'Read the preserved old reservations');
  assert(new Set(catalog.tasks.map(task => task.id)).size === 6, 'Candidate task IDs must be unique');
  assert(new Set(catalog.tasks.map(task => repo(task.repository))).size >= 2, 'Use at least two repositories');
  assert(new Set(catalog.tasks.map(task => task.taskType)).size >= 2, 'Use at least two task types');
  const identities = new Set();
  for (const task of catalog.tasks) {
    assert(typeof task.id === 'string' && task.id.length > 0 && SHA.test(task.baseRevision), 'Pin each real task ID and broken base');
    assert(task.classification?.kind === 'bug' && typeof task.classification.evidence === 'string'
      && task.classification.evidence.length > 0 && task.classification.reviewed === true, 'Feature requests and unreviewed classifications are ineligible');
    assert(typeof task.taskType === 'string' && task.taskType.length > 0 && typeof task.repository === 'string'
      && task.repository.split('/').length === 2, 'Keep repository and task type provenance');
    assert(Array.isArray(task.issues) && task.issues.length > 0
      && task.issues.every(issue => issue.startsWith(`https://github.com/${task.repository}/issues/`)), 'Keep public issue provenance');
    assert(SHA256.test(task.problemStatementHash) && SHA256.test(task.referencePatchHash) && SHA256.test(task.testPatchHash), 'Retain task metadata hashes without exposing grader code');
    for (const identity of [`base:${task.baseRevision}`, `repair:${task.referencePatchHash}`, ...task.issues.map(issue => `issue:${issueIdentity(issue)}`)]) {
      const key = `${repo(task.repository)}:${identity}`;
      assert(!identities.has(key), `Duplicate source bug in selected pool: ${task.id}`);
      identities.add(key);
    }
    const collision = reservations.tasks.find(old => old.id === task.id || (repo(old.repository) === repo(task.repository)
      && (old.baseRevision === task.baseRevision || old.issues?.some(issue => task.issues.map(issueIdentity).includes(issueIdentity(issue))))));
    assert(!collision, `Old reservation overlaps ${task.id} by task, repository/base, or issue`);
  }
  return {eligibleMetadata: true, tasks: catalog.tasks.length, repositories: new Set(catalog.tasks.map(task => repo(task.repository))).size,
    taskTypes: new Set(catalog.tasks.map(task => task.taskType)).size, corpusHash: hash(catalog), reservationsHash: hash(reservations),
    codingReady: false, remainingGates: ['native-baseline-isolation', 'public-broken-base-failure-records', 'four-healthy-grader-controls-per-task', 'frozen-native-runtime-and-packets']};
}
