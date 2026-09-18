import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {createService, type Assessment} from '../src/service.js';
import {dispatch, main, MAX_STDIN_BYTES, parseArgs, readBoundedStdin, type CliService} from '../src/cli.js';

const failureInput = {
  task: 'run the failing command', command: 'npm test', exitCode: 1,
  output: 'AssertionError: expected 1 to equal 2',
  evidence: [{id: 'log:1', text: 'AssertionError: expected 1 to equal 2'}],
};

function stub(result: Assessment): CliService {
  return {
    status: () => ({version: '0.2.2', provider: 'TypeSafe', model: 'jev-1.13.0', credentialConfigured: true, credentialFingerprint: 'secret', stateDirectory: '/private'}),
    classifyDecision: async () => result,
    classifyFailure: async () => result,
    checkCompletion: async () => result,
  };
}

describe('standalone CLI', () => {
  it('parses commands and rejects malformed arguments', () => {
    assert.deepEqual(parseArgs(['classify-failure', '--evaluate']), {command: 'classify-failure', evaluate: true, help: false});
    assert.throws(() => parseArgs(['classify-failure', '--unknown']), /invalid_argument/);
    assert.throws(() => parseArgs([]), /missing_command/);
  });

  it('bounds stdin before parsing and reports malformed JSON', async () => {
    await assert.rejects(readBoundedStdin([Buffer.alloc(MAX_STDIN_BYTES + 1)]), /input_too_large/);
    const out = {write: (text: string) => { out.text += text; }, text: ''};
    const code = await main({argv: ['classify-failure'], stdin: ['{'], stdout: out, stderr: out});
    assert.equal(code, 2);
    assert.equal(out.text, '{"error":"malformed_json"}\n');
  });

  it('rejects evaluate input unless --evaluate is explicit', async () => {
    const args = parseArgs(['classify-failure']);
    await assert.rejects(dispatch(args, {...failureInput, mode: 'evaluate'}, stub({status: 'preview'})), /evaluation_requires_flag/);
    assert.deepEqual((await dispatch(parseArgs(['classify-failure', '--evaluate']), {...failureInput, mode: 'bogus'}, stub({status: 'preview'}))).value, {status: 'skipped', reasonCode: 'invalid_input'});
    assert.throws(() => parseArgs(['status', '--evaluate', '--help']), /invalid_argument/);
    assert.throws(() => parseArgs(['--help', '--evaluate']), /invalid_argument/);
  });

  it('previews through the real service without provider egress', async () => {
    let calls = 0;
    const service = createService({apiKey: 'test-key', enabled: true, fetchFn: async () => { calls++; throw new Error('must not call'); }});
    const result = await dispatch(parseArgs(['classify-failure']), failureInput, service);
    assert.equal(result.exitCode, 0);
    assert.equal((result.value as Assessment).status, 'preview');
    assert.equal(calls, 0);
  });

  it('serializes unavailable no-key evaluation without calling a provider', async () => {
    let calls = 0;
    const service = createService({apiKey: '', enabled: true, fetchFn: async () => { calls++; throw new Error('must not call'); }});
    const result = await dispatch(parseArgs(['classify-failure', '--evaluate']), failureInput, service);
    assert.equal(result.exitCode, 0);
    assert.deepEqual(result.value, {status: 'unavailable', reasonCode: 'missing_api_key'});
    assert.equal(calls, 0);
  });

  it('keeps preview local and no-key evaluation provider-free for decision and completion', async () => {
    let calls = 0;
    const service = createService({apiKey: '', enabled: true, fetchFn: async () => { calls++; throw new Error('must not call'); }});
    const decision = {domain: 'task', question: 'Which task?', context: 'Need the bounded task.', candidates: [
      {id: 'a', description: 'first'}, {id: 'b', description: 'second'},
    ], evidence: []};
    const completion = {claim: 'The task is complete', acceptanceCriteria: ['A result exists'], evidence: [{id: 'e1', text: 'A result exists'}]};
    const decisionPreview = await dispatch(parseArgs(['classify-decision']), decision, service);
    assert.equal((decisionPreview.value as Assessment).status, 'preview');
    const completionPreview = await dispatch(parseArgs(['check-completion']), completion, service);
    assert.equal((completionPreview.value as Assessment).status, 'preview');
    const decisionUnavailable = await dispatch(parseArgs(['classify-decision', '--evaluate']), decision, service);
    assert.equal((decisionUnavailable.value as Assessment).reasonCode, 'missing_api_key');
    const completionUnavailable = await dispatch(parseArgs(['check-completion', '--evaluate']), completion, service);
    assert.equal((completionUnavailable.value as Assessment).reasonCode, 'missing_api_key');
    assert.equal(calls, 0);
  });

  it('sanitizes service and transport exceptions', async () => {
    const throwing: CliService = {...stub({status: 'preview'}), classifyFailure: async () => { throw new Error('secret provider body'); }};
    const result = await dispatch(parseArgs(['classify-failure', '--evaluate']), failureInput, throwing);
    assert.deepEqual(result.value, {status: 'unavailable', reasonCode: 'internal_error'});
    assert.equal(JSON.stringify(result).includes('secret provider body'), false);
  });

  it('keeps status public and preserves assessed and abstained exit semantics with an injectable service', async () => {
    const service = stub({status: 'assessed', category: 'assertion_failure'});
    const status = await dispatch(parseArgs(['status']), {}, service);
    assert.deepEqual(status.value, {version: '0.2.2', provider: 'TypeSafe', model: 'jev-1.13.0', credentialConfigured: true, enabled: false, quotas: {maxCallsPerDay: null, maxBytesPerDay: null}});
    const assessed = await dispatch(parseArgs(['classify-failure', '--evaluate']), failureInput, service);
    assert.equal(assessed.exitCode, 0);
    const abstained = await dispatch(parseArgs(['classify-failure']), failureInput, stub({status: 'abstained', reasonCode: 'insufficient_evidence'}));
    assert.equal(abstained.exitCode, 0);
  });
});

