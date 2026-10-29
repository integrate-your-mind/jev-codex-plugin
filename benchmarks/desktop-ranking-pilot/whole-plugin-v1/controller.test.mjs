import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile, writeFile, mkdir, mkdtemp, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {ARMS, TASK_IDS, freezeStudy, hash, reduceEvent, deadlines} from './controller.mjs';
import {summarizeStudy, exportCsv} from './report.mjs';
import {main, readStudy} from './cli.mjs';
import {prepareNativeLaunch, validateLaunchContract, renderPromptTemplate, dispatchPreparedNativeLaunch} from './launch.mjs';

const json = async path => JSON.parse(await readFile(new URL(path, import.meta.url), 'utf8'));
const corpus = await json('../corpus-2026-10-28.json');
const reservations = await json('../reservations-2026-10-28.json');
const preflights = await json('../preparation-2026-10-28-attempt-5/qualified-preflights-2026-10-28.json');
const evidence = hash('synthetic evidence, never a pilot observation');
const origin = Date.parse('2026-10-28T12:00:00Z');
function manifest() {
  return {schemaVersion: 'whole-plugin-pilot-v1', studyId: 'synthetic-controller-tests', privacy: 'private',
    host: {kind: 'codex-desktop', model: 'gpt-6.1-sol', effort: 'ultra', appVersion: null, backendVersion: null, settingsEvidenceHash: evidence},
    arms: Object.fromEntries(ARMS.map(arm => { const enabled = arm === 'plugin-on'; return [arm, {
      pluginEnabled: enabled, mode: enabled ? 'changed_state' : 'off', tools: enabled ? 'normal' : 'absent',
      hooks: enabled ? 'normal' : 'absent', guidance: enabled ? 'normal' : 'absent', adviceConnection: enabled,
      configurationHash: evidence, packageHash: enabled ? evidence : null,
    }]; })), corpus:structuredClone(corpus), reservations:structuredClone(reservations), preflights:structuredClone(preflights), preflightHash: hash(preflights),
    policy: {codingMs: 2100000, gradingMs: 600000, totalMs: 2700000, attempts: 18, interimAfter: 3,
      retrieval: {method:'bm25',k1:1.2,b:0.75,maxBytes:16384,maxCandidates:254,source:'frozen-broken-base',tieBreak:'stable-id'}},
    tasks: corpus.tasks.map(task => ({...task, inputHash: evidence, publicFailureHash: evidence, cheapPacketHash: evidence,
      graderHash: preflights.find(row => row.taskId === task.id).graderHash})),
  };
}
function event(state, type, milliseconds, extra = {}) {
  const slot = state.slots.find(row => ['CODING', 'GRADING'].includes(row.status)) ?? state.slots.find(row => row.status === 'NOTSTARTED') ?? state.slots.at(-1);
  return {id: `synthetic-${state.events.length}`, type, slotId: slot.id, at: new Date(origin + milliseconds).toISOString(), manifestHash: state.manifestHash, ...extra};
}
const apply = (state, type, at, extra) => reduceEvent(state, event(state, type, at, extra));
function identify(state, at) {
  const slot = state.slots.find(row => row.status === 'CODING');
  return apply(state, 'identity', at, {chatId: `private-chat-${slot.id}`, workspaceId: 'private-workspace', model: 'gpt-6.1-sol', effort: 'ultra',
    baseRevision: state.manifest.tasks.find(task => task.id === slot.taskId).baseRevision, exposure: state.manifest.arms[slot.arm], evidenceHash: evidence});
}
function finish(state, at, verdict = 'verified-fix') {
  const slot = state.slots.find(row => row.status === 'CODING');
  state = identify(state, at);
  if (slot.arm === 'cheap') state = apply(state, 'retrieval', at + 1, {packetHash: evidence, evidenceHash: evidence});
  state = apply(state, 'coding_ended', at + 10, {patchHash: evidence, reason: 'completed', evidenceHash: evidence});
  return apply(state, 'graded', at + 20, {patchHash: evidence, graderHash: state.manifest.tasks.find(task => task.id === slot.taskId).graderHash, verdict, healthy: true, evidenceHash: evidence});
}
function firstThree() {
  let state = freezeStudy(manifest());
  for (let index = 0; index < 3; index++) { state = apply(state, 'start', index * 100, {evidenceHash: evidence}); state = finish(state, index * 100 + 1); }
  return state;
}

