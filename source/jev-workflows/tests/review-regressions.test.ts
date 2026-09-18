import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createService } from '../src/service.js';
import { redactText } from '../src/redact.js';
import { validateEvaluation } from '../src/provider.js';
import { failureQuestions } from '../src/contracts.js';
const input = {task:'Diagnose a test failure',command:'npm test',exitCode:1,output:'failed',evidence:[],mode:'evaluate'};
const evaluation = {model:'jev-1.13.0',usage:{input_tokens:50,output_tokens:10},answers:{
  category:{type:'choice',choice:'compile_error',confidence:1,probabilities:{compile_error:.2,assertion_failure:.16,missing_dependency:.16,unavailable_service:.16,permission_failure:.16,insufficient_evidence:.16}},
  reached_assertion:{type:'noul',noul:0},missing_context:{type:'noul',noul:1}
}};
test('common exported credentials and cookie headers are removed', () => {
  const output=redactText('AWS_SECRET_ACCESS_KEY=supersecretvalue\nNPM_TOKEN=npm_abcdefghijklmnopqrstuvwxyz\nCookie: session=private-cookie\nAWS_SESSION_TOKEN="session-secret"');
  for(const secret of ['supersecretvalue','npm_abcdefghijklmnopqrstuvwxyz','private-cookie','session-secret']) assert.equal(output.includes(secret),false);
});
test('diffuse probabilities cannot become confident advice', async () => {
  const service=createService({apiKey:'fake-key',store:{reserve:async()=>true,save:async()=>{}},fetchFn:async()=>new Response(JSON.stringify(evaluation))});
  const result=await service.classifyFailure(input);
  assert.equal(result.status,'abstained');
  assert.equal(result.workflow,'gather_evidence');
});
test('redacted evidence identifiers cannot collide or escape through receipts', async () => {
  let calls=0;
  const service=createService({apiKey:'fake-key',fetchFn:async()=>{calls++;throw new Error('must not call');}});
  for(const id of ['sk-abcdefghijklmnopqrstuv','sk-zyxwvutsrqponmlkjihgfe']) {
    const result=await service.classifyFailure({...input,evidence:[{id,text:'test evidence'}]});
    assert.deepEqual(result,{status:'skipped',reasonCode:'unsafe_evidence_id'});
  }
  assert.equal(calls,0);
});
test('a different provider model cannot masquerade as the pinned release', () => {
  assert.throws(()=>validateEvaluation({...evaluation,model:'jev-wrong'},failureQuestions));
});
