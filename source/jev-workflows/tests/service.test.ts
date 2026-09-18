import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createService, type ServiceOptions } from '../src/service.js';
import type { Receipt, Store } from '../src/store.js';

type FetchCall = { url: string; init: RequestInit | undefined };

function timeoutKeepalive(): NodeJS.Timeout {
  return setTimeout(() => {}, 1000);
}

class MemoryStore implements Store {
  readonly receipts: Receipt[] = [];
  readonly reservations: number[] = [];
  reserveResult = true;
  saveError = false;

  async reserve(bytes: number): Promise<boolean> {
    this.reservations.push(bytes);
    return this.reserveResult;
  }

  async save(receipt: Receipt): Promise<void> {
    if (this.saveError) throw new Error('store failed');
    this.receipts.push(receipt);
  }
}

function failure(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    task: 'run the failing command',
    command: 'npm test',
    exitCode: 1,
    output: 'AssertionError: expected 1 to equal 2',
    evidence: [{id: 'log:1', text: 'AssertionError: expected 1 to equal 2'}],
    mode: 'evaluate',
    ...overrides,
  };
}

function completion(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    claim: 'The command is complete',
    acceptanceCriteria: ['The command exits successfully'],
    evidence: [{id: 'receipt:1', text: 'The command exited successfully'}],
    mode: 'evaluate',
    ...overrides,
  };
}

function responseForFailure(category = 'assertion_failure', confidence = 0.95): Response {
  return new Response(JSON.stringify({
    model: 'jev-1.13.0',
    answers: {
      category: {type: 'choice', choice: category, probabilities: {
        compile_error: category === 'compile_error' ? 0.95 : 0.01,
        assertion_failure: category === 'assertion_failure' ? 0.95 : 0.01,
        missing_dependency: category === 'missing_dependency' ? 0.95 : 0.01,
        unavailable_service: category === 'unavailable_service' ? 0.95 : 0.01,
        permission_failure: category === 'permission_failure' ? 0.95 : 0.01,
        insufficient_evidence: category === 'insufficient_evidence' ? 0.95 : 0.01,
      }, confidence},
      reached_assertion: {type: 'noul', noul: 0.9},
      missing_context: {type: 'noul', noul: 0.1},
    },
    usage: {input_tokens: 20, output_tokens: 12},
  }), {headers: {'x-typesafe-request-id': 'req_service_123'}});
}

function responseForCompletion(support = 'supported', confidence = 0.95): Response {
  return new Response(JSON.stringify({
    model: 'jev-1.13.0',
    answers: {support: {type: 'choice', choice: support, probabilities: {
      supported: support === 'supported' ? 0.95 : 0.01,
      partially_supported: support === 'partially_supported' ? 0.95 : 0.01,
      contradicted: support === 'contradicted' ? 0.95 : 0.01,
      insufficient_evidence: support === 'insufficient_evidence' ? 0.95 : 0.01,
    }, confidence}},
    usage: {input_tokens: 20, output_tokens: 12},
  }));
}

function fetchReturning(response: Response, calls: FetchCall[] = []): typeof fetch {
  return async (input, init) => {
    calls.push({url: String(input), init});
    return response.clone();
  };
}

function service(options: Partial<ServiceOptions> = {}): ReturnType<typeof createService> {
  return createService({apiKey: 'configured-test-key', enabled: true, ...options, store: options.store ?? new MemoryStore()});
}