test('synthetic schedule keeps six tasks, eighteen slots and every counterbalanced order', () => {
  const state = freezeStudy(manifest());
  assert.deepEqual(state.manifest.tasks.map(task => task.id), TASK_IDS);
  assert.equal(state.slots.length, 18);
  assert.equal(new Set(Array.from({length: 6}, (_, i) => state.slots.slice(i * 3, i * 3 + 3).map(row => row.arm).join(','))).size, 6);
  assert.equal(Object.isFrozen(state.slots[0]), true);
});

test('start intent counts startup before chat identity and failed integration consumes one slot', () => {
  let state = freezeStudy(manifest());
  state = apply(state, 'start', 0, {evidenceHash: evidence});
  assert.equal(state.slots[0].chatId, null);
  state = apply(state, 'integration_failed', 20, {reason: 'synthetic startup failure', evidenceHash: evidence});
  assert.equal(state.slots[0].verdict, 'infrastructure-invalid');
  assert.throws(() => apply(state, 'start', 30, {slotId: state.slots[0].id, evidenceHash: evidence}), /once/);
  state = apply(state, 'start', 30, {evidenceHash: evidence});
  assert.equal(state.slots[1].status, 'CODING');
});

test('actual loaded source, profile and exposure mismatch halts scoring without replacement', () => {
  for (const patch of [{model: 'other'}, {effort: 'low'}, {baseRevision: 'different'}, {exposure: manifest().arms['plugin-on']}]) {
    let state = freezeStudy(manifest()); state = apply(state, 'start', 0, {evidenceHash: evidence});
    const identity = event(state, 'identity', 1, {chatId: 'chat', workspaceId: 'workspace', model: 'gpt-6.1-sol', effort: 'ultra',
      baseRevision: manifest().tasks[0].baseRevision, exposure: manifest().arms['plugin-off'], evidenceHash: evidence, ...patch});
    state = reduceEvent(state, identity);
    assert.equal(state.halted.reason, 'native-profile-source-or-exposure-broke');
    assert.throws(() => apply(state, 'start', 2, {evidenceHash: evidence}), /Scoring stopped/);
  }
});

test('coding and independent grading deadlines include startup and waits', () => {
  let state = freezeStudy(manifest()); state = apply(state, 'start', 0, {evidenceHash: evidence});
  assert.equal(deadlines(state).codingStopsAt, new Date(origin + 2100000).toISOString());
  state = apply(state, 'tick', 2100001);
  assert.equal(state.halted.reason, 'clock-limit-breached');
  let graded = freezeStudy(manifest()); graded = apply(graded, 'start', 0, {evidenceHash: evidence}); graded = identify(graded, 1);
  graded = apply(graded, 'coding_ended', 100, {patchHash: evidence, reason: 'completed', evidenceHash: evidence});
  assert.equal(deadlines(graded).gradingStopsAt, new Date(origin + 600100).toISOString());
  graded = apply(graded, 'tick', 600101);
  assert.equal(graded.halted.reason, 'clock-limit-breached');
});

test('wrong patch, grader, missing actual identity and missing cheap delivery cannot pass', () => {
  let state = freezeStudy(manifest()); state = apply(state, 'start', 0, {evidenceHash: evidence});
  state = apply(state, 'coding_ended', 10, {patchHash: evidence, reason: 'completed', evidenceHash: evidence});
  const grade = {patchHash: evidence, graderHash: manifest().tasks[0].graderHash, verdict: 'verified-fix', healthy: true, evidenceHash: evidence};
  assert.throws(() => apply(state, 'graded', 20, grade), /actual native identity/);
  state = apply(state, 'identity', 21, {chatId:'chat', workspaceId:'workspace', model:'gpt-6.1-sol', effort:'ultra', baseRevision:manifest().tasks[0].baseRevision, exposure:manifest().arms['plugin-off'], evidenceHash:evidence});
  assert.throws(() => apply(state, 'graded', 22, {...grade, patchHash: hash('wrong')}), /retained patch/);
  assert.throws(() => apply(state, 'graded', 22, {...grade, graderHash: hash('wrong')}), /retained patch/);
  state = apply(state, 'graded', 22, grade); state = apply(state, 'start', 30, {evidenceHash:evidence}); state = identify(state,31);
  state = apply(state, 'coding_ended', 40, {patchHash:evidence,reason:'completed',evidenceHash:evidence});
  assert.throws(() => apply(state,'graded',50,grade), /timed evidence packet/);
});

