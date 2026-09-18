import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {configurePolicy, readPolicy} from '../src/policy.js';
import {createService} from '../src/service.js';

test('policy budget changes preserve existing usage and affect an already running service', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jev-budget-policy-'));
  const env = {PLUGIN_DATA: root};
  let calls = 0;
  try {
    await configurePolicy({enabled: false, maxCallsPerDay: 2}, env);
    const path = join(root, `budget-${new Date().toISOString().slice(0,10)}.json`);
    await writeFile(path, JSON.stringify({calls: 2, bytes: 100}));
    const service = createService({env, apiKey: 'fake-test-key', fetchFn: async () => {
      calls++;
      return new Response(JSON.stringify({model: 'jev-1.13.0', usage: {input_tokens: 1, output_tokens: 1}, answers: {decision: {type: 'choice', choice: 'a', probabilities: {a: 1,b: 0,insufficient_evidence: 0},confidence: 1}}}));
    }});
    const input = {domain: 'task',question:'Which candidate?',context:'Evidence supports a.',candidates:[{id:'a',description:'Supported'},{id:'b',description:'Unsupported'}], mode:'evaluate'};
    const exhausted = await service.classifyDecision(input);
    assert.equal(exhausted.reasonCode, 'budget_exhausted');
    assert.equal(exhausted.budget?.callsUsed, 2);
    assert.equal(calls, 0);
    await configurePolicy({enabled:false,maxCallsPerDay:3},env);
    assert.equal(service.status(await readPolicy(env)).maxCallsPerDay, 3);
    const admitted = await service.classifyDecision(input);
    assert.equal(admitted.status, 'assessed');
    assert.equal(calls, 1);
    const usage = JSON.parse(await readFile(path,'utf8'));
    assert.equal(usage.calls,3);
    assert.ok(usage.bytes > 100);
  } finally {await rm(root,{recursive:true,force:true});}
});