describe('service preview and input gates', () => {
  it('previews locally with redacted evidence and never calls fetch', async () => {
    let calls = 0;
    const result = await service({
      fetchFn: async () => { calls += 1; throw new Error('network must not be used'); },
    }).classifyFailure(failure({output: 'Bearer configured-test-key leaked in log', mode: 'preview'}));

    assert.equal(result.status, 'preview');
    assert.equal(calls, 0);
    const preview = result.preview as {state: {output: string}};
    assert.equal(preview.state.output, 'Bearer [REDACTED] leaked in log');
    assert.equal(JSON.stringify(result).includes('configured-test-key'), false);
  });

  it('skips disabled evaluation and reports missing credentials without egress', async () => {
    let calls = 0;
    const options = {fetchFn: async () => { calls += 1; throw new Error('unexpected egress'); }};
    const disabled = createService({...options, enabled: false, apiKey: 'key'});
    const missing = createService({...options, enabled: true, apiKey: ''});
    assert.deepEqual(await disabled.classifyFailure(failure()), {status: 'skipped', reasonCode: 'disabled'});
    assert.deepEqual(await missing.classifyFailure(failure()), {status: 'unavailable', reasonCode: 'missing_api_key'});
    assert.equal(calls, 0);
  });

  it('skips successful commands, abstains on incomplete commands, and abstains without completion evidence', async () => {
    const calls: FetchCall[] = [];
    const store = new MemoryStore();
    const svc = service({store, fetchFn: fetchReturning(responseForCompletion(), calls)});
    assert.deepEqual(await svc.classifyFailure(failure({exitCode: 0})), {status: 'skipped', reasonCode: 'command_succeeded'});
    assert.deepEqual(await svc.classifyFailure(failure({exitCode: null})), {status: 'abstained', reasonCode: 'command_not_completed'});
    const noEvidence = await svc.checkCompletion(completion({evidence: []}));
    assert.deepEqual(noEvidence, {status: 'abstained', support: 'insufficient_evidence', reasonCode: 'no_evidence', evidenceIds: []});
    assert.equal(calls.length, 0);
    assert.equal(store.reservations.length, 0);
  });

  it('enforces strict input, duplicate IDs, and the payload byte limit', async () => {
    const svc = service();
    assert.deepEqual(await svc.classifyFailure({...failure(), unexpected: true}), {status: 'skipped', reasonCode: 'invalid_input'});
    assert.deepEqual(await svc.classifyFailure(failure({evidence: [
      {id: 'duplicate', text: 'one'}, {id: 'duplicate', text: 'two'},
    ]})), {status: 'skipped', reasonCode: 'duplicate_evidence_ids'});
    assert.deepEqual(await svc.classifyFailure(failure({task: 'x'.repeat(4000), output: 'x'.repeat(24000), evidence: [
      ...Array.from({length: 12}, (_, index) => ({id: `ev-${index}`, text: 'y'.repeat(12000)})),
    ]})), {status: 'skipped', reasonCode: 'payload_too_large'});
  });

  it('accepts explicit safe-integer environment limits above the removed ceilings and preserves unlimited defaults', () => {
    const configured = service({env: {
      JEV_MAX_CALLS_PER_DAY: '1001',
      JEV_MAX_BYTES_PER_DAY: '10000001',
    }}).status();
    assert.equal(configured.maxCallsPerDay, 1001);
    assert.equal(configured.maxBytesPerDay, 10_000_001);

    const maximum = service({env: {JEV_MAX_CALLS_PER_DAY: String(Number.MAX_SAFE_INTEGER)}}).status();
    assert.equal(maximum.maxCallsPerDay, Number.MAX_SAFE_INTEGER);
    const unlimited = service({env: {JEV_MAX_CALLS_PER_DAY: 'unlimited'}}).status();
    assert.equal(unlimited.maxCallsPerDay, null);
    assert.equal(unlimited.maxBytesPerDay, null);
    const invalid = service({env: {JEV_MAX_CALLS_PER_DAY: '1e3', JEV_MAX_BYTES_PER_DAY: '-1'}}).status();
    assert.equal(invalid.maxCallsPerDay, 0);
    assert.equal(invalid.maxBytesPerDay, 0);
  });
});