test('normal ON consultation outages and multiple delivered decisions retain separate uptake', () => {
  let state = freezeStudy(manifest());
  for (let index = 0; index < 2; index++) { state=apply(state,'start',index*100,{evidenceHash:evidence}); state=finish(state,index*100+1); }
  state=apply(state,'start',200,{evidenceHash:evidence});
  for (const [i,status] of ['unavailable','abstained','assessed'].entries()) state=apply(state,'consultation',201+i,{consultationId:`synthetic-${status}`,status,providerInvoked:i===0?null:true,delivered:i===2,receiptHash:i?evidence:null,evidenceHash:evidence});
  state=apply(state,'uptake',205,{consultationId:'synthetic-assessed',value:'observed',evidenceHash:evidence});
  assert.throws(()=>apply(state,'uptake',206,{consultationId:'synthetic-unavailable',value:'observed',evidenceHash:evidence}),/actually delivered/);
  state=finish(state,210);
  const arm=summarizeStudy(state).arms[2];
  assert.equal(arm.consultations,3); assert.equal(arm.providerRequests,2); assert.equal(arm.providerRequestUnknown,1); assert.equal(arm.uptakeObserved,1);
  let off=freezeStudy(manifest()); off=apply(off,'start',0,{evidenceHash:evidence});
  off=apply(off,'consultation',1,{consultationId:'bad',status:'assessed',providerInvoked:true,delivered:true,receiptHash:evidence,evidenceHash:evidence});
  assert.equal(off.halted.reason,'jev-exposure-in-disabled-arm');
});

test('first real comparison artifacts must be retained before attempt four', () => {
  let state=firstThree();
  assert.throws(()=>apply(state,'start',400,{evidenceHash:evidence}),/first-three interim/);
  state=apply(state,'interim_report',400,{reportHash:evidence,artifactsHash:evidence,evidenceHash:evidence});
  state=apply(state,'start',401,{evidenceHash:evidence});
  assert.equal(state.slots[3].status,'CODING');
});

test('reports retain unsuccessful elapsed, actual completed denominators and pending unknowns', () => {
  let state=freezeStudy(manifest());
  const empty=summarizeStudy(state); assert.equal(empty.arms[0].fixRate,null); assert.deepEqual(empty.curves['plugin-off'],[]);
  state=apply(state,'start',0,{evidenceHash:evidence}); state=finish(state,1,'not-fixed');
  state=apply(state,'start',100,{evidenceHash:evidence});
  const report=summarizeStudy(state,new Date(origin+150).toISOString());
  assert.equal(report.completedAttempts,1); assert.equal(report.pendingAttempts,17);
  assert.equal(report.arms[0].completed,1); assert.equal(report.arms[0].verifiedFixes,0); assert.equal(report.arms[0].timePerVerifiedFixMs,null);
  assert.equal(report.arms[1].elapsedMs,50); assert.deepEqual(report.curves.cheap,[]);
  assert.deepEqual(report.curves['plugin-off'],[{elapsedMs:0,verifiedFixes:0},{elapsedMs:21,verifiedFixes:0}]);
  assert.equal(report.arms[0].codingUsd,null); assert.equal(report.interpretation.verdict,'inconclusive');
  assert.throws(()=>summarizeStudy(state,new Date(origin+99).toISOString()),/precedes/);
});

test('public exports omit native private identities and retain unknown billing and observed usage', () => {
  let state=freezeStudy(manifest()); state=apply(state,'start',0,{evidenceHash:evidence}); state=finish(state,1);
  const slotId=state.slots[0].id;
  state=apply(state,'usage',30,{slotId,inputTokens:100,outputTokens:20,cachedInputTokens:null,evidenceHash:evidence});
  state=apply(state,'billing',31,{slotId,codingUsd:null,jevUsd:0,complete:false,subscriptionCapacity:null,evidenceHash:evidence});
  assert.throws(()=>apply(state,'usage',32,{slotId,inputTokens:200,outputTokens:30,cachedInputTokens:null,evidenceHash:evidence}),/one observed/);
  const report=summarizeStudy(state), output=JSON.stringify(report)+Object.values(exportCsv(report)).join('');
  assert.doesNotMatch(output,/private-chat|private-workspace|settingsEvidenceHash|referencePatchHash|evidenceHash/);
  assert.equal(report.arms[0].usage.inputTokens,100); assert.equal(report.arms[0].jevUsd,0); assert.equal(report.arms[0].codingUsd,null);
  assert.match(exportCsv(report)['summary.csv'],/codingUsd,jevUsd,billingComplete/);
});

