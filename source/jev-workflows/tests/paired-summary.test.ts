import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

const script=fileURLToPath(new URL('../benchmarks/paired-v1/summarize.mjs',import.meta.url));

test('paired summary uses final cumulative usage, paired deltas, and separates artifact success from completion',async()=>{
  const output=await mkdtemp(join(tmpdir(),'jev-paired-summary-test-'));
  try {
    const rows=[];
    for(const repeat of [1,2]) for(const arm of ['baseline','treatment']) {
      const input=arm==='baseline'?200:400;
      rows.push({trialId:`task.r${repeat}.${arm}`,taskId:'task',repeat,arm,model:'fixed',effort:'medium',
        agentTurnSuccess:!(repeat===2 && arm==='treatment'),oracle:{passed:true},
        turns:[{elapsedMs:repeat*(arm==='baseline'?10:15),status:'completed'}],
        tokenUsage:[input/2,input].map(inputTokens=>({usage:{tokenUsage:{total:{inputTokens,cachedInputTokens:10,outputTokens:3}}}}))});
    }
    await writeFile(join(output,'report.json'),JSON.stringify({status:'completed',counts:{plannedTrials:4,infrastructureFailures:0}}));
    await writeFile(join(output,'plan.json'),JSON.stringify({plan:rows.map(({trialId,taskId,repeat,arm})=>({trialId,taskId,repeat,arm}))}));
    await writeFile(join(output,'trials.jsonl'),rows.map(r=>JSON.stringify(r)).join('\n'));
    const run=spawnSync(process.execPath,[script,output],{encoding:'utf8'});
    assert.equal(run.status,0,run.stderr);
    const result=JSON.parse(await readFile(join(output,'summary.json'),'utf8'));
    assert.equal(result.byArm.baseline.inputTokens,400);
    assert.equal(result.byArm.treatment.inputTokens,800);
    assert.equal(result.byArm.baseline.passed,2);
    assert.equal(result.byArm.treatment.passed,2);
    assert.equal(result.pairedMedianDeltaMs,7.5);
    assert.equal(result.pairedMedianTimeRatio,1.5);
    assert.equal(result.trials[3].artifactPassed,true);
    assert.equal(result.trials[3].completedAndPassed,false);
    await writeFile(join(output,'report.json'),JSON.stringify({status:'infrastructure_aborted',counts:{plannedTrials:4,infrastructureFailures:1}}));
    assert.notEqual(spawnSync(process.execPath,[script,output],{encoding:'utf8'}).status,0);
  } finally {
    await rm(output,{recursive:true,force:true});
  }
});
