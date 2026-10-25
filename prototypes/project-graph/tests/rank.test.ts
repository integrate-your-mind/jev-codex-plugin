import assert from 'node:assert/strict';
import {describe, it} from 'node:test';
import {Ranker} from '../src/rank.js';
import type {GraphNode, RankContext} from '../src/types.js';

function node(nodeId: string, name: string, excerpt: string): GraphNode {
  return {key: nodeId, nodeId, kind: 'symbol', path: `${name}.ts`, name, symbolKind: 'FunctionDeclaration', signature: `function ${name}()`, excerpt, span: {start: 0, end: excerpt.length, line: 1, column: 1}, contentHash: nodeId};
}

const context: RankContext = {operation: 'search', objective: 'repair token rotation', query: 'credential token cache', visitedNodeIds: [], graphVersion: 'version', packetSeed: 'a'.repeat(64)};

describe('ranking arms', () => {
  it('uses validated independent Jev scores without exposing provider fields in nodes', async () => {
    const nodes = [node('a', 'unrelated', 'renders a button'), node('b', 'credentialCache', 'rotates cached tokens')];
    const ranker = new Ranker('jev', async input => {
      const body = input as {questions: Record<string, unknown>; state: {candidates: unknown[]}};
      assert.deepEqual(Object.keys(body.questions), ['node_000', 'node_001']);
      assert.equal(body.state.candidates.length, 2);
      assert.equal(JSON.stringify(body.questions).includes('rotates cached tokens'), false);
      return {
        status: 'assessed', receiptId: 'receipt-1', model: 'jev-1.13.0', latencyMs: 17,
        usage: {input_tokens: 50, output_tokens: 4},
        transport: {fetchInvoked: true, responseStatus: 200, validatedResponse: true, providerRequestId: 'provider-1', providerRequestIdHeader: 'request-id'},
        answers: {
          node_000: {type: 'score', score: 1, disposition: 'ranking'},
          node_001: {type: 'score', score: 4, disposition: 'ranking'},
        },
      };
    });
    const result = await ranker.rank(nodes, context);
    assert.deepEqual(result.nodes.map(item => item.nodeId), ['b', 'a']);
    assert.equal(result.audit.appliedArm, 'jev');
    assert.deepEqual(result.audit.providerReceiptIds, ['receipt-1']);
    assert.deepEqual(result.audit.providerTransports, [{requestStartedAt: undefined, fetchInvoked: true, responseReceivedAt: undefined, responseStatus: 200, validatedResponse: true, providerRequestId: 'provider-1', providerRequestIdHeader: 'request-id'}]);
    assert.equal(JSON.stringify(result.nodes).includes('confidence'), false);
  });

  it('falls back to exactly the cheap order after unavailable or invalid Jev output', async () => {
    const nodes = [node('a', 'unrelated', 'renders a button'), node('b', 'credentialCache', 'rotates cached token credentials')];
    const cheap = await new Ranker('cheap').rank(nodes, context);
    const unavailable = await new Ranker('jev', async () => ({status: 'unavailable', reasonCode: 'timeout', receiptId: 'receipt-timeout'})).rank(nodes, context);
    assert.deepEqual(unavailable.nodes.map(item => item.nodeId), cheap.nodes.map(item => item.nodeId));
    assert.equal(unavailable.audit.requestedArm, 'jev');
    assert.equal(unavailable.audit.appliedArm, 'cheap');
    assert.match(unavailable.audit.fallbackReason ?? '', /jev_unavailable_timeout/);
    assert.deepEqual(unavailable.audit.providerReceiptIds, ['receipt-timeout']);
  });

  it('redacts generic credentials from cards, objectives, and queries before Jev sees them', async () => {
    const secret = 'sk-testcredential1234567890';
    const nodes = [node('a', 'credential', `const API_KEY = "${secret}";`)];
    let transmitted = '';
    await new Ranker('jev', async input => {
      transmitted = JSON.stringify(input);
      return {status: 'assessed', answers: {node_000: {type: 'score', score: 2, disposition: 'ranking'}}};
    }).rank(nodes, {...context, objective: `repair api_key=${secret}`, query: `token=${secret}`});
    assert.equal(transmitted.includes(secret), false);
    assert.equal(transmitted.includes('[REDACTED]'), true);
  });
});