test('immutable native event replay rejects tampering, gaps and unpublished partial files', async () => {
  const parent=new URL('../../../.agent-work/whole-plugin-tests/',import.meta.url);
  await mkdir(parent,{recursive:true}); const directory=await mkdtemp(join(parent.pathname,'synthetic-'));
  try {
    const manifestPath=join(directory,'manifest.json'), run=join(directory,'run');
    await writeFile(manifestPath,JSON.stringify(manifest())); await main(['freeze',manifestPath,run]);
    let state=await readStudy(run); const start=event(state,'start',0,{evidenceHash:evidence}); const eventPath=join(directory,'start.json');
    await writeFile(eventPath,JSON.stringify(start)); await main(['record',run,eventPath]);
    assert.equal((await readStudy(run)).slots[0].status,'CODING');
    await assert.rejects(main(['record',run,eventPath]),/Event ID/);
    const bad=join(run,'events','0002.json'); await writeFile(bad,'{'); await assert.rejects(readStudy(run)); await rm(bad);
    await writeFile(join(run,'events','0003.json'),'{}'); await assert.rejects(readStudy(run),/Event gap/); await rm(join(run,'events','0003.json'));
    const exportDirectory=join(directory,'export'); await main(['export',run,exportDirectory]);
    assert.equal(JSON.parse(await readFile(join(exportDirectory,'report.json'),'utf8')).pendingAttempts,18);
    await assert.rejects(main(['export',run,exportDirectory]),/EEXIST/);
  } finally { await rm(directory,{recursive:true,force:true}); }
});

test('frozen source, retrieval parameters and private event fields cannot silently change', () => {
  for (const mutate of [value=>{value.tasks[0].baseRevision='changed';},value=>{value.policy.retrieval.b=0.9;},value=>{value.host.model='different';},value=>{value.preflights[0].controls.wrong.verdict='pass';}]) {
    const input=manifest(); mutate(input); assert.throws(()=>freezeStudy(input));
  }
  const state=freezeStudy(manifest());
  assert.throws(()=>apply(state,'start',0,{evidenceHash:evidence,transcript:'private material'}),/private event fields/);
  assert.throws(()=>apply(state,'start',0,{evidenceHash:evidence,manifestHash:hash('changed')}),/manifest join/);
  const tampered=structuredClone(state); tampered.manifest.studyId='changed';
  assert.throws(()=>apply(tampered,'start',0,{evidenceHash:evidence}),/manifest changed/);
});

test('missing cheap packet remains an assigned graded result with missing coverage', () => {
  let state=freezeStudy(manifest()); state=apply(state,'start',0,{evidenceHash:evidence}); state=finish(state,1);
  state=apply(state,'start',100,{evidenceHash:evidence}); state=identify(state,101);
  state=apply(state,'retrieval_unavailable',102,{reason:'unavailable',evidenceHash:evidence});
  state=apply(state,'coding_ended',110,{patchHash:evidence,reason:'completed',evidenceHash:evidence});
  state=apply(state,'graded',120,{patchHash:evidence,graderHash:manifest().tasks[0].graderHash,verdict:'verified-fix',healthy:true,evidenceHash:evidence});
  const arm=summarizeStudy(state).arms[1];
  assert.equal(arm.verifiedFixes,1); assert.equal(arm.packetDeliveries,0); assert.equal(arm.packetMissing,1); assert.equal(arm.elapsedMs,20);
});

function fullStudy(counts, {uptake=true, approval=false, durations={}}={}) {
  let state=freezeStudy(manifest()); const seen=Object.fromEntries(ARMS.map(arm=>[arm,0]));
  for(let index=0;index<18;index++) {
    const start=index*1000; state=apply(state,'start',start,{evidenceHash:evidence}); const arm=state.slots[index].arm;
    if(arm==='plugin-on'&&uptake) {
      const id=`synthetic-advice-${index}`;
      state=apply(state,'consultation',start+1,{consultationId:id,status:'assessed',providerInvoked:true,delivered:true,receiptHash:evidence,evidenceHash:evidence});
      state=apply(state,'uptake',start+2,{consultationId:id,value:'observed',evidenceHash:evidence});
    }
    if(arm==='plugin-on'&&approval) state=apply(state,'approval',start+3,{evidenceHash:evidence});
    const duration=durations[arm]??100;
    state=finish(state,start+duration-20,seen[arm]++<counts[arm]?'verified-fix':'not-fixed');
    if(index===2) state=apply(state,'interim_report',start+duration+1,{reportHash:evidence,artifactsHash:evidence,evidenceHash:evidence});
  }
  return summarizeStudy(state);
}

