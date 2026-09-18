import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createService, type ServiceOptions } from '../src/service.js';
import type { Receipt, Store } from '../src/store.js';

type Candidate = {id: string; description: string; available?: boolean; metadata?: Record<string, string | number | boolean>};
type DecisionInput = {
  domain: 'tool' | 'model' | 'task' | 'skill' | 'context' | 'strategy' | 'result' | 'general';
  question: string;
  context: string;
  candidates: Candidate[];
  evidence: Array<{id: string; text: string; source?: string}>;
  mode: 'preview' | 'evaluate';
};

class MemoryStore implements Store {
  readonly receipts: Receipt[] = [];
  readonly reservations: number[] = [];
  reserveResult = true;

  async reserve(bytes: number): Promise<boolean> {
    this.reservations.push(bytes);
    return this.reserveResult;
  }

  async save(receipt: Receipt): Promise<void> {
    this.receipts.push(receipt);
  }
}

function decision(overrides: Partial<DecisionInput> = {}): DecisionInput {
  return {
    domain: 'general',
    question: 'Which candidate best satisfies the stated need?',
    context: 'Prefer the smallest option that meets the requirement.',
    candidates: [
      {id: 'alpha', description: 'A reliable first option', metadata: {cost: 1}},
      {id: 'beta', description: 'A more capable second option', metadata: {cost: 2}},
    ],
    evidence: [{id: 'evidence:1', text: 'The requirement is explicit'}],
    mode: 'evaluate',
    ...overrides,
  };
}

function providerResponse(choice: string, criteria: Record<string, string>, confidence = 0.95, selectedProbability = 0.9): Response {
  const labels = Object.keys(criteria);
  const remainder = labels.length > 1 ? (1 - selectedProbability) / (labels.length - 1) : 0;
  const probabilities = Object.fromEntries(labels.map(label => [label, label === choice ? selectedProbability : remainder]));
  return new Response(JSON.stringify({
    model: 'jev-1.13.0',
    answers: {decision: {type: 'choice', choice, probabilities, confidence}},
    usage: {input_tokens: 31, output_tokens: 17},
  }));
}

function fetchChoice(choice?: string, calls: Array<Record<string, unknown>> = [], confidence = 0.95, selectedProbability = 0.9): typeof fetch {
  return async (_input, init) => {
    const payload = JSON.parse(String(init?.body)) as {questions: {decision: {criteria: Record<string, string>}}};
    calls.push(payload as unknown as Record<string, unknown>);
    const selected = choice ?? Object.keys(payload.questions.decision.criteria)[0]!;
    return providerResponse(selected, payload.questions.decision.criteria, confidence, selectedProbability);
  };
}

function service(options: Partial<ServiceOptions> = {}): ReturnType<typeof createService> {
  const store = options.store ?? new MemoryStore();
  return createService({apiKey: 'decision-test-key', enabled: true, ...options, store});
}