describe('service evaluation and persistence', () => {
  it('sends only the fixed provider request and persists a successful receipt', async () => {
    const calls: FetchCall[] = [];
    const store = new MemoryStore();
    const result = await service({store, fetchFn: fetchReturning(responseForFailure(), calls)}).classifyFailure(failure());
    assert.equal(result.status, 'assessed');
    assert.equal(result.category, 'assertion_failure');
    assert.equal(result.workflow, 'inspect_assertion');
    assert.equal(result.receiptPersisted, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.url, 'https://api.typesafe.ai/v1/systemone');
    assert.equal(calls[0]?.init?.redirect, 'error');
    assert.equal((calls[0]?.init?.headers as Record<string, string>).authorization, 'Bearer configured-test-key');
    assert.equal(store.receipts.length, 1);
    assert.equal(JSON.stringify(store.receipts[0]).includes('AssertionError'), false);
    assert.equal(result.transport?.responseStatus, 200);
    assert.equal(result.transport?.fetchInvoked, true);
    assert.equal(result.transport?.validatedResponse, true);
    assert.equal(result.transport?.providerRequestId, 'req_service_123');
    assert.equal(result.transport?.providerRequestIdHeader, 'x-typesafe-request-id');
    assert.equal(Object.hasOwn(result.transport ?? {}, 'responseValidationFailure'), false);
    assert.equal(result.transport?.credentialFingerprint, createHash('sha256').update('configured-test-key').digest('hex'));
    assert.deepEqual(store.receipts[0]?.transport, result.transport);
    assert.equal(JSON.stringify(store.receipts[0]).includes('configured-test-key'), false);
  });

  it('abstains on low confidence and caches completed assessments while coalescing duplicate calls', async () => {
    const calls: FetchCall[] = [];
    const store = new MemoryStore();
    const svc = service({store, confidenceFloor: 0.6, fetchFn: async (input, init) => {
      calls.push({url: String(input), init});
      await new Promise(resolve => setTimeout(resolve, 5));
      return responseForFailure('assertion_failure', 0.4);
    }});
    const [first, second] = await Promise.all([svc.classifyFailure(failure()), svc.classifyFailure(failure())]);
    assert.equal(first.status, 'abstained');
    assert.equal(first.reasonCode, 'low_confidence');
    assert.equal(second.cached, true);
    const cached = await svc.classifyFailure(failure());
    assert.equal(cached.cached, true);
    assert.equal(cached.receiptId, first.receiptId);
    assert.deepEqual(cached.transport, first.transport);
    assert.equal(calls.length, 1);
    assert.equal(store.reservations.length, 1);
    assert.equal(store.receipts.length, 1);
  });

  it('persists response facts for HTTP errors and leaves pre-response timeout and cancellation unknown', async () => {
    for (const [status, code] of [[401, 'authentication_failed'], [429, 'rate_limited'], [529, 'provider_overloaded']] as const) {
      const store = new MemoryStore();
      const result = await service({store, fetchFn: async () => new Response('sensitive body', {
        status, headers: {'x-typesafe-request-id': `req_error_${status}`},
      })}).classifyFailure(failure());
      assert.equal(result.status, 'unavailable');
      assert.equal(result.reasonCode, code);
      assert.equal(result.transport?.responseStatus, status);
      assert.equal(result.transport?.providerRequestId, `req_error_${status}`);
      assert.equal(result.transport?.validatedResponse, false);
      assert.equal(Object.hasOwn(result.transport ?? {}, 'responseValidationFailure'), false);
      assert.deepEqual(store.receipts[0]?.transport, result.transport);
      assert.equal(JSON.stringify(store.receipts[0]).includes('sensitive body'), false);
    }

    const malformedStore = new MemoryStore();
    const malformed = await service({store: malformedStore, fetchFn: async () => new Response('not-json', {
      status: 200, headers: {'x-typesafe-request-id': 'req_malformed_200'},
    })}).classifyFailure(failure());
    assert.equal(malformed.reasonCode, 'invalid_response');
    assert.equal(malformed.transport?.responseStatus, 200);
    assert.equal(malformed.transport?.providerRequestId, 'req_malformed_200');
    assert.equal(malformed.transport?.validatedResponse, false);
    assert.equal(malformed.transport?.responseValidationFailure, 'invalid_json');
    assert.deepEqual(malformedStore.receipts[0]?.transport, malformed.transport);
    assert.equal(malformedStore.receipts[0]?.transport?.responseValidationFailure, 'invalid_json');
    assert.equal(JSON.stringify(malformedStore.receipts[0]).includes('not-json'), false);

    const timeoutStore = new MemoryStore();
    const timeoutKeepaliveHandle = timeoutKeepalive();
    let timeout: Awaited<ReturnType<ReturnType<typeof service>['classifyFailure']>>;
    try {
      timeout = await service({store: timeoutStore, timeoutMs: 5, fetchFn: async (_input, init) => new Promise<Response>((_resolve, reject) => {
        (init?.signal as AbortSignal).addEventListener('abort', () => reject(new Error('timed out')), {once: true});
      })}).classifyFailure(failure());
    } finally {
      clearTimeout(timeoutKeepaliveHandle);
    }
    assert.equal(timeout.reasonCode, 'timeout');
    assert.equal(timeout.transport?.fetchInvoked, true);
    assert.equal(timeout.transport?.responseStatus, null);
    assert.equal(timeout.transport?.responseReceivedAt, null);
    assert.deepEqual(timeoutStore.receipts[0]?.transport, timeout.transport);

    const cancellationStore = new MemoryStore();
    const controller = new AbortController();
    const cancellation = service({store: cancellationStore, fetchFn: async (_input, init) => new Promise<Response>((_resolve, reject) => {
      (init?.signal as AbortSignal).addEventListener('abort', () => reject(new Error('cancelled')), {once: true});
    })}).classifyFailure(failure(), controller.signal);
    controller.abort();
    const cancelled = await cancellation;
    assert.equal(cancelled.reasonCode, 'cancelled');
    assert.equal(cancelled.transport?.fetchInvoked, false);
    assert.equal(cancelled.transport?.responseStatus, null);
    assert.equal(cancelled.transport?.responseReceivedAt, null);
    assert.deepEqual(cancellationStore.receipts[0]?.transport, cancelled.transport);
  });

  it('exposes only the credential fingerprint in status and receipts', async () => {
    const apiKey = 'credential-value-that-must-not-escape';
    const store = new MemoryStore();
    const svc = service({apiKey, store, fetchFn: fetchReturning(responseForFailure())});
    const status = svc.status();
    const result = await svc.classifyFailure(failure());
    const expected = createHash('sha256').update(apiKey).digest('hex');
    assert.equal(status.credentialFingerprint, expected);
    assert.equal(result.transport?.credentialFingerprint, expected);
    assert.equal(JSON.stringify(status).includes(apiKey), false);
    assert.equal(JSON.stringify(result).includes(apiKey), false);
    assert.equal(JSON.stringify(store.receipts).includes(apiKey), false);
  });

  it('reports budget exhaustion and store failures without calling or exposing provider data', async () => {
    let calls = 0;
    const exhaustedStore = new MemoryStore();
    exhaustedStore.reserveResult = false;
    const exhausted = await service({store: exhaustedStore, fetchFn: async () => { calls += 1; return responseForFailure(); }}).classifyFailure(failure());
    assert.equal(exhausted.status, 'skipped');
    assert.equal(exhausted.reasonCode, 'budget_exhausted');
    assert.equal(calls, 0);

    const failedStore = new MemoryStore();
    failedStore.saveError = true;
    const persisted = await service({store: failedStore, fetchFn: fetchReturning(responseForFailure())}).classifyFailure(failure());
    assert.equal(persisted.status, 'assessed');
    assert.equal(persisted.receiptPersisted, false);
    assert.equal(JSON.stringify(persisted).includes('configured-test-key'), false);
  });
});