test('exploratory extra-fix screen requires actual uptake and no increased approval burden', () => {
  const counts={'plugin-off':4,cheap:4,'plugin-on':5};
  assert.equal(fullStudy(counts).interpretation.verdict,'helpful');
  assert.equal(fullStudy(counts,{uptake:false}).interpretation.verdict,'neutral');
  assert.equal(fullStudy(counts,{approval:true}).interpretation.verdict,'harmful');
  assert.equal(fullStudy({'plugin-off':5,cheap:5,'plugin-on':4}).interpretation.verdict,'harmful');
  assert.equal(fullStudy({'plugin-off':5,cheap:5,'plugin-on':5}).interpretation.verdict,'neutral');
});

test('time screen sums all unsuccessful attempt time and never rewards zero fixes', () => {
  const counts={'plugin-off':4,cheap:4,'plugin-on':4};
  const report=fullStudy(counts,{durations:{'plugin-off':100,cheap:100,'plugin-on':80}});
  assert.equal(report.interpretation.verdict,'helpful');
  assert.equal(report.arms[0].elapsedMs,600); assert.equal(report.arms[0].timePerVerifiedFixMs,150);
  assert.equal(report.arms[2].elapsedMs,480); assert.equal(report.arms[2].timePerVerifiedFixMs,120);
  assert.equal(fullStudy(counts,{durations:{'plugin-on':81}}).interpretation.verdict,'neutral');
  const empty=fullStudy({'plugin-off':0,cheap:0,'plugin-on':0},{durations:{'plugin-on':40}});
  assert.equal(empty.interpretation.verdict,'neutral'); assert.equal(empty.arms[2].timePerVerifiedFixMs,null);
});

test('infrastructure-invalid data retains its assigned clock and cannot establish superiority', () => {
  let state=freezeStudy(manifest()); state=apply(state,'start',0,{evidenceHash:evidence});
  state=apply(state,'identity_broken',100,{reason:'private diagnostic never exported',evidenceHash:evidence});
  const report=summarizeStudy(state);
  assert.equal(report.invalidAttempts,1); assert.equal(report.pendingAttempts,17); assert.equal(report.arms[0].elapsedMs,100);
  assert.equal(report.arms[0].completed,0); assert.equal(report.arms[0].fixRate,null);
  assert.equal(report.interpretation.verdict,'inconclusive');
  assert.doesNotMatch(JSON.stringify(report),/private diagnostic/);
});

test('untracked native launch recovery consumes the next slot without fabricating its start and permanently halts', () => {
  let state=freezeStudy(manifest()); state=apply(state,'start',0,{evidenceHash:evidence}); state=finish(state,1);
  const recovered={chatId:'synthetic-untracked-native',createdAt:new Date(origin+1000).toISOString(),completedAt:new Date(origin+55000).toISOString(),prelaunchStartedAt:null,evidenceHash:evidence};
  const observed=60000;
  for (const patch of [{prelaunchStartedAt:new Date(origin+900).toISOString()},{completedAt:new Date(origin+61000).toISOString()},{createdAt:new Date(origin+56000).toISOString()},{chatId:state.slots[0].chatId}]) {
    assert.throws(()=>apply(state,'recovery_untracked_launch',observed,{...recovered,...patch}),/actual unique native identity/);
  }
  assert.throws(()=>apply(state,'recovery_untracked_launch',observed,{...recovered,slotId:state.slots[2].id}),/next untouched slot/);
  state=apply(state,'recovery_untracked_launch',observed,recovered);
  assert.equal(state.slots[1].startedAt,null); assert.equal(state.slots[1].identity,null);
  assert.equal(state.slots[1].chatId,recovered.chatId); assert.equal(state.slots[1].verdict,'infrastructure-invalid');
  assert.equal(state.halted.reason,'untracked-native-launch');
  assert.throws(()=>apply(state,'start',60001,{evidenceHash:evidence}),/Scoring stopped/);
  const report=summarizeStudy(state);
  assert.equal(report.completedAttempts,1); assert.equal(report.invalidAttempts,1); assert.equal(report.pendingAttempts,16);
  assert.equal(report.arms[1].assigned,1); assert.equal(report.arms[1].elapsedMs,54000); assert.equal(report.arms[1].elapsedLowerBoundMs,54000);
  assert.equal(report.arms[1].elapsedTimeCoverage,'lower-bound'); assert.equal(report.arms[1].timePerVerifiedFixMs,null);
  assert.deepEqual(report.curves.cheap,[]); assert.equal(report.interpretation.verdict,'inconclusive');
  assert.match(report.limitations.join(' '),/pre-launch timing is unknown/);
  assert.doesNotMatch(JSON.stringify(report),/synthetic-untracked-native/);
});