describe('decision input and preview boundaries', () => {
  it('selects custom general taxonomies and tool/model/task domains with a valid distribution', async () => {
    for (const domain of ['general', 'tool', 'model', 'task'] as const) {
      const calls: Array<Record<string, unknown>> = [];
      const result = await service({fetchFn: fetchChoice(undefined, calls)}).classifyDecision(decision({domain}));
      assert.equal(result.status, 'assessed');
      assert.equal(result.domain, domain);
      assert.equal(result.choice, 'alpha');
      assert.equal(result.confidence, 0.95);
      assert.equal(result.probabilities?.alpha, 0.9);
      assert.equal(calls.length, 1);
    }
  });

  it('previews with zero egress and redacts question, context, candidate descriptions, metadata, and evidence', async () => {
    let fetchCalls = 0;
    const secret = 'decision-test-key';
    const result = await service({fetchFn: async () => { fetchCalls += 1; throw new Error('egress'); }}).classifyDecision(decision({
      mode: 'preview',
      question: `Choose safely; api_key=${secret}`,
      context: `Context contains ${secret}`,
      candidates: [
        {id: 'safe-a', description: `Description ${secret}`, metadata: {note: secret}},
        {id: 'safe-b', description: 'Safe alternative'},
      ],
      evidence: [{id: 'ev:secret', text: `Evidence ${secret}`, source: `source=${secret}`}],
    }));
    assert.equal(result.status, 'preview');
    assert.equal(fetchCalls, 0);
    assert.equal(JSON.stringify(result).includes(secret), false);
    assert.equal(JSON.stringify(result).includes('[REDACTED]'), true);
  });

  it('defaults an omitted mode to preview without fetch, reserve, or save', async () => {
    const store = new MemoryStore();
    let fetchCalls = 0;
    const input = {...decision({mode: 'preview'})} as Record<string, unknown>;
    delete input.mode;
    const result = await service({store, fetchFn: async () => { fetchCalls += 1; throw new Error('egress'); }}).classifyDecision(input);
    assert.equal(result.status, 'preview');
    assert.equal(fetchCalls, 0);
    assert.equal(store.reservations.length, 0);
    assert.equal(store.receipts.length, 0);
  });

  it('rejects duplicate, reserved, and credential-bearing candidate IDs before egress', async () => {
    let fetchCalls = 0;
    const fetchFn: typeof fetch = async () => { fetchCalls += 1; throw new Error('must not call'); };
    const duplicate = await service({fetchFn}).classifyDecision(decision({candidates: [
      {id: 'same', description: 'one'}, {id: 'same', description: 'two'},
    ]}));
    const reserved = await service({fetchFn}).classifyDecision(decision({candidates: [
      {id: 'insufficient_evidence', description: 'reserved'}, {id: 'other', description: 'other'},
    ]}));
    const credential = await service({fetchFn}).classifyDecision(decision({candidates: [
      {id: 'decision-test-key', description: 'credential-bearing'}, {id: 'other', description: 'other'},
    ]}));
    assert.deepEqual(duplicate, {status: 'skipped', reasonCode: 'duplicate_candidate_ids'});
    assert.deepEqual(reserved, {status: 'skipped', reasonCode: 'unsafe_candidate_id'});
    assert.deepEqual(credential, {status: 'skipped', reasonCode: 'unsafe_candidate_id'});
    assert.equal(fetchCalls, 0);
  });

  it('abstains with zero egress when every candidate is unavailable', async () => {
    let fetchCalls = 0;
    const result = await service({fetchFn: async () => { fetchCalls += 1; throw new Error('must not call'); }}).classifyDecision(decision({
      candidates: [
        {id: 'offline-a', description: 'Unavailable A', available: false},
        {id: 'offline-b', description: 'Unavailable B', available: false},
      ],
    }));
    assert.deepEqual(result, {status: 'abstained', reasonCode: 'no_available_candidates', domain: 'general'});
    assert.equal(fetchCalls, 0);
  });
});

