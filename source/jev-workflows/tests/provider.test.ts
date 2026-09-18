import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { ENDPOINT, failureQuestions, type Question } from '../src/contracts.js';
import { evaluateProvider, ProviderError, validateEvaluation, type ProviderTransport, type ResponseValidationFailure } from '../src/provider.js';

function validEvaluation(): Record<string, unknown> {
  return {
    model: 'jev-1.13.0',
    answers: {
      category: {type: 'choice', choice: 'assertion_failure', probabilities: {
        compile_error: 0.01, assertion_failure: 0.95, missing_dependency: 0.01,
        unavailable_service: 0.01, permission_failure: 0.01, insufficient_evidence: 0.01,
      }, confidence: 0.95},
      reached_assertion: {type: 'noul', noul: 0.9},
      missing_context: {type: 'noul', noul: 0.1},
    },
    usage: {input_tokens: 4, output_tokens: 8},
  };
}

function assertProviderError(error: unknown, code: string): asserts error is ProviderError {
  assert.equal(error instanceof ProviderError, true);
  assert.equal((error as ProviderError).code, code);
}

const observedTransport: ProviderTransport = {
  requestStartedAt: '2026-09-18T00:00:00.000Z',
  fetchInvoked: true,
  responseReceivedAt: '2026-09-18T00:00:00.100Z',
  responseStatus: 200,
  validatedResponse: false,
  providerRequestId: 'req_validation_test',
  providerRequestIdHeader: 'x-typesafe-request-id',
  credentialFingerprint: 'f'.repeat(64),
};

function assertValidationFailure(raw: unknown, failure: ResponseValidationFailure, questions = failureQuestions): void {
  assert.throws(() => validateEvaluation(raw, questions, observedTransport), error => {
    assertProviderError(error, 'invalid_response');
    assert.equal(error.transport?.responseValidationFailure, failure);
    return true;
  });
}

describe('provider response validation', () => {
  it('rejects malformed probabilities, wrong choices, malformed noul, and schema-invalid responses', () => {
    const malformed = validEvaluation();
    ((malformed.answers as Record<string, unknown>).category as Record<string, unknown>).probabilities = {
      compile_error: 0.01, assertion_failure: 0.01, missing_dependency: 0.01,
      unavailable_service: 0.01, permission_failure: 0.01, insufficient_evidence: 0.01,
    };
    assertValidationFailure(malformed, 'probability_sum_invalid');

    const wrongChoice = validEvaluation();
    ((wrongChoice.answers as Record<string, unknown>).category as Record<string, unknown>).choice = 'not-a-category';
    assertValidationFailure(wrongChoice, 'choice_unknown');

    const badNoul = validEvaluation();
    ((badNoul.answers as Record<string, unknown>).reached_assertion as Record<string, unknown>).noul = Number.NaN;
    assertValidationFailure(badNoul, 'answer_schema');

    const invalidModel = {...validEvaluation(), model: 'provider-model-is-not-jev'};
    assertValidationFailure(invalidModel, 'model_mismatch');
  });

  it('requires exact answer IDs and exact probability keys', () => {
    const missingAnswer = validEvaluation();
    delete (missingAnswer.answers as Record<string, unknown>).missing_context;
    assertValidationFailure(missingAnswer, 'answer_keys_mismatch');

    const extraProbability = validEvaluation();
    const probabilities = ((extraProbability.answers as Record<string, unknown>).category as Record<string, unknown>).probabilities as Record<string, number>;
    probabilities.extra = 0;
    assertValidationFailure(extraProbability, 'probability_keys_mismatch');
  });

  it('compares probability keys without delimiter collisions and exposes no response-controlled detail', () => {
    const secretKey = 'b,c';
    const questions: Record<string, Question> = {
      decision: {type: 'choice', instructions: 'Choose one', criteria: {'a,b': 'first', c: 'second'}},
    };
    const raw = {
      model: 'jev-1.13.0',
      answers: {decision: {type: 'choice', choice: 'c', probabilities: {a: 0.5, [secretKey]: 0.5}, confidence: 0.5}},
      usage: {input_tokens: 1, output_tokens: 1},
    };
    assert.throws(() => validateEvaluation(raw, questions, observedTransport), error => {
      assertProviderError(error, 'invalid_response');
      assert.equal(error.transport?.responseValidationFailure, 'probability_keys_mismatch');
      assert.equal(JSON.stringify(error).includes(secretKey), false);
      assert.equal(String(error).includes(secretKey), false);
      return true;
    });
  });

  it('distinguishes response shape and choice consistency failures with fixed stages', () => {
    assertValidationFailure({model: 'jev-1.13.0'}, 'response_schema');
    const notArgmax = validEvaluation();
    const choice = (notArgmax.answers as Record<string, any>).category;
    choice.choice = 'compile_error';
    choice.probabilities = {
      compile_error: 0.1, assertion_failure: 0.85, missing_dependency: 0.01,
      unavailable_service: 0.01, permission_failure: 0.01, insufficient_evidence: 0.02,
    };
    assertValidationFailure(notArgmax, 'choice_not_argmax');
  });
});