function launchData(state) {
  const commonPrompt='Implement the repository bug described in the supplied public issue and reproduction. Work only inside the assigned workspace, preserve benchmark inputs, verify the fix and retain the patch. This is synthetic launch-validator test content.\n';
  const promptTemplate=commonPrompt+'\nRecorded launch time: {{ATTEMPT_STARTED_AT}}\nCoding deadline: {{CODING_STOPS_AT}}\n';
  const contract={schemaVersion:'whole-plugin-launch-contract-v1',manifestHash:state.manifestHash,commonPromptHash:hash(commonPrompt),
    slots:state.slots.map((slot,index)=>({slotId:slot.id,projectId:`synthetic-project-${index}`,workspace:`/synthetic/benchmark-${index}`,
      baseRevision:state.manifest.tasks.find(task=>task.id===slot.taskId).baseRevision,configurationHash:state.manifest.arms[slot.arm].configurationHash,promptTemplateHash:hash(promptTemplate)}))};
  const slot=state.slots.find(row=>row.status==='CODING')??state.slots[0],pin=contract.slots.find(row=>row.slotId===slot.id);
  const selected={projectId:pin.projectId,workspace:pin.workspace,model:'gpt-6.1-sol',effort:'ultra',baseRevision:pin.baseRevision,configurationHash:pin.configurationHash};
  const grades=state.slots.filter(row=>row.status==='COMPLETE').map(row=>({schemaVersion:'whole-plugin-independent-grade-v1',slotId:row.id,patchHash:row.patchHash,
    graderHash:state.manifest.tasks.find(task=>task.id===row.taskId).graderHash,exitCode:row.verdict==='verified-fix'?0:1,
    terminal:{verdict:row.verdict==='verified-fix'?'pass':'fail',healthy:true},studyVerdict:row.verdict}));
  const artifacts={
    'prompt-preparation':{schemaVersion:'whole-plugin-prompt-ready-v1',manifestHash:state.manifestHash,slotId:slot.id,commonPromptHash:contract.commonPromptHash,promptTemplateHash:pin.promptTemplateHash},
    'workspace-validation':{schemaVersion:'whole-plugin-workspace-ready-v1',slotId:slot.id,selected},
    'prior-outcomes':{schemaVersion:'whole-plugin-prior-outcomes-v1',grades},
  };
  return {contract,request:{schemaVersion:'whole-plugin-launch-preparation-v1',manifestHash:state.manifestHash,slotId:slot.id,
    at:new Date(Date.parse(state.lastAt??new Date(origin).toISOString())+1).toISOString(),selected,commonPrompt,promptTemplate,
    prerequisites:Object.entries(artifacts).map(([id,artifact])=>({id,exitCode:0,signal:null,artifactHash:hash(artifact),artifact}))}};
}

test('validated launch returns exact native project arguments only after persisted start and successful structured prerequisites',()=>{
  let state=freezeStudy(manifest()); let input=launchData(state);
  assert.throws(()=>prepareNativeLaunch(state,input.contract,input.request),/persisted next-slot start/);
  state=apply(state,'start',0,{evidenceHash:evidence}); input=launchData(state);
  const prepared=prepareNativeLaunch(state,input.contract,input.request);
  assert.deepEqual(prepared.nativeArgs,{target:{type:'project',projectId:'synthetic-project-0',environment:{type:'local'}},model:'gpt-6.1-sol',thinking:'ultra',prompt:renderPromptTemplate(input.request.promptTemplate,state.slots[0].startedAt,state.manifest.policy.codingMs),title:`Jev pilot ${state.slots[0].id}`});
  state=apply(state,'native_launch_prepared',1,{preparationHash:hash(prepared),stateHash:hash(state),evidenceHash:evidence});
  assert.throws(()=>prepareNativeLaunch(state,input.contract,input.request),/unoccupied native identity/);
});