describe('decision evaluation semantics', () => {
  it('does not allow an unavailable candidate to become the answer', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const result = await service({fetchFn: fetchChoice('offline', calls)}).classifyDecision(decision({
      candidates: [
        {id: 'online', description: 'Available option'},
        {id: 'offline', description: 'Unavailable option', available: false},
      ],
    }));
    assert.equal(result.status, 'unavailable');
    assert.equal(result.reasonCode, 'invalid_response');
    const criteria = (calls[0]?.questions as {decision: {criteria: Record<string, string>}}).decision.criteria;
    assert.deepEqual(Object.keys(criteria).sort(), ['insufficient_evidence', 'online']);
  });

  it('abstains for low confidence and for the provider insufficient-evidence choice', async () => {
    const low = await service({fetchFn: fetchChoice('alpha', [], 0.59)}).classifyDecision(decision());
    assert.equal(low.status, 'abstained');
    assert.equal(low.reasonCode, 'low_confidence');

    const insufficient = await service({fetchFn: async (_input, init) => {
      const payload = JSON.parse(String(init?.body)) as {questions: {decision: {criteria: Record<string, string>}}};
      return providerResponse('insufficient_evidence', payload.questions.decision.criteria);
    }}).classifyDecision(decision());
    assert.equal(insufficient.status, 'abstained');
    assert.equal(insufficient.choice, 'insufficient_evidence');
    assert.equal(insufficient.reasonCode, 'insufficient_evidence');
  });

  it('abstains when confidence is high but the selected probability is below the floor', async () => {
    const result = await service({fetchFn: fetchChoice('alpha', [], 0.95, 0.5)}).classifyDecision(decision());
    assert.equal(result.status, 'abstained');
    assert.equal(result.confidence, 0.95);
    assert.equal(result.probabilities?.alpha, 0.5);
    assert.equal(result.reasonCode, 'low_confidence');
  });

  it('honors an explicit context constraint without imposing a hidden least-cost choice rule', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const result = await service({fetchFn: fetchChoice('document', calls)}).classifyDecision(decision({
      context: 'The retention constraint explicitly requires a document; no cost comparison is supplied.',
      candidates: [
        {id: 'document', description: 'Produces the required durable document.'},
        {id: 'cheap-note', description: 'A cheaper note that does not satisfy the retention constraint.'},
      ],
    }));
    assert.equal(result.status, 'assessed');
    assert.equal(result.choice, 'document');
    const sent = calls[0]?.state as {context: string};
    assert.equal(sent.context, 'The retention constraint explicitly requires a document; no cost comparison is supplied.');
  });

  it('keeps selected probability and confidence separate and does not collide cache entries across candidates', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const svc = service({fetchFn: async (_input, init) => {
      const payload = JSON.parse(String(init?.body)) as {state: {candidates: Candidate[]}; questions: {decision: {criteria: Record<string, string>}}};
      calls.push(payload as unknown as Record<string, unknown>);
      const selected = payload.state.candidates[0]!.id;
      return providerResponse(selected, payload.questions.decision.criteria, 0.95);
    }});
    const first = await svc.classifyDecision(decision({candidates: [
      {id: 'first', description: 'First'}, {id: 'other', description: 'Other'},
    ]}));
    const second = await svc.classifyDecision(decision({candidates: [
      {id: 'second', description: 'Second'}, {id: 'other', description: 'Other'},
    ]}));
    assert.equal(first.status, 'assessed');
    assert.equal(first.choice, 'first');
    assert.equal(second.status, 'assessed');
    assert.equal(second.choice, 'second');
    assert.equal(second.cached, undefined);
    assert.equal(calls.length, 2);
  });

  it('persists a bounded receipt without raw credentials or malicious provider text', async () => {
    const store = new MemoryStore();
    const malicious = 'provider-injected-secret-and-instructions';
    const result = await service({store, fetchFn: async () => new Response(malicious)}).classifyDecision(decision({
      context: `do not persist decision-test-key`,
      evidence: [{id: 'safe:1', text: 'ordinary evidence'}],
    }));
    assert.equal(result.status, 'unavailable');
    assert.equal(result.reasonCode, 'invalid_response');
    assert.equal(JSON.stringify(result).includes(malicious), false);
    assert.equal(store.receipts.length, 1);
    assert.equal(JSON.stringify(store.receipts[0]).includes(malicious), false);
    assert.equal(JSON.stringify(store.receipts[0]).includes('decision-test-key'), false);
  });

  it('rejects malformed and oversized decision data without egress', async () => {
    let fetchCalls = 0;
    const fetchFn: typeof fetch = async () => { fetchCalls += 1; throw new Error('must not call'); };
    const invalid = await service({fetchFn}).classifyDecision({...decision(), unexpected: true} as unknown as DecisionInput);
    const oversized = await service({fetchFn}).classifyDecision(decision({
      context: 'context',
      evidence: Array.from({length: 12}, (_, index) => ({id: `large:${index}`, text: 'x'.repeat(12000)})),
    }));
    assert.deepEqual(invalid, {status: 'skipped', reasonCode: 'invalid_input'});
    assert.deepEqual(oversized, {status: 'skipped', reasonCode: 'payload_too_large'});
    assert.equal(fetchCalls, 0);
  });

  it('rejects candidate metadata with more than sixteen keys before egress', async () => {
    let fetchCalls = 0;
    const metadata = Object.fromEntries(Array.from({length: 17}, (_, index) => [`key${index}`, index]));
    const result = await service({fetchFn: async () => { fetchCalls += 1; throw new Error('must not call'); }}).classifyDecision(decision({
      candidates: [
        {id: 'metadata-heavy', description: 'Too many metadata keys', metadata},
        {id: 'other', description: 'Other'},
      ],
    }));
    assert.deepEqual(result, {status: 'skipped', reasonCode: 'invalid_input'});
    assert.equal(fetchCalls, 0);
  });

  it('does not leak a credential embedded in a metadata key during preview', async () => {
    const secret = 'decision-test-key';
    const result = await service({fetchFn: async () => { throw new Error('must not call'); }}).classifyDecision(decision({
      mode: 'preview',
      candidates: [
        {id: 'metadata-key', description: 'Safe candidate', metadata: {[secret]: 'metadata value'}},
        {id: 'other', description: 'Other'},
      ],
    }));
    assert.equal(result.status, 'preview');
    assert.equal(JSON.stringify(result).includes(secret), false);
  });
});