describe('provider transport', () => {
  it('uses the fixed API endpoint, POST, bearer auth, and redirect error mode', async () => {
    let request: {input: RequestInfo | URL; init: RequestInit | undefined} | undefined;
    const result = await evaluateProvider({
      state: {output: '[REDACTED]'}, questions: failureQuestions, apiKey: 'provider-key', timeoutMs: 1000,
      fetchFn: async (input, init) => { request = {input, init}; return new Response(JSON.stringify(validEvaluation()), {
        headers: {'x-typesafe-request-id': 'req_typesafe_123'},
      }); },
    });
    assert.equal(result.model, 'jev-1.13.0');
    assert.equal(String(request?.input), ENDPOINT);
    assert.equal(request?.init?.method, 'POST');
    assert.equal(request?.init?.redirect, 'error');
    assert.equal((request?.init?.headers as Record<string, string>).authorization, 'Bearer provider-key');
    assert.equal(JSON.parse(String(request?.init?.body)).model, 'jev-1.13.0');
    assert.equal(result.transport.responseStatus, 200);
    assert.equal(result.transport.fetchInvoked, true);
    assert.equal(result.transport.validatedResponse, true);
    assert.equal(result.transport.providerRequestId, 'req_typesafe_123');
    assert.equal(result.transport.providerRequestIdHeader, 'x-typesafe-request-id');
    assert.equal(Object.hasOwn(result.transport, 'responseValidationFailure'), false);
    assert.equal(result.transport.credentialFingerprint, createHash('sha256').update('provider-key').digest('hex'));
    assert.match(result.transport.requestStartedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.match(result.transport.responseReceivedAt!, /^\d{4}-\d{2}-\d{2}T/);
  });

  it('records only safe IDs from the three allowlisted response headers', async () => {
    const evaluate = (headers?: HeadersInit) => evaluateProvider({
      state: {}, questions: failureQuestions, apiKey: 'provider-key', timeoutMs: 1000,
      fetchFn: async () => new Response(JSON.stringify(validEvaluation()), {headers}),
    });

    const absent = await evaluate({'x-amzn-requestid': 'ignored-request-id'});
    assert.equal(absent.transport.providerRequestId, null);
    assert.equal(absent.transport.providerRequestIdHeader, null);

    const generic = await evaluate({'x-request-id': 'req_generic_123'});
    assert.equal(generic.transport.providerRequestId, 'req_generic_123');
    assert.equal(generic.transport.providerRequestIdHeader, 'x-request-id');

    const fallback = await evaluate({
      'x-typesafe-request-id': 'provider-key',
      'x-request-id': 'req_safe_fallback',
      'request-id': 'req_lower_priority',
    });
    assert.equal(fallback.transport.providerRequestId, 'req_safe_fallback');
    assert.equal(fallback.transport.providerRequestIdHeader, 'x-request-id');

    const unsafe = await evaluate({
      'x-typesafe-request-id': 'provider-key',
      'x-request-id': 'https://provider.invalid/request/123',
      'request-id': 'x'.repeat(257),
    });
    assert.equal(unsafe.transport.providerRequestId, null);
    assert.equal(unsafe.transport.providerRequestIdHeader, null);
    assert.equal(JSON.stringify(unsafe).includes('provider-key'), false);
  });

  it('maps HTTP failures to sanitized provider codes without echoing provider bodies', async () => {
    for (const [status, code] of [[401, 'authentication_failed'], [403, 'authentication_failed'], [422, 'invalid_request'], [429, 'rate_limited'], [529, 'provider_overloaded'], [500, 'provider_error']] as const) {
      const body = 'provider secret body must never escape';
      await assert.rejects(() => evaluateProvider({
        state: {}, questions: failureQuestions, apiKey: 'key', timeoutMs: 1000,
        fetchFn: async () => new Response(body, {status}),
      }), error => {
        assertProviderError(error, code);
        assert.equal(String(error).includes(body), false);
        assert.equal(error.transport?.responseStatus, status);
        assert.equal(error.transport?.validatedResponse, false);
        assert.match(error.transport?.responseReceivedAt ?? '', /^\d{4}-\d{2}-\d{2}T/);
        return true;
      });
    }
  });

  it('maps missing, malformed, and empty successful response bodies to fixed validation stages', async () => {
    const rawSecret = 'raw-provider-secret-must-not-escape';
    for (const [body, failure] of [[null, 'missing_body'], [rawSecret, 'invalid_json'], ['', 'invalid_json']] as const) {
      await assert.rejects(() => evaluateProvider({
        state: {}, questions: failureQuestions, apiKey: 'key', timeoutMs: 1000,
        fetchFn: async () => new Response(body, {status: 200}),
      }), error => {
        assertProviderError(error, 'invalid_response');
        assert.equal(error.transport?.responseStatus, 200);
        assert.equal(error.transport?.validatedResponse, false);
        assert.equal(error.transport?.responseValidationFailure, failure);
        assert.equal(JSON.stringify(error).includes(rawSecret), false);
        assert.equal(String(error).includes(rawSecret), false);
        return true;
      });
    }
  });

  it('bounds response bodies and maps cancellation and timeout separately', async () => {
    await assert.rejects(() => evaluateProvider({
      state: {}, questions: failureQuestions, apiKey: 'key', timeoutMs: 1000,
      fetchFn: async () => new Response('x'.repeat(65537)),
    }), error => { assertProviderError(error, 'response_too_large'); return true; });

    const cancelled = new AbortController();
    const cancellation = evaluateProvider({
      state: {}, questions: failureQuestions, apiKey: 'key', timeoutMs: 1000, signal: cancelled.signal,
      fetchFn: async (_input, init) => new Promise<Response>((_resolve, reject) => {
        (init?.signal as AbortSignal).addEventListener('abort', () => reject(new Error('aborted')), {once: true});
      }),
    });
    cancelled.abort();
    await assert.rejects(cancellation, error => {
      assertProviderError(error, 'cancelled');
      assert.equal(error.transport?.fetchInvoked, true);
      assert.equal(error.transport?.responseStatus, null);
      assert.equal(error.transport?.responseReceivedAt, null);
      return true;
    });

    const cancelledAfterResponse = new AbortController();
    let readingStarted!: () => void;
    const reading = new Promise<void>(resolve => { readingStarted = resolve; });
    const afterResponse = evaluateProvider({
      state: {}, questions: failureQuestions, apiKey: 'key', timeoutMs: 1000, signal: cancelledAfterResponse.signal,
      fetchFn: async (_input, init) => new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          (init?.signal as AbortSignal).addEventListener('abort', () => controller.error(new Error('cancelled')), {once: true});
        },
        pull() { readingStarted(); return new Promise<void>(() => {}); },
      }), {status: 200, headers: {'x-typesafe-request-id': 'req_after_response'}}),
    });
    await reading;
    cancelledAfterResponse.abort();
    await assert.rejects(afterResponse, error => {
      assertProviderError(error, 'cancelled');
      assert.equal(error.transport?.responseStatus, 200);
      assert.match(error.transport?.responseReceivedAt ?? '', /^\d{4}-\d{2}-\d{2}T/);
      assert.equal(error.transport?.providerRequestId, 'req_after_response');
      assert.equal(error.transport?.validatedResponse, false);
      return true;
    });

    const timeoutAfterResponse = evaluateProvider({
      state: {}, questions: failureQuestions, apiKey: 'key', timeoutMs: 5,
      fetchFn: async (_input, init) => new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          (init?.signal as AbortSignal).addEventListener('abort', () => controller.error(new Error('timed out')), {once: true});
        },
        pull() { return new Promise<void>(() => {}); },
      }), {status: 200, headers: {'x-typesafe-request-id': 'req_timeout_after_response'}}),
    });
    await assert.rejects(timeoutAfterResponse, error => {
      assertProviderError(error, 'timeout');
      assert.equal(error.transport?.fetchInvoked, true);
      assert.equal(error.transport?.responseStatus, 200);
      assert.match(error.transport?.responseReceivedAt ?? '', /^\d{4}-\d{2}-\d{2}T/);
      assert.equal(error.transport?.providerRequestId, 'req_timeout_after_response');
      assert.equal(error.transport?.validatedResponse, false);
      return true;
    });

    await assert.rejects(() => evaluateProvider({
      state: {}, questions: failureQuestions, apiKey: 'key', timeoutMs: 5,
      fetchFn: async (_input, init) => new Promise<Response>((_resolve, reject) => {
        (init?.signal as AbortSignal).addEventListener('abort', () => reject(new Error('timed out')), {once: true});
      }),
    }), error => {
      assertProviderError(error, 'timeout');
      assert.equal(error.transport?.responseStatus, null);
      assert.equal(error.transport?.responseReceivedAt, null);
      return true;
    });

    const preCancelled = new AbortController();
    preCancelled.abort();
    let preCancelledFetchCalls = 0;
    await assert.rejects(() => evaluateProvider({
      state: {}, questions: failureQuestions, apiKey: 'key', timeoutMs: 1000, signal: preCancelled.signal,
      fetchFn: async () => { preCancelledFetchCalls++; return new Response(JSON.stringify(validEvaluation())); },
    }), error => {
      assertProviderError(error, 'cancelled');
      assert.equal(error.transport?.fetchInvoked, false);
      assert.equal(error.transport?.responseStatus, null);
      return true;
    });
    assert.equal(preCancelledFetchCalls, 0);

    await assert.rejects(() => evaluateProvider({
      state: {}, questions: failureQuestions, apiKey: 'key', timeoutMs: 1000,
      fetchFn: async () => { throw new Error('socket closed'); },
    }), error => {
      assertProviderError(error, 'provider_unavailable');
      assert.equal(error.transport?.fetchInvoked, true);
      assert.equal(error.transport?.responseStatus, null);
      assert.equal(error.transport?.responseReceivedAt, null);
      return true;
    });
  });
});
