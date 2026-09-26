import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {createService, type ServiceOptions} from '../src/service.js';
import type {Receipt, Store} from '../src/store.js';

class MemoryStore implements Store {
  receipts: Receipt[] = [];
  reservations: number[] = [];
  async reserve(bytes: number) { this.reservations.push(bytes); return true; }
  async save(receipt: Receipt) { this.receipts.push(receipt); }
}

function input(overrides: Record<string, unknown> = {}) {
  return {
    state: {ticket: {text: 'Choose from the current supported actions.'}, private: 'batch-test-key'},
    questions: {
      route: {
        type: 'choice', instructions: {question: 'Which available action fits?', field: 'ticket.text'}, domain: 'tool',
        candidates: [
          {id: 'inspect', description: {action: 'Inspect evidence'}, available: true},
          {id: 'repair', description: 'Apply a reversible repair', available: true},
          {id: 'offline', description: 'Unavailable action', available: false},
        ],
      },
      reversible_rank: {
        type: 'choice', instructions: 'Rank these reversible options.', domain: 'strategy', policy: {mode: 'ranking'},
        candidates: [{id: 'first', description: 'First'}, {id: 'second', description: 'Second'}],
      },
      severity: {
        type: 'score', instructions: ['Rate severity using the defined levels.'],
        criteria: [{label: 'low'}, {label: 'medium'}, {label: 'high'}],
      },
      has_evidence: {type: 'noul', instructions: 'Does `ticket.text` describe a concrete choice?', criteria: {true: 'yes', false: 'no'}},
    },
    policy: {minConfidence: 0.6, minProbability: 0.6},
    origin: {source: 'mcp', chatId: 'chat:123', turnId: 'turn:456'},
    correlation: {requestId: 'request:one', parentDecisionId: 'decision:parent'},
    mode: 'evaluate',
    ...overrides,
  };
}

function provider(calls: Array<Record<string, unknown>>): typeof fetch {
  return async (_url, init) => {
    const payload = JSON.parse(String(init?.body)) as {questions: Record<string, any>};
    calls.push(payload as unknown as Record<string, unknown>);
    const answers = Object.fromEntries(Object.entries(payload.questions).map(([id, question]) => {
      if (question.type === 'noul') return [id, {type: 'noul', noul: 0.82}];
      if (question.type === 'score') return [id, {
        type: 'score', score: 1.6, legend: Object.fromEntries(question.criteria.map((value: unknown, index: number) => [String(index), value])),
        probabilities: {'0': 0.1, '1': 0.2, '2': 0.7}, confidence: 0.8,
      }];
      const ids = Object.keys(question.criteria);
      const selected = ids[0]!;
      const selectedProbability = ids.length === 2 ? 0.9 : 0.55;
      const remainder = (1 - selectedProbability) / (ids.length - 1);
      return [id, {type: 'choice', choice: selected, probabilities: Object.fromEntries(ids.map(candidate => [candidate, candidate === selected ? selectedProbability : remainder])), confidence: 0.9}];
    }));
    return new Response(JSON.stringify({model: 'jev-1.13.0', answers, usage: {input_tokens: 50, output_tokens: 24}}), {
      headers: {'x-typesafe-request-id': 'req_batch_123'},
    });
  };
}

function service(options: Partial<ServiceOptions> = {}) {
  return createService({apiKey: 'batch-test-key', enabled: true, ...options, store: options.store ?? new MemoryStore()});
}

