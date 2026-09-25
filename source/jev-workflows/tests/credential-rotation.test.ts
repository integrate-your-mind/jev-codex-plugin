import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {chmodSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createService} from '../src/service.js';
import {readCredentialFile} from '../src/credential.js';
import type {Receipt, Store} from '../src/store.js';

const FILE_KEY_ONE = 'one.' + 'aB7_cD8-eF9.'.repeat(9);
const FILE_KEY_TWO = 'two.' + 'gH2_iJ3-kL4.'.repeat(9);
const FILE_KEY_SECRET = 'secret.' + 'mN5_oP6-qR7.'.repeat(9);

function fixture(t: {after(fn: () => void): void}) {
  const root = mkdtempSync(join(tmpdir(), 'jev-credential-test-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const path = join(root, 'typesafe.env');
  const write = (key: string) => {
    const next = join(root, 'next.env');
    writeFileSync(next, `export TYPESAFE_API_KEY='${key}'\n`, {mode: 0o600});
    renameSync(next, path);
  };
  return {root, path, write};
}

function failure(mode: 'preview' | 'evaluate' = 'evaluate') {
  return {task: 'run test', command: 'node test.js', exitCode: 1,
    output: 'AssertionError: expected 1 to equal 2',
    evidence: [{id: 'log:1', text: 'AssertionError: expected 1 to equal 2'}], mode};
}

function validResponse(): Response {
  return new Response(JSON.stringify({model: 'jev-1.13.0', answers: {
    category: {type: 'choice', choice: 'assertion_failure', confidence: 0.95, probabilities: {
      compile_error: 0.01, assertion_failure: 0.95, missing_dependency: 0.01,
      unavailable_service: 0.01, permission_failure: 0.01, insufficient_evidence: 0.01,
    }}, reached_assertion: {type: 'noul', noul: 0.9}, missing_context: {type: 'noul', noul: 0.1},
  }, usage: {input_tokens: 20, output_tokens: 12}}));
}

test('credential file accepts one private literal assignment and rejects unsafe sources', t => {
  const {root, path, write} = fixture(t);
  write(FILE_KEY_ONE);
  assert.equal(readCredentialFile(path), FILE_KEY_ONE);
  chmodSync(path, 0o644);
  assert.equal(readCredentialFile(path), null);
  chmodSync(path, 0o600);
  writeFileSync(path, `export TYPESAFE_API_KEY='${FILE_KEY_ONE}'\nexport OTHER='x'\n`);
  assert.equal(readCredentialFile(path), null);
  writeFileSync(path, "export TYPESAFE_API_KEY='$(unsafe)'\n");
  assert.equal(readCredentialFile(path), null);
  write('aB7_cD8-eF9.'.repeat(6).slice(0, 79));
  assert.equal(readCredentialFile(path), null);
  write('aB7_cD8-eF9.'.repeat(7).slice(0, 80));
  assert.notEqual(readCredentialFile(path), null);
  write('a'.repeat(80));
  assert.equal(readCredentialFile(path), null);
  write(FILE_KEY_TWO);
  const link = join(root, 'link.env');
  symlinkSync(path, link);
  assert.equal(readCredentialFile(link), null);
  assert.equal(readCredentialFile('relative.env'), null);
  assert.equal(readCredentialFile(join(root, 'missing.env')), null);
});

test('invalid configured source fails closed without the captured environment key or secret leakage', async t => {
  const {path, write} = fixture(t);
  write(FILE_KEY_SECRET);
  let calls = 0;
  const env = {TYPESAFE_API_KEY: 'synthetic-stale-secret', JEV_API_KEY_FILE: path, JEV_ENABLED: '1'};
  const service = createService({env, fetchFn: async () => {calls++; throw new Error('unexpected egress');}});
  assert.equal(service.status().credentialConfigured, true);
  const preview = await service.classifyFailure({...failure('preview'), output: `${FILE_KEY_SECRET} and synthetic-stale-secret`});
  assert.equal(preview.status, 'preview');
  assert.equal(JSON.stringify(preview).includes(FILE_KEY_SECRET), false);
  assert.equal(JSON.stringify(preview).includes('synthetic-stale-secret'), false);
  writeFileSync(path, 'malformed', {mode: 0o600});
  assert.equal(service.status().credentialConfigured, false);
  assert.equal(service.status().credentialFingerprint, null);
  for (const mode of ['preview', 'evaluate'] as const) {
    const result = await service.classifyFailure(failure(mode));
    assert.deepEqual(result, {status: 'unavailable', reasonCode: 'credential_source_unavailable'});
    assert.equal(JSON.stringify(result).includes(path), false);
  }
  rmSync(path);
  assert.equal(service.status().credentialConfigured, false);
  assert.deepEqual(await service.classifyFailure(failure()),
    {status: 'unavailable', reasonCode: 'credential_source_unavailable'});
  assert.equal(calls, 0);
  const explicit = createService({apiKey: 'explicit-key', env,
    store: {reserve: async () => true, save: async () => {}},
    fetchFn: async () => {calls++; return validResponse();}});
  assert.equal(explicit.status().credentialConfigured, true);
  assert.equal((await explicit.classifyFailure(failure())).status, 'assessed');
  assert.equal(calls, 1);
});

test('rotation gives concurrent requests separate credential snapshots, receipts and cache entries', async t => {
  const {path, write} = fixture(t);
  write(FILE_KEY_ONE);
  const receipts: Receipt[] = [];
  const store: Store = {reserve: async () => true, save: async receipt => {receipts.push(receipt);}};
  let releaseFirst!: () => void;
  let firstStarted!: () => void;
  const firstStartedPromise = new Promise<void>(resolve => {firstStarted = resolve;});
  const firstGate = new Promise<void>(resolve => {releaseFirst = resolve;});
  const headers: string[] = [];
  const service = createService({env: {JEV_API_KEY_FILE: path, TYPESAFE_API_KEY: 'synthetic-stale-key'}, store,
    fetchFn: async (_url, init) => {
      const authorization = (init?.headers as Record<string, string>).authorization;
      assert.ok(authorization);
      headers.push(authorization);
      if (authorization === `Bearer ${FILE_KEY_ONE}`) {firstStarted(); await firstGate;}
      return validResponse();
    }});
  const first = service.classifyFailure(failure());
  await firstStartedPromise;
  write(FILE_KEY_TWO);
  assert.equal(service.status().credentialFingerprint, createHash('sha256').update(FILE_KEY_TWO).digest('hex'));
  const second = await service.classifyFailure(failure());
  assert.equal(second.status, 'assessed');
  assert.equal(second.cached, undefined);
  assert.equal(second.transport?.credentialFingerprint, service.status().credentialFingerprint);
  releaseFirst();
  const old = await first;
  assert.equal(old.status, 'assessed');
  assert.notEqual(old.transport?.credentialFingerprint, second.transport?.credentialFingerprint);
  const third = await service.classifyFailure(failure());
  assert.equal(third.cached, true);
  assert.equal(third.receiptId, second.receiptId);
  assert.equal(headers.length, 2);
  assert.deepEqual(headers, [`Bearer ${FILE_KEY_ONE}`, `Bearer ${FILE_KEY_TWO}`]);
  assert.equal(receipts.length, 2);
  assert.equal(JSON.stringify(receipts).includes(FILE_KEY_ONE), false);
  assert.equal(JSON.stringify(receipts).includes(FILE_KEY_TWO), false);
});
