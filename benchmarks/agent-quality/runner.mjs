import {createHash, randomUUID} from 'node:crypto';
import {mkdir, readFile, writeFile, rename, readdir, copyFile, appendFile, rm, stat, cp, link} from 'node:fs/promises';
import {resolve, join, dirname} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {performance} from 'node:perf_hooks';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {developmentTasks, confirmationTasks} from './corpus.mjs';

const HERE=dirname(fileURLToPath(import.meta.url));
const ROOT=resolve(HERE,'../..');
const HOSTS={codex:{model:'gpt-6-astra',effort:'high',pluginRoot:join(ROOT,'source/jev-workflows')},claude:{model:'claude-opus-5-5[1m]',effort:'high',pluginRoot:join(ROOT,'source/jev-workflows'),packageClaude:true},qq:{model:'openai-codex/gpt-6-astra',effort:'high',pluginRoot:join(ROOT,'source/jev-workflows')}};
const sha=x=>createHash('sha256').update(x).digest('hex');
async function json(path,value,exclusive=false){await mkdir(dirname(path),{recursive:true,mode:0o700});if(exclusive){const pending=path+'.'+randomUUID()+'.tmp';try{await writeFile(pending,JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});await link(pending,path);}finally{await rm(pending,{force:true});}return;}const tmp=path+'.'+randomUUID()+'.tmp';await writeFile(tmp,JSON.stringify(value,null,2)+'\n',{mode:0o600});await rename(tmp,path);}
function args(argv){const command=argv.shift();const o={command};while(argv.length){const key=argv.shift();if(!key?.startsWith('--'))throw Error('Expected named option');o[key.slice(2)]=argv.shift();}return o;}
async function fingerprints(hosts){const paths=['SPEC.md','corpus.mjs','runner.mjs',...hosts.map(h=>'adapters/'+h+'.mjs')];const values={};for(const p of paths)values[p]=sha(await readFile(join(HERE,p)));return values;}
async function hashTree(path,prefix=''){let values={};for(const d of (await readdir(path,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){const part=join(prefix,d.name);if(d.isDirectory())Object.assign(values,await hashTree(join(path,d.name),part));else if(d.isFile())values[part]=sha(await readFile(join(path,d.name)));else throw Error('Plugin snapshot contains unsupported link');}return values;}
export async function freeze(options){
 const output=resolve(options.out);const phase=options.phase??'development';if(!['preflight','development','confirmation'].includes(phase))throw Error('Invalid phase');
 const hosts=(options.hosts??'codex,claude,qq').split(',');if(!hosts.length||new Set(hosts).size!==hosts.length||hosts.some(h=>!HOSTS[h]))throw Error('Unknown or duplicate host');
 const configuration=options['host-config']?JSON.parse(await readFile(resolve(options['host-config']),'utf8')):{};
 const selected=Object.fromEntries(hosts.map(host=>[host,{...HOSTS[host],...configuration[host]}]));
 for(const host of hosts){if(typeof selected[host].model!=='string'||!selected[host].model||typeof selected[host].effort!=='string'||!selected[host].effort)throw Error('Model and effort must be explicit');}
 const repetitions=Number(options.repetitions??(phase==='preflight'?1:5));if(!Number.isSafeInteger(repetitions)||repetitions<1)throw Error('Invalid repetitions');
 const tasks=phase==='confirmation'?confirmationTasks:phase==='preflight'?developmentTasks.slice(0,1):developmentTasks;
 const identity=await fingerprints(hosts);const schedule=[];
 await mkdir(output,{recursive:true,mode:0o700});
 const frozenHosts=structuredClone(selected);
 for(const host of hosts){const destination=join(output,'engines',host,host==='claude'?'jev-workflows-claude':'source');if(host==='claude'&&selected[host].packageClaude){await mkdir(dirname(destination),{recursive:true,mode:0o700});await promisify(execFile)(process.execPath,[join(selected[host].pluginRoot,'scripts/package-claude.mjs'),destination],{timeout:30000});}else await cp(selected[host].pluginRoot,destination,{recursive:true,errorOnExist:true,force:false,filter:path=>!path.split('/').some(part=>part==='node_modules'||part==='.git')});frozenHosts[host].pluginRoot=destination;delete frozenHosts[host].packageClaude;}
 const pluginIdentity={};
 for(const host of hosts)pluginIdentity[host]=await hashTree(frozenHosts[host].pluginRoot);

 for(const host of hosts)for(let repetition=0;repetition<repetitions;repetition++)for(let ti=0;ti<tasks.length;ti++){
  const task=tasks[ti];const order=(repetition+ti)%2===0?['off','on']:['on','off'];for(const arm of order)schedule.push({id:randomUUID(),host,taskId:task.id,repetition,arm,settings:frozenHosts[host],promptHash:sha(task.prompt),fixtureHash:sha(JSON.stringify(task.files))});
 }
 const timeoutMs=Number(options['timeout-ms']??360000);if(!Number.isFinite(timeoutMs)||timeoutMs<=0)throw Error('Invalid timeout');
 const plan={schemaVersion:'jev-agent-quality-v1',createdAt:new Date().toISOString(),phase,repetitions,hosts,tasks:tasks.map(t=>t.id),identity,pluginIdentity,hostConfigurations:frozenHosts,schedule,timeoutMs,sampleUnit:'task; repetitions are dependent within task',costPolicy:'billed cost null unless reconciled; reported/estimated separate',publication:'private raw evidence; public source contains no credentials'};
 await mkdir(output,{recursive:true,mode:0o700});await json(join(output,'plan.json'),plan,true);return plan;
}
async function copyArtifact(workspace,destination){await mkdir(destination,{recursive:true,mode:0o700});async function walk(path,relative=''){for(const d of await readdir(path,{withFileTypes:true})){if(d.name==='.git'||d.name==='.qq'||d.name==='node_modules'||d.name==='.claude')continue;const r=join(relative,d.name);if(d.isSymbolicLink())throw Error('Artifact contains symlink');if(d.isDirectory()){await mkdir(join(destination,r),{recursive:true,mode:0o700});await walk(join(path,d.name),r);}else if(d.isFile()){const s=await stat(join(path,d.name));if(s.size>4*1024*1024)throw Error('Artifact too large');await copyFile(join(path,d.name),join(destination,r));}}}await walk(workspace);}
function countRequests(receipt){return receipt.jev?.attempts??receipt.jev?.requestCount??0;}
function contactedJev(receipt){const j=receipt.jev??{};return j.requestIds?.length>0||j.fetchInvoked>0||j.providerRequests>0||j.providerContacted===true||j.contacted===true;}
function validateSchedule(plan){if(new Set(plan.schedule.map(x=>x.id)).size!==plan.schedule.length)throw Error('Duplicate scheduled IDs');if(new Set(plan.schedule.map(x=>JSON.stringify([x.host,x.taskId,x.repetition,x.arm]))).size!==plan.schedule.length)throw Error('Duplicate scheduled coordinates');const expected=new Set();for(const host of plan.hosts)for(const task of plan.tasks)for(let repetition=0;repetition<plan.repetitions;repetition++)for(const arm of ['off','on'])expected.add(JSON.stringify([host,task,repetition,arm]));for(const row of plan.schedule)if(!expected.delete(JSON.stringify([row.host,row.taskId,row.repetition,row.arm])))throw Error('Unexpected scheduled coordinate');if(expected.size)throw Error('Missing scheduled arms or coordinates');}
export function validity(row,receipt){
 const problems=[],delivery=[];const expected=row.settings??{};
 if(receipt.requestedModel!==expected.model)problems.push('requested_model_changed');
 if(!receipt.resolvedModel)problems.push('resolved_model_unknown');
 else if(receipt.resolvedModel!==expected.model&&!(expected.allowedResolvedModels??[]).includes(receipt.resolvedModel))problems.push('resolved_model_mismatch');
 if(receipt.requestedEffort!==expected.effort)problems.push('requested_effort_changed');
 if(receipt.resolvedEffort&&receipt.resolvedEffort!==expected.effort)problems.push('resolved_effort_mismatch');
 if(receipt.isolation?.pluginEvidence?.contaminated)problems.push('ambient_plugins_or_mcp');
 if(row.arm==='off'&&(countRequests(receipt)>0||contactedJev(receipt)))problems.push('control_contacted_jev');
 if(row.arm==='off'&&(receipt.jev?.adviceDeliveries>0||receipt.jev?.deliveryReceiptIds?.length>0))problems.push('control_received_jev_advice');
 if(row.arm==='on'&&!contactedJev(receipt))delivery.push('no_provider_request_evidence');
 if(row.arm==='on'&&!(receipt.jev?.adviceDeliveries>0))delivery.push('no_advice_delivery_evidence');
 return {valid:problems.length===0,problems,deliveryDiagnostics:delivery,intentionToTreatRetained:true,plumbingVerified:problems.length===0&&delivery.length===0&&receipt.completion===true,note:'Provider errors/abstentions/non-delivery remain in assigned operational denominators.'};
}
export async function run(options){
 const output=resolve(options.out);const plan=JSON.parse(await readFile(join(output,'plan.json'),'utf8'));
 validateSchedule(plan);
 for(const host of plan.hosts){const actual=await hashTree(plan.hostConfigurations[host].pluginRoot);if(JSON.stringify(actual)!==JSON.stringify(plan.pluginIdentity[host]))throw Error('Frozen engine bytes changed: '+host);}
 const current=await fingerprints(plan.hosts);if(JSON.stringify(current)!==JSON.stringify(plan.identity))throw Error('Frozen source identities changed; start a new named cohort');
 const taskMap=new Map([...developmentTasks,...confirmationTasks].map(t=>[t.id,t]));
 const stop=new AbortController();const abort=()=>stop.abort();process.once('SIGINT',abort);process.once('SIGTERM',abort);
 let executed=0;const max=Number(options['max-trials']??Infinity);if(max!==Infinity&&(!Number.isSafeInteger(max)||max<0))throw Error('Invalid max-trials');
 try{for(const row of plan.schedule){
  if(stop.signal.aborted||executed>=max)break;
  const target=join(output,'trials',row.id);try{await stat(join(target,'started.json'));continue;}catch(e){if(e.code!=='ENOENT')throw e;}
  const task=taskMap.get(row.taskId);const workspace=join('/private/tmp','cedar-'+randomUUID());
  await mkdir(target,{recursive:true,mode:0o700});await json(join(target,'started.json'),{...row,at:new Date().toISOString(),workspace},true);
  const totalStart=performance.now();let receipt=null,grade=null,error=null,cleanupError=null;const taskStart=performance.now();
  try{
   await mkdir(workspace,{mode:0o700});for(const [name,body]of Object.entries(task.files)){const path=resolve(workspace,name);if(!path.startsWith(workspace+'/'))throw Error('Unsafe fixture path');await mkdir(dirname(path),{recursive:true,mode:0o700});await writeFile(path,body,{mode:0o600});}
   const module=await import(pathToFileURL(join(HERE,'adapters',row.host+'.mjs')).href);
   console.log(JSON.stringify({type:'started',...row,workspace}));
   receipt=await module.runTrial({workspace,prompt:task.prompt,followups:task.followups??[],arm:row.arm,...row.settings,timeoutMs:plan.timeoutMs,outputDir:target,runId:'native',authorizeProvider:true,approvalMode:'auto',signal:stop.signal});
   const agentFinished=performance.now();
   if(receipt.isolation?.cleanupRequired)throw Error('Owned host run termination unconfirmed; workspace retained for recovery');
   await copyArtifact(workspace,join(target,'artifact'));
   grade=await task.grade(join(target,'artifact'));receipt.agentPhaseMs=agentFinished-taskStart;
  }catch(e){error={name:e.name,message:String(e.message).slice(0,2000)};}finally{if(receipt?.isolation?.cleanupRequired)cleanupError={path:workspace,message:'Owned run termination unconfirmed; retained'};else try{await rm(workspace,{recursive:true,force:true});}catch(e){cleanupError={path:workspace,message:e.message};}}
  const result={...row,phase:plan.phase,receipt,grade,error,validity:receipt?validity(row,receipt):{valid:false,problems:['adapter_did_not_return']},artifactCorrect:grade?.passed??null,hostCompleted:receipt?.completion===true,completedCorrectly:grade?.passed===true&&receipt?.completion===true,totalWallMs:performance.now()-totalStart,finishedAt:new Date().toISOString(),workspaceRemoved:cleanupError===null,cleanupError};
  await json(join(target,'result.json'),result,true);await appendFile(join(output,'trials.jsonl'),JSON.stringify(result)+'\n',{mode:0o600});
  console.log(JSON.stringify({type:'finished',id:row.id,host:row.host,task:row.taskId,arm:row.arm,artifactCorrect:result.artifactCorrect,completed:result.hostCompleted,validity:result.validity,wallMs:result.totalWallMs,error}));executed++;
  if(options['stop-on-invalid']==='true'&&!result.validity.valid)break;
 }}finally{process.removeListener('SIGINT',abort);process.removeListener('SIGTERM',abort);}
 return {executed};
}
const median=xs=>{if(!xs.length)return null;const a=[...xs].sort((a,b)=>a-b),m=Math.floor(a.length/2);return a.length%2?a[m]:(a[m-1]+a[m])/2;};
function clusterSummary(plan,rows,host){
 const clusters=plan.tasks.map(task=>{const values={};for(const arm of ['off','on']){const r=rows.filter(x=>x.host===host&&x.taskId===task&&x.arm===arm);values[arm]=r.filter(x=>x.artifactCorrect===true).length/plan.repetitions;}return {task,...values,difference:values.on-values.off};});
 const mean=xs=>xs.reduce((a,b)=>a+b,0)/xs.length;let seed=715921;const rand=()=>{seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;return(seed>>>0)/4294967296;};
 const samples=Array.from({length:10000},()=>mean(Array.from({length:clusters.length},()=>clusters[Math.floor(rand()*clusters.length)].difference))).sort((a,b)=>a-b);
 const complete=rows.filter(x=>x.host===host).length===plan.schedule.filter(x=>x.host===host).length;
 return {taskUnitCount:clusters.length,clusters,meanPairedDifference:mean(clusters.map(x=>x.difference)),bootstrap:{lower:samples[250],upper:samples[9749],samples:10000,allTies:samples[0]===samples.at(-1),interpretation:'Exploratory task-cluster interval; all ties do not establish equivalence.'},allScheduledFinished:complete,interpretation:complete?'Descriptive fixed-task cohort; small independent task count.':'Incomplete operational denominator; unstarted/missing outcomes counted as no demonstrated pass, not proven code failure.'};
}
export async function summarize(options){
 const output=resolve(options.out),plan=JSON.parse(await readFile(join(output,'plan.json'),'utf8'));validateSchedule(plan);let rows=[];const slotStates=[];for(const row of plan.schedule){const target=join(output,'trials',row.id);try{const result=JSON.parse(await readFile(join(target,'result.json'),'utf8'));for(const key of ['id','host','taskId','repetition','arm','promptHash','fixtureHash'])if(result[key]!==row[key])throw Error('Trial identity mismatch: '+row.id);if(JSON.stringify(result.settings)!==JSON.stringify(row.settings))throw Error('Trial configuration mismatch: '+row.id);rows.push(result);slotStates.push({id:row.id,state:'finished'});}catch(e){if(e.code!=='ENOENT')throw e;let started=false;try{await stat(join(target,'started.json'));started=true;}catch(error){if(error.code!=='ENOENT')throw error;}slotStates.push({id:row.id,state:started?'started_without_result':'unstarted'});}}
 const groups={};for(const host of plan.hosts){groups[host]={};for(const arm of ['off','on']){const scheduled=plan.schedule.filter(r=>r.host===host&&r.arm===arm),r=rows.filter(x=>x.host===host&&x.arm===arm);const times=r.map(x=>x.totalWallMs).filter(Number.isFinite);groups[host][arm]={scheduled:scheduled.length,finished:r.length,missing:scheduled.length-r.length,valid:r.filter(x=>x.validity.valid).length,artifactPasses:r.filter(x=>x.artifactCorrect).length,completedCorrectly:r.filter(x=>x.completedCorrectly).length,wallMs:{median:median(times),min:times.length?Math.min(...times):null,max:times.length?Math.max(...times):null},perTask:plan.tasks.map(task=>{const v=r.filter(x=>x.taskId===task);return {task,finished:v.length,passes:v.filter(x=>x.artifactCorrect).length,timesMs:v.map(x=>x.totalWallMs??null)};}),costCoverage:{reported:r.filter(x=>Number.isFinite(x.receipt?.cost?.reportedUsd)).length,estimated:r.filter(x=>Number.isFinite(x.receipt?.cost?.estimatedUsd)).length,billed:r.filter(x=>Number.isFinite(x.receipt?.cost?.billedUsd)).length},reportedUsd:r.length===scheduled.length&&r.every(x=>Number.isFinite(x.receipt?.cost?.reportedUsd))?r.reduce((n,x)=>n+x.receipt.cost.reportedUsd,0):null,knownReportedSubtotalUsd:r.reduce((n,x)=>n+(x.receipt?.cost?.reportedUsd??0),0),estimatedUsd:r.length===scheduled.length&&r.every(x=>Number.isFinite(x.receipt?.cost?.estimatedUsd))?r.reduce((n,x)=>n+x.receipt.cost.estimatedUsd,0):null,knownEstimatedSubtotalUsd:r.reduce((n,x)=>n+(x.receipt?.cost?.estimatedUsd??0),0),billedUsd:null,usage:r.map(x=>({id:x.id,...x.receipt?.usage})),invalidReasons:r.filter(x=>!x.validity.valid).map(x=>({id:x.id,problems:x.validity.problems}))};}}
 const paired=Object.fromEntries(plan.hosts.map(host=>[host,clusterSummary(plan,rows,host)]));
 const result={phase:plan.phase,identity:plan.identity,slotStates,hosts:groups,paired,interpretation:'Within-host paired descriptive results; task-cluster uncertainty required before a benefit claim. Unknown billed costs remain null. Invalid treatments/controls are not causal estimates.'};await json(join(output,'summary.json'),result);return result;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){const o=args(process.argv.slice(2));if(!o.out)throw Error('--out is required');const result=await({freeze,run,summarize}[o.command]?.(o)??Promise.reject(Error('Unknown command')));console.log(JSON.stringify(o.command==='freeze'?{planPath:join(resolve(o.out),'plan.json'),phase:result.phase,scheduled:result.schedule.length,hosts:result.hosts}:result));}