test('failed prerequisite, missing/stderr prompt, wrong slot/config/profile prevent even a stub native dispatch',()=>{
  let state=freezeStudy(manifest()); state=apply(state,'start',0,{evidenceHash:evidence});
  const mutations=[
    request=>{request.prerequisites[0].exitCode=1;},
    request=>{delete request.prerequisites[0].exitCode;},
    request=>{request.prerequisites[0].signal='SIGTERM';},
    request=>{delete request.promptTemplate;},
    request=>{request.promptTemplate='';},
    request=>{request.promptTemplate='cat: missing-prompt.txt: No such file or directory';},
    request=>{request.stdout=request.promptTemplate;},
    request=>{request.slotId=state.slots[1].id;},
    request=>{request.selected.projectId='different-project';},
    request=>{request.selected.workspace='/different/workspace';},
    request=>{request.selected.model='gpt-6-astra';},
    request=>{request.selected.effort='low';},
    request=>{request.selected.configurationHash=hash('wrong-config');},
  ];
  for(const mutate of mutations) {
    const {contract,request}=launchData(state); mutate(request); let dispatches=0;
    assert.throws(()=>{const prepared=prepareNativeLaunch(state,contract,request);dispatches++;return prepared.nativeArgs;});
    assert.equal(dispatches,0);
  }
  const input=launchData(state); input.contract.slots[1].workspace=input.contract.slots[0].workspace;
  assert.throws(()=>validateLaunchContract(state,input.contract),/independent/);
});

test('prior-grade preparation validates actual studyVerdict and healthy terminal instead of nonexistent verdict field',()=>{
  let state=freezeStudy(manifest()); state=apply(state,'start',0,{evidenceHash:evidence}); state=finish(state,1); state=apply(state,'start',100,{evidenceHash:evidence});
  const good=launchData(state); assert.doesNotThrow(()=>prepareNativeLaunch(state,good.contract,good.request));
  for(const mutate of [
    receipt=>{receipt.verdict=receipt.studyVerdict;delete receipt.studyVerdict;},
    receipt=>{receipt.terminal.healthy=false;},
    receipt=>{receipt.patchHash=hash('other-patch');},
    receipt=>{receipt.graderHash=hash('other-grader');},
    receipt=>{receipt.terminal.verdict='fail';},
  ]) {
    const {contract,request}=launchData(state), prerequisite=request.prerequisites.find(row=>row.id==='prior-outcomes');
    mutate(prerequisite.artifact.grades[0]); prerequisite.artifactHash=hash(prerequisite.artifact);
    let dispatches=0;
    assert.throws(()=>{prepareNativeLaunch(state,contract,request);dispatches++;},/studyVerdict and healthy terminal/);
    assert.equal(dispatches,0);
  }
});

test('file launch preparation fails closed on missing prompt and nonzero command status, then publishes only once',async()=>{
  const parent=new URL('../../../.agent-work/whole-plugin-tests/',import.meta.url); await mkdir(parent,{recursive:true});
  const directory=await mkdtemp(join(parent.pathname,'launch-synthetic-'));
  try {
    const run=join(directory,'run'),mp=join(directory,'manifest.json'); await writeFile(mp,JSON.stringify(manifest())); await main(['freeze',mp,run]);
    let state=await readStudy(run); let input=launchData(state);
    const cp=join(directory,'contract.json'); await writeFile(cp,JSON.stringify(input.contract)); await main(['freeze-launch-contract',run,cp]);
    const start=join(directory,'start.json'); await writeFile(start,JSON.stringify(event(state,'start',0,{evidenceHash:evidence}))); await main(['record',run,start]);
    state=await readStudy(run); input=launchData(state);
    const common=join(directory,'common.txt'),prompt=join(directory,'prompt.txt'); await writeFile(common,input.request.commonPrompt);
    const prerequisites=[];
    for(const row of input.request.prerequisites) {const path=join(directory,`${row.id}.json`);await writeFile(path,JSON.stringify(row.artifact));prerequisites.push({id:row.id,exitCode:row.exitCode,signal:row.signal,artifactPath:path,artifactHash:row.artifactHash});}
    const fileInput={schemaVersion:input.request.schemaVersion,manifestHash:state.manifestHash,slotId:input.request.slotId,at:input.request.at,selected:input.request.selected,commonPromptPath:common,promptTemplatePath:prompt,prerequisites};
    const requestPath=join(directory,'request.json'); await writeFile(requestPath,JSON.stringify(fileInput));
    await assert.rejects(main(['prepare-launch',run,requestPath]),/ENOENT/);
    const failedCommand=spawnSync(process.execPath,[new URL('./cli.mjs',import.meta.url).pathname,'prepare-launch',run,requestPath],{encoding:'utf8'});
    let dispatches=0;
    await assert.rejects(dispatchPreparedNativeLaunch({exit_code:failedCommand.status,output:failedCommand.stdout+failedCommand.stderr},async()=>{dispatches++;}),/explicitly successful/);
    assert.equal(dispatches,0);
    assert.equal((await readStudy(run)).events.length,1);
    fileInput.prerequisites[0].exitCode=1; await writeFile(requestPath,JSON.stringify(fileInput));
    await assert.rejects(main(['prepare-launch',run,requestPath]),/explicitly succeed/);
    fileInput.prerequisites[0].exitCode=0; await writeFile(requestPath,JSON.stringify(fileInput)); await writeFile(prompt,input.request.promptTemplate);
    const prepared=await main(['prepare-launch',run,requestPath]); assert.equal(prepared.nativeArgs.prompt,renderPromptTemplate(input.request.promptTemplate,state.slots[0].startedAt,state.manifest.policy.codingMs));
    const nativeResult=await dispatchPreparedNativeLaunch({exit_code:0,output:JSON.stringify(prepared)},async args=>{dispatches++;assert.deepEqual(args,prepared.nativeArgs);return {threadId:'synthetic-no-native-call'};});
    assert.equal(dispatches,1);assert.equal(nativeResult.threadId,'synthetic-no-native-call');
    assert.equal((await readStudy(run)).slots[0].launchPreparation.preparationHash,prepared.preparationHash);
    await assert.rejects(main(['prepare-launch',run,requestPath]),/unoccupied native identity/);
  }finally{await rm(directory,{recursive:true,force:true});}
});

