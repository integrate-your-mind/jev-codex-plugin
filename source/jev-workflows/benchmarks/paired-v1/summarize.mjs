import {readFile, writeFile} from 'node:fs/promises';
import {resolve, join} from 'node:path';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';

const directory=resolve(process.argv[2]);
const report=JSON.parse(await readFile(join(directory,'report.json'),'utf8'));
assert.equal(report.status,'completed','Only a completed isolated run can produce a comparative summary');
const raw=await readFile(join(directory,'trials.jsonl'),'utf8');
const rows=raw.trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));
const plan=JSON.parse(await readFile(join(directory,'plan.json'),'utf8'));
assert.equal(rows.length,report.counts.plannedTrials,'Missing scheduled trials');
assert.equal(report.counts.infrastructureFailures,0,'Infrastructure failures invalidate the comparison');
assert.equal(new Set(rows.map(r=>r.trialId)).size,rows.length,'Duplicate trial IDs');
assert.equal(new Set(rows.map(r=>`${r.model}:${r.effort}`)).size,1,'Model/effort must remain identical');
assert.deepEqual(rows.map(r=>r.trialId).sort(),plan.plan.map(r=>r.trialId).sort(),'Trials must match the frozen execution plan');
for(const r of rows) {
  const expected=plan.plan.find(p=>p.trialId===r.trialId);
  assert.equal(r.taskId,expected.taskId);
  assert.equal(r.repeat,expected.repeat);
  assert.equal(r.arm,expected.arm);
}
const sum=xs=>xs.reduce((a,b)=>a+b,0);
const median=xs=>{const a=[...xs].sort((a,b)=>a-b);return a.length ? (a[Math.floor((a.length-1)/2)]+a[Math.floor(a.length/2)])/2 : null;};
function usage(row) {
  const events=row.tokenUsage??[];
  let previous=null;
  for(const event of events) {
    const u=event.usage?.tokenUsage?.total;
    if(!u || typeof u.inputTokens!=='number')continue;
    if(previous) for(const key of ['inputTokens','cachedInputTokens','outputTokens','reasoningOutputTokens']) {
      if(typeof u[key]==='number' && typeof previous[key]==='number') assert.ok(u[key]>=previous[key],`Nonmonotonic ${key}: ${row.trialId}`);
    }
    if(typeof u.cachedInputTokens==='number') assert.ok(u.cachedInputTokens<=u.inputTokens,'Cached input is part of input, not an additional total');
    previous=u;
  }
  return previous;
}
const trials=rows.map(row=>({
  trialId:row.trialId,taskId:row.taskId,repeat:row.repeat,arm:row.arm,
  model:row.model??null,effort:row.effort??null,
  passed:row.oracle?.passed===true,
  completedAndPassed:row.agentTurnSuccess===true && row.oracle?.passed===true,
  artifactPassed:row.oracle?.passed===true,agentTurnSuccess:row.agentTurnSuccess===true,
  turnMs:row.turns?.length ? sum(row.turns.map(t=>t.elapsedMs)) : null,
  turnStatuses:(row.turns??[]).map(t=>t.status),
  startupMs:row.startup?.readinessMs??null,
  commandCount:row.toolCounts?.commandExecution??0,
  failedCommandCount:row.failedCommandCount??null,
  mcpCallCount:sum(Object.entries(row.toolCounts??{}).filter(([k])=>k.startsWith('mcpToolCall')).map(([,v])=>v)),
  hookCount:row.hookSummary?.count??0,hookDurationSumMs:row.hookSummary?.durationMs??0,
  usage:usage(row),failure:row.failure??null,
}));
const byArm=Object.fromEntries(['baseline','treatment'].map(arm=>{
  const rs=trials.filter(r=>r.arm===arm), ts=rs.filter(r=>r.turnMs!==null), us=rs.filter(r=>r.usage!==null);
  return [arm,{trials:rs.length,passed:rs.filter(r=>r.passed).length,
    medianTurnMs:median(ts.map(r=>r.turnMs)),totalTurnMs:sum(ts.map(r=>r.turnMs)),
    measuredTurnTrials:ts.length,tokenObservedTrials:us.length,
    inputTokens:us.length ? sum(us.map(r=>r.usage.inputTokens??0)) : null,
    cachedInputTokens:us.length ? sum(us.map(r=>r.usage.cachedInputTokens??0)) : null,
    outputTokens:us.length ? sum(us.map(r=>r.usage.outputTokens??0)) : null,
    reasoningOutputTokens:us.length ? sum(us.map(r=>r.usage.reasoningOutputTokens??0)) : null,
    commands:sum(rs.map(r=>r.commandCount)),mcpCalls:sum(rs.map(r=>r.mcpCallCount)),
    hooks:sum(rs.map(r=>r.hookCount)),hookDurationSumMs:sum(rs.map(r=>r.hookDurationSumMs)),
  }];
}));
const pairs=[];
for(const baseline of trials.filter(r=>r.arm==='baseline')) {
  const treatment=trials.find(r=>r.arm==='treatment' && r.taskId===baseline.taskId && r.repeat===baseline.repeat);
  assert.ok(treatment,`Missing treatment pair: ${baseline.trialId}`);
  pairs.push({taskId:baseline.taskId,repeat:baseline.repeat,baselinePassed:baseline.passed,treatmentPassed:treatment.passed,
    baselineMs:baseline.turnMs,treatmentMs:treatment.turnMs,
    deltaMs:baseline.turnMs!==null && treatment.turnMs!==null ? treatment.turnMs-baseline.turnMs : null,
    timeRatio:baseline.turnMs>0 && treatment.turnMs!==null ? treatment.turnMs/baseline.turnMs : null});
}
assert.equal(pairs.length*2,rows.length,'Each task/repeat must have exactly two arms');
const result={schemaVersion:'paired-codex-summary-v1',generatedAt:new Date().toISOString(),
  armMapping:{baseline:'codex_only',treatment:'codex_jev'},primaryMetric:'artifactPassed',timeMetric:'sum of turn durations; excludes startup, oracle and cleanup',
  sourceSha256:createHash('sha256').update(raw).digest('hex'),byArm,pairs,trials,
  pairedMedianDeltaMs:median(pairs.map(p=>p.deltaMs).filter(v=>v!==null)),
  pairedMedianTimeRatio:median(pairs.map(p=>p.timeRatio).filter(v=>v!==null)),
  billing:'Not measured or reconciled. Codex subscription tokens are not dollar costs.',
  interpretation:'Descriptive synthetic pilot only; four task clusters, repeated trials, no general improvement or significance claim.'};
await writeFile(join(directory,'summary.json'),JSON.stringify(result,null,2)+'\n',{mode:0o600});
console.log(JSON.stringify({byArm,pairedMedianDeltaMs:result.pairedMedianDeltaMs,pairedMedianTimeRatio:result.pairedMedianTimeRatio},null,2));
