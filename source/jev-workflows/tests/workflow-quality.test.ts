import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createService } from '../src/service.js';
import { assertNoSplitLeakage, loadDataset, prepareOutputDirectory, scoreAssessment, summarizeRows, type EvaluationRow } from '../scripts/workflow-quality-evaluate.js';

async function dataset(name = 'workflow-quality-v1.json') {
  return loadDataset(JSON.parse(await readFile(new URL(`../fixtures/${name}`, import.meta.url), 'utf8')));
}

describe('workflow quality fixture contract', () => {
  it('loads every domain in both frozen splits and all required hard-case tags', async () => {
    const fixture = await dataset();
    assert.equal(fixture.cases.length, 16);
    for (const split of ['development', 'heldout'] as const) {
      for (const domain of ['tool', 'model', 'task', 'skill', 'context', 'strategy', 'result', 'general']) {
        assert.ok(fixture.cases.some(item => item.split === split && item.domain === domain), `${split}/${domain}`);
      }
    }
    const tags = new Set(fixture.cases.flatMap(item => item.tags));
    for (const tag of ['no_available_choice', 'changed_goal', 'missing_evidence', 'misleading_success', 'close_alternatives', 'adversarial_state', 'real_capability_constraints']) assert.ok(tags.has(tag), tag);
  });

  it('rejects exact input reuse across development and heldout without encoding fixture labels', async () => {
    const fixture = await dataset();
    assert.doesNotThrow(() => assertNoSplitLeakage(fixture.cases));
    const development = fixture.cases.find(item => item.split === 'development')!;
    const heldout = {...development, id: `${development.id}-copy`, split: 'heldout' as const};
    assert.throws(() => assertNoSplitLeakage([...fixture.cases, heldout]), /duplicates a development input/);
  });

  it('loads the fresh v2 fixture through the same independent-label contract', async () => {
    const fixture = await dataset('workflow-quality-v2.json');
    assert.equal(fixture.labelPolicyVersion, 'independent-choice-v2');
    assert.equal(fixture.cases.length, 16);
    assert.ok(fixture.cases.some(item => item.tags.includes('explicit_unknown_evidence')));
    assert.ok(fixture.cases.some(item => item.tags.includes('contradictory_signals')));
    assert.ok(fixture.cases.some(item => item.tags.includes('action_vs_authority')));
    assert.ok(fixture.cases.some(item => item.tags.includes('single_available')));
  });
});

describe('workflow quality scoring', () => {
  it('scores a required abstention and a multi-answer close alternative independently', async () => {
    const fixture = await dataset();
    const abstentionCase = fixture.cases.find(item => item.label.requiredAbstention)!;
    const closeCase = fixture.cases.find(item => item.label.acceptableChoices.length > 1)!;
    assert.deepEqual(scoreAssessment(abstentionCase, {status: 'abstained'}), {
      evaluated: true,
      predictedChoice: null,
      abstained: true,
      correct: true,
      falseConfident: false,
    });
    assert.equal(scoreAssessment(closeCase, {status: 'assessed', choice: closeCase.label.acceptableChoices[1]}).correct, true);
    assert.equal(scoreAssessment(closeCase, {status: 'assessed', choice: 'unsupported-choice'}).falseConfident, true);
  });

  it('does not report preview rows as accuracy and counts only provider evidence in request metrics', async () => {
    const fixture = await dataset();
    const first = fixture.cases[0]!;
    const previewRow: EvaluationRow = {
      id: first.id,
      split: first.split,
      domain: first.domain,
      tags: first.tags,
      expected: first.label,
      result: {status: 'preview', preview: {}, receiptPersisted: false},
      score: scoreAssessment(first, {status: 'preview'}),
    };
    const liveRow: EvaluationRow = {
      ...previewRow,
      id: `${first.id}-live`,
      result: {
        status: 'assessed', choice: first.label.acceptableChoices[0], latencyMs: 12,
        usage: {input_tokens: 20, output_tokens: 8},
        transport: {
          requestStartedAt: '2026-09-26T00:00:00.000Z', fetchInvoked: true, attempts: 1,
          responseReceivedAt: '2026-09-26T00:00:00.010Z', responseStatus: 200,
          retryAfter: null,
          validatedResponse: true, providerRequestId: 'req-quality-test', providerRequestIdHeader: 'x-typesafe-request-id', credentialFingerprint: 'fingerprint',
        },
      },
      score: scoreAssessment(first, {status: 'assessed', choice: first.label.acceptableChoices[0]}),
    };
    const preview = summarizeRows([previewRow], 'preview');
    assert.equal(preview.scoredCases, 0);
    assert.equal(preview.independentLabelAccuracy, null);
    assert.equal(preview.requestEvidence.attempted, 0);
    const live = summarizeRows([liveRow], 'live');
    assert.equal(live.independentLabelAccuracy, 1);
    assert.equal(live.requestEvidence.validatedResponses, 1);
    assert.deepEqual(live.requestEvidence.providerRequestIds, ['req-quality-test']);
    assert.deepEqual(live.tokenEstimates, {count: 1, input: 20, output: 8, note: 'Provider usage fields are retained estimates for this run, not billing.'});
  });
});

describe('workflow quality preview boundary', () => {
  it('uses the real createService preview path without egress by default', async () => {
    const fixture = await dataset();
    let fetchCalls = 0;
    const service = createService({apiKey: 'workflow-quality-test-key', fetchFn: async () => { fetchCalls++; throw new Error('preview egress'); }});
    const result = await service.classifyDecision(fixture.cases[0]!.input);
    assert.equal(result.status, 'preview');
    assert.equal(fetchCalls, 0);
  });

  it('reserves a fresh output directory before a run and rejects reruns', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'jev-workflow-quality-'));
    const output = join(parent, 'nested', 'results');
    try {
      assert.equal(await prepareOutputDirectory(output), output);
      await assert.rejects(() => prepareOutputDirectory(output), /Results already exist/);
    } finally {
      await rm(parent, {recursive: true, force: true});
    }
  });
});