describe('evaluate_decisions mixed typed batch', () => {
  it('filters unavailable candidates, validates mixed answers, and separates best candidate from local policy', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const store = new MemoryStore();
    const result = await service({store, fetchFn: provider(calls)}).evaluateDecisions(input());

    assert.equal(result.status, 'assessed');
    assert.equal(result.authority, 'advisory_only');
    assert.equal(result.answers?.route?.type, 'choice');
    if (result.answers?.route?.type === 'choice') {
      assert.equal(result.answers.route.bestCandidate, 'inspect');
      assert.equal(result.answers.route.domain, 'tool');
      assert.equal(result.answers.route.disposition, 'abstained');
      assert.equal(result.answers.route.recommendation, undefined);
      assert.equal(result.answers.route.probabilities.inspect, 0.55);
    }
    if (result.answers?.reversible_rank?.type === 'choice') {
      assert.equal(result.answers.reversible_rank.disposition, 'ranking');
      assert.equal(result.answers.reversible_rank.recommendation, 'first');
      assert.equal(result.answers.reversible_rank.policy.calibration, 'not_locally_calibrated');
    }
    if (result.answers?.severity?.type === 'score') {
      assert.equal(result.answers.severity.score, 1.6);
      assert.deepEqual(result.answers.severity.probabilities, {'0': 0.1, '1': 0.2, '2': 0.7});
    }
    assert.deepEqual(result.answers?.has_evidence, {
      type: 'noul', noul: 0.82, disposition: 'advisory', policy: result.policies?.has_evidence,
    });
    const sent = calls[0] as {state: Record<string, unknown>; questions: Record<string, any>};
    assert.equal(JSON.stringify(sent).includes('batch-test-key'), false);
    assert.equal(JSON.stringify(sent).includes('[REDACTED]'), true);
    assert.deepEqual(Object.keys(sent.questions.route.criteria), ['inspect', 'repair', 'insufficient_evidence']);
    assert.equal(store.receipts.length, 1);
    assert.equal(JSON.stringify(store.receipts[0]).includes('Choose from the current'), false);
    assert.equal(JSON.stringify(store.receipts[0]).includes('batch-test-key'), false);
    assert.equal(JSON.stringify(store.receipts[0]).includes('"label":"high"'), false);
    assert.deepEqual(store.receipts[0]?.origin, {source: 'mcp', chatId: 'chat:123', turnId: 'turn:456'});
    assert.equal((store.receipts[0]?.policies as any).route.version, 'decision-policy-2026-09-26.1');
  });

  it('previews locally, rejects unsafe IDs and insufficient available candidates, and honors cancellation', async () => {
    let fetchCalls = 0;
    const store = new MemoryStore();
    const svc = service({store, fetchFn: async () => { fetchCalls += 1; throw new Error('no egress'); }});
    const preview = await svc.evaluateDecisions(input({mode: 'preview'}));
    assert.equal(preview.status, 'preview');
    assert.equal(fetchCalls, 0);
    assert.equal(store.reservations.length, 0);

    const unsafe = await svc.evaluateDecisions(input({questions: {
      'batch-test-key': {type: 'noul', instructions: 'Unsafe question ID'},
    }}));
    assert.deepEqual(unsafe, {status: 'skipped', reasonCode: 'unsafe_id'});

    const reservedCandidate = await svc.evaluateDecisions(input({questions: {route: {
      type: 'choice', instructions: 'Choose', candidates: [
        {id: 'insufficient_evidence', description: 'Caller collision'}, {id: 'other', description: 'Other'},
      ],
    }}}));
    assert.equal(reservedCandidate.reasonCode, 'unsafe_candidate_id');
    assert.equal(fetchCalls, 0);

    const singleCalls: Array<Record<string, unknown>> = [];
    const singleAvailable = await service({fetchFn: provider(singleCalls)}).evaluateDecisions(input({questions: {
      route: {type: 'choice', instructions: 'Choose', candidates: [
        {id: 'one', description: 'The sole caller candidate.'},
      ]},
    }}));
    assert.equal(singleAvailable.status, 'assessed');
    assert.equal(singleAvailable.answers?.route?.type === 'choice' && singleAvailable.answers.route.recommendation, 'one');
    assert.deepEqual(Object.keys((singleCalls[0] as any).questions.route.criteria), ['one', 'insufficient_evidence']);
    assert.equal(fetchCalls, 0);

    const emptyCandidates = await svc.evaluateDecisions(input({questions: {
      route: {type: 'choice', instructions: 'Choose', candidates: []},
    }}));
    assert.deepEqual(emptyCandidates, {status: 'skipped', reasonCode: 'invalid_input'});
    assert.equal(fetchCalls, 0);

    const cancelled = new AbortController();
    cancelled.abort();
    const cancellation = await svc.evaluateDecisions(input(), cancelled.signal);
    assert.equal(cancellation.reasonCode, 'cancelled');
    assert.equal(fetchCalls, 0);

    const deep: Record<string, unknown> = {};
    let cursor = deep;
    for (let index = 0; index < 20; index++) cursor = cursor.next = {} as Record<string, unknown>;
    const tooDeep = await svc.evaluateDecisions(input({state: deep}));
    assert.deepEqual(tooDeep, {status: 'skipped', reasonCode: 'invalid_input'});
  });

  it('includes correlation in cache identity and preserves credential rotation boundaries', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const svc = service({fetchFn: provider(calls)});
    const first = await svc.evaluateDecisions(input());
    const cached = await svc.evaluateDecisions(input());
    const distinct = await svc.evaluateDecisions(input({correlation: {requestId: 'request:two'}}));
    assert.equal(first.cached, undefined);
    assert.equal(cached.cached, true);
    assert.equal(distinct.cached, undefined);
    assert.equal(calls.length, 2);
  });

  it('uses the reserved evidence option as a neutral provider abstention', async () => {
    const result = await service({fetchFn: async (_url, init) => {
      const payload = JSON.parse(String(init?.body)) as {questions: {route: {criteria: Record<string, unknown>}}};
      assert.deepEqual(Object.keys(payload.questions.route.criteria), ['only', 'insufficient_evidence']);
      return new Response(JSON.stringify({
        model: 'jev-1.13.0',
        answers: {route: {type: 'choice', choice: 'insufficient_evidence', probabilities: {only: 0.08, insufficient_evidence: 0.92}, confidence: 0.94}},
        usage: {input_tokens: 8, output_tokens: 4},
      }));
    }}).evaluateDecisions(input({questions: {route: {
      type: 'choice', instructions: 'Choose only when directly supported.', domain: 'general',
      candidates: [{id: 'only', description: 'The only available action.'}, {id: 'offline', description: 'Unavailable.', available: false}],
    }}}));
    assert.equal(result.status, 'abstained');
    assert.equal(result.reasonCode, 'insufficient_evidence');
    assert.equal(result.answers?.route?.type === 'choice' && result.answers.route.providerChoice, 'insufficient_evidence');
    assert.equal(result.answers?.route?.type === 'choice' && result.answers.route.bestCandidate, 'only');
    assert.equal(result.answers?.route?.type === 'choice' && result.answers.route.recommendation, undefined);
  });
});
