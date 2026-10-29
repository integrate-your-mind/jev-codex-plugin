import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile, writeFile, mkdir, mkdtemp, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {ARMS, TASK_IDS, freezeStudy, hash, reduceEvent, deadlines} from './controller.mjs';
import {summarizeStudy, exportCsv} from './report.mjs';
import {main, readStudy} from './cli.mjs';

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