test('trailing-newline common prompt is preserved and one frozen template renders two different persisted starts',()=>{
  const frozen=freezeStudy(manifest()), initial=launchData(frozen), contractHash=hash(initial.contract);
  const outputs=[];
  for(const offset of [0,86400000]) {
    const state=apply(frozen,'start',offset,{evidenceHash:evidence}),input=launchData(state);
    assert.equal(hash(input.contract),contractHash);
    const prepared=prepareNativeLaunch(state,initial.contract,input.request);
    assert.ok(prepared.nativeArgs.prompt.startsWith(input.request.commonPrompt+'\nRecorded launch time: '));
    assert.ok(input.request.commonPrompt.endsWith('\n'));
    assert.match(prepared.nativeArgs.prompt,new RegExp(`Recorded launch time: ${state.slots[0].startedAt}`));
    assert.ok(prepared.nativeArgs.prompt.endsWith(`Coding deadline: ${new Date(origin+offset+2100000).toISOString()}\n`));
    outputs.push(prepared.nativeArgs.prompt);
  }
  assert.notEqual(outputs[0],outputs[1]); assert.equal(hash(initial.contract),contractHash);
  assert.throws(()=>renderPromptTemplate(initial.request.promptTemplate.replace('{{CODING_STOPS_AT}}','wrong'),new Date(origin).toISOString(),2100000),/one start token/);
});

test('final native bridge checks actual command exit and prepared JSON before dispatching exact native arguments',async()=>{
  let state=freezeStudy(manifest());state=apply(state,'start',0,{evidenceHash:evidence});
  const input=launchData(state),prepared=prepareNativeLaunch(state,input.contract,input.request);
  const payload={...prepared,artifact:'/synthetic/prepared.json',preparationHash:hash(prepared)};
  const good={exit_code:0,output:JSON.stringify(payload)};
  const malformed={...payload,nativeArgs:{...payload.nativeArgs,prompt:'cat: missing-prompt.txt: No such file or directory'}};
  const wrongModel={...prepared,nativeArgs:{...prepared.nativeArgs,model:'gpt-6-astra'}};
  const badResults=[
    {exit_code:1,output:'cat: missing-prompt.txt: No such file or directory'},
    {output:good.output}, {exit_code:null,output:good.output,session_id:42}, {exit_code:0,output:'not JSON'},
    {exit_code:0,output:JSON.stringify({schemaVersion:'error',nativeArgs:payload.nativeArgs})},
    {exit_code:0,output:JSON.stringify(malformed)},
    {exit_code:0,output:JSON.stringify({...wrongModel,artifact:payload.artifact,preparationHash:hash(wrongModel)})},
    {exit_code:0,output:`warning from stderr\n${good.output}`},
  ];
  for(const result of badResults) {let dispatches=0;await assert.rejects(dispatchPreparedNativeLaunch(result,async()=>{dispatches++;}));assert.equal(dispatches,0);}
  let received=null,calls=0;
  const result=await dispatchPreparedNativeLaunch(good,async args=>{calls++;received=args;return {threadId:'synthetic-only'};});
  assert.equal(calls,1);assert.deepEqual(received,payload.nativeArgs);assert.equal(result.threadId,'synthetic-only');
});