it('honors an injected environment for credentials, enablement and settings without ambient leakage', async () => {
  const out = {text: '', write(text: string) { this.text += text; }};
  const env = {TYPESAFE_API_KEY: '', JEV_MAX_CALLS_PER_DAY: '2', JEV_MAX_BYTES_PER_DAY: 'unlimited'};
  assert.equal(await main({argv: ['status'], env, stdout: out}), 0);
  const status = JSON.parse(out.text);
  assert.equal(status.credentialConfigured, false);
  assert.deepEqual(status.quotas, {maxCallsPerDay: 2, maxBytesPerDay: null});
  out.text = '';
  assert.equal(await main({argv: ['classify-failure', '--evaluate'], env, stdin: [JSON.stringify(failureInput)], stdout: out}), 0);
  assert.deepEqual(JSON.parse(out.text), {status: 'unavailable', reasonCode: 'missing_api_key'});
  out.text = '';
  assert.equal(await main({argv: ['classify-failure', '--evaluate'], env: {...env, JEV_ENABLED: '0'}, stdin: [JSON.stringify(failureInput)], stdout: out}), 0);
  assert.deepEqual(JSON.parse(out.text), {status: 'skipped', reasonCode: 'disabled'});
});

it('rejects an explicit preview with --evaluate before dispatch', async () => {
  let invoked = false;
  const service = stub({status: 'assessed'});
  service.classifyFailure = async () => { invoked = true; return {status: 'assessed'}; };
  await assert.rejects(dispatch(parseArgs(['classify-failure', '--evaluate']), {...failureInput, mode: 'preview'}, service), /conflicting_mode/);
  assert.equal(invoked, false);
});

it('reports disabled evaluation even when a credential is configured', async () => {
  const out = {text: '', write(text: string) { this.text += text; }};
  assert.equal(await main({argv: ['status'], env: {TYPESAFE_API_KEY: 'synthetic-status-key', JEV_ENABLED: '0'}, stdout: out}), 0);
  const status = JSON.parse(out.text);
  assert.equal(status.credentialConfigured, true);
  assert.equal(status.enabled, false);
  assert.equal(out.text.includes('synthetic-status-key'), false);
});
