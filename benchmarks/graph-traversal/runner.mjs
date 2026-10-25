import {createHash, randomUUID} from 'node:crypto';
import {mkdir, readFile, writeFile, readdir, cp, rm, stat, link, rename, appendFile} from 'node:fs/promises';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {performance} from 'node:perf_hooks';
import {cpus, loadavg} from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');
const sha = value => createHash('sha256').update(value).digest('hex');
const ARMS = ['graph', 'cheap', 'jev'];
const ORDERS = [['graph','cheap','jev'], ['cheap','jev','graph'], ['jev','graph','cheap'], ['graph','jev','cheap'], ['jev','cheap','graph'], ['cheap','graph','jev']];
const MODEL = {codex: 'gpt-6-astra', qq: 'openai-codex/gpt-6-astra'};
const ROW_KEYS = ['id','host','bugId','repetition','arm','model','effort','promptHash','prefixSha','fixSha'];
const taskPrompt = prompt => prompt + '\n\nUse project_graph to inspect dependency neighbors and source before making the repair. Run the relevant local checks.';
const same = (a,b) => JSON.stringify(a) === JSON.stringify(b);
const sumKnown = values => { const known = values.filter(Number.isFinite); return {known: known.length, subtotal: known.length ? known.reduce((a,b) => a+b, 0) : null}; };
const median = values => { const a = [...values].filter(Number.isFinite).sort((a,b) => a-b); return a.length ? (a[Math.floor((a.length-1)/2)] + a[Math.floor(a.length/2)])/2 : null; };
const distribution = values => { const a = values.filter(Number.isFinite); return {count:a.length, median:median(a), min:a.length?Math.min(...a):null, max:a.length?Math.max(...a):null}; };
async function exists(path) { try { await stat(path); return true; } catch(e) { if(e.code === 'ENOENT') return false; throw e; } }
async function save(path, value, exclusive = true) {
  await mkdir(dirname(path), {recursive:true, mode:0o700});
  const temp = path + '.' + randomUUID() + '.tmp';
  try {
    await writeFile(temp, JSON.stringify(value,null,2)+'\n', {flag:'wx', mode:0o600});
    if(exclusive) await link(temp,path); else await rename(temp,path);
  } finally { await rm(temp,{force:true}); }
}
async function hashes(path, prefix = '') {
  const out = {};
  for(const d of (await readdir(path,{withFileTypes:true})).sort((a,b) => a.name.localeCompare(b.name))) {
    if(['node_modules','.git'].includes(d.name)) continue;
    const relative = join(prefix,d.name), child = join(path,d.name);
    if(d.isDirectory()) Object.assign(out,await hashes(child,relative));
    else if(d.isFile()) out[relative] = sha(await readFile(child));
    else throw Error('Unsupported prototype link: '+relative);
  }
  return out;
}
async function identities(hosts) {
  const paths = ['SPEC.md','bugs.mjs','runner.mjs',...hosts.map(h => 'adapters/'+h+'.mjs')];
  const out = {};
  for(const p of paths) out[p] = sha(await readFile(join(HERE,p)));
  return out;
}
export function validatePlan(plan) {
  if(!Array.isArray(plan.hosts) || !plan.hosts.length || new Set(plan.hosts).size !== plan.hosts.length || plan.hosts.some(h => !MODEL[h])) throw Error('Invalid frozen hosts');
  if(!Number.isSafeInteger(plan.repetitions) || plan.repetitions < 1) throw Error('Invalid frozen repetitions');
  const bugs = new Map(plan.bugs.map(b => [b.id,b]));
  if(!bugs.size || bugs.size !== plan.bugs.length) throw Error('Invalid frozen bugs');
  const ids = new Set(), coordinates = new Set();
  for(const row of plan.schedule) {
    const bug = bugs.get(row.bugId);
    if(ids.has(row.id)) throw Error('Duplicate scheduled ID');
    ids.add(row.id);
    const coordinate = JSON.stringify([row.host,row.bugId,row.repetition,row.arm]);
    if(coordinates.has(coordinate)) throw Error('Duplicate scheduled coordinate');
    coordinates.add(coordinate);
    if(!bug || !plan.hosts.includes(row.host) || !ARMS.includes(row.arm) || !Number.isSafeInteger(row.repetition) || row.repetition < 0 || row.repetition >= plan.repetitions || row.model !== MODEL[row.host] || row.effort !== 'high') throw Error('Unexpected frozen configuration');
    for(const key of ['promptHash','prefixSha','fixSha']) if(row[key] !== bug[key]) throw Error('Frozen bug provenance mismatch');
  }
  for(const host of plan.hosts) for(const bug of plan.bugs) for(let repetition=0; repetition<plan.repetitions; repetition++) for(const arm of ARMS) {
    if(!coordinates.has(JSON.stringify([host,bug.id,repetition,arm]))) throw Error('Missing scheduled arm');
  }
}
export async function freeze(options) {
  const output = resolve(options.out), phase = options.phase ?? 'development';
  if(!['plumbing','development'].includes(phase)) throw Error('Invalid phase');
  if(await exists(join(output,'plan.json'))) throw Error('Cohort already frozen');
  const hosts = (options.hosts ?? 'codex,qq').split(',');
  if(new Set(hosts).size !== hosts.length || hosts.some(h => !MODEL[h])) throw Error('Invalid hosts');
  const repetitions = Number(options.repetitions ?? (phase === 'plumbing' ? 1 : 5));
  const timeoutMs = Number(options['timeout-ms'] ?? 480000);
  if(!Number.isSafeInteger(repetitions) || repetitions < 1 || !Number.isFinite(timeoutMs) || timeoutMs <= 0) throw Error('Invalid repetitions/deadline');
  const {bugs} = await import('./bugs.mjs');
  const selected = options.bugs ? bugs.filter(b => options.bugs.split(',').includes(b.id)) : phase === 'plumbing' ? bugs.slice(0,1) : bugs;
  if(!selected.length) throw Error('No bugs selected');
  await mkdir(output,{recursive:true,mode:0o700});
  const engine = join(output,'engine');
  await cp(join(ROOT,'prototypes/project-graph'),engine,{recursive:true,errorOnExist:true,force:false,filter:p => !p.split('/').some(x => ['node_modules','.git'].includes(x))});
  if(!await exists(join(engine,'dist/server.mjs'))) throw Error('Build experimental graph server before freezing');
  const fixtures = {};
  for(const bug of selected) {
    const workspace = join(output,'fixtures',bug.id);
    await bug.materialize(workspace);
    fixtures[bug.id] = {path:workspace, hashes:await hashes(workspace)};
  }
  const schedule = [];
  const provenance = selected.map(b => ({id:b.id,promptHash:sha(taskPrompt(b.prompt)),prefixSha:b.prefixSha,fixSha:b.fixSha}));
  for(let repetition=0; repetition<repetitions; repetition++) for(let bi=0; bi<selected.length; bi++) for(let hi=0; hi<hosts.length; hi++) {
    const b = provenance[bi], host = hosts[hi];
    for(const arm of ORDERS[(repetition+bi*2+hi*3)%ORDERS.length]) schedule.push({id:randomUUID(),host,bugId:b.id,repetition,arm,model:MODEL[host],effort:'high',promptHash:b.promptHash,prefixSha:b.prefixSha,fixSha:b.fixSha});
  }
  const plan = {schema:'jev-project-graph-study-v1',createdAt:new Date().toISOString(),phase,hosts,repetitions,timeoutMs,arms:ARMS,bugs:provenance,identity:await identities(hosts),engine,engineIdentity:await hashes(engine),fixtures,schedule,environment:{node:process.version,platform:process.platform,arch:process.arch,logicalCpus:cpus().length,loadAverage:loadavg()},maxConcurrentModelTrials:2,costPolicy:'billed cost remains unknown unless reconciled; provider-reported and list-price estimates separate',oldBenchmarkPolicy:'previous goal and cohorts remain paused and immutable'};
  validatePlan(plan);
  await save(join(output,'plan.json'),plan);
  return {out:output,phase,scheduled:schedule.length};
}
async function acquireLease(parent,row,signal) {
  await mkdir(parent,{recursive:true,mode:0o700});
  for(;;) {
    if(signal.aborted) throw Error('Study interrupted while waiting for model slot');
    for(let slot=0; slot<2; slot++) {
      const path = join(parent,String(slot)+'.json');
      try {
        await save(path,{pid:process.pid,rowId:row.id,at:new Date().toISOString()},true);
        return async() => {
          const owner = JSON.parse(await readFile(path,'utf8'));
          if(owner.pid !== process.pid || owner.rowId !== row.id) throw Error('Lease ownership changed');
          await rm(path);
        };
      } catch(e) {
        if(e.code !== 'EEXIST') throw e;
        let owner;
        try { owner = JSON.parse(await readFile(path,'utf8')); } catch(e) { if(e.code === 'ENOENT') continue; throw e; }
        try { process.kill(owner.pid,0); } catch(e) { if(e.code === 'ESRCH') throw Error('Stale model lease requires owned-process reconciliation: '+path); throw e; }
      }
    }
    await new Promise(r => setTimeout(r,150));
  }
}
async function copyArtifact(source,dest) {
  await mkdir(dest,{recursive:true,mode:0o700});
  for(const d of await readdir(source,{withFileTypes:true})) {
    if(['node_modules','.git','.qq'].includes(d.name)) continue;
    const from=join(source,d.name), to=join(dest,d.name);
    if(d.isSymbolicLink()) throw Error('Unexpected artifact symlink: '+d.name);
    if(d.isDirectory()) await copyArtifact(from,to);
    else if(d.isFile()) {
      if((await stat(from)).size > 8*1024*1024) throw Error('Artifact file too large: '+d.name);
      await cp(from,to);
    }
  }
}
export async function graphFacts(trial,receipt={}) {
  const directory = receipt?.graphStateDir ?? join(trial,'graph');
  const tracePath = join(directory,'trace.jsonl');
  let events=[], malformed=0, tracePresent=false;
  if(await exists(tracePath)) {
    tracePresent=true;
    for(const line of (await readFile(tracePath,'utf8')).split('\n').filter(Boolean)) {
      try { events.push(JSON.parse(line)); } catch { malformed++; }
    }
  }
  const receipts = new Map();
  for(const dir of [join(receipt?.jevStateDir ?? join(trial,'jev'),'receipts'),join(directory,'jev','receipts')]) {
    if(!await exists(dir)) continue;
    for(const name of await readdir(dir)) {
      if(!name.endsWith('.json')) continue;
      try {
        const value = JSON.parse(await readFile(join(dir,name),'utf8'));
        if(value.transport?.fetchInvoked) receipts.set(value.receiptId ?? value.transport.providerRequestId ?? name,value);
      } catch { malformed++; }
    }
  }
  const ranks = events.filter(e => e.type === 'rank');
  for(const rank of ranks) {
    const transports = rank.providerTransports ?? [];
    for(let i=0; i<transports.length; i++) {
      const transport = transports[i];
      if(!transport.fetchInvoked) continue;
      const id = rank.providerReceiptIds?.[i] ?? transport.providerRequestId ?? rank.packetHash+':'+i;
      if(!receipts.has(id)) receipts.set(id,{receiptId:id,transport,usage:rank.providerUsage?.[i],model:rank.providerModel});
    }
  }
  const values = [...receipts.values()];
  const input = sumKnown(values.map(v => v.usage?.input_tokens));
  const accountingKnown = tracePresent && !malformed && events.some(e => e.type === 'graph_built') && ranks.every(e => (e.requestedArm !== 'jev' || Array.isArray(e.providerTransports)) && (e.providerReceiptIds ?? []).every(id => receipts.has(id) || (e.providerTransports ?? []).some((t,i) => t.fetchInvoked === false && e.providerReceiptIds?.[i] === id)));
  const durationMs = type => events.filter(e => e.type === type).reduce((n,e) => n + Number(e.durationNs ?? 0)/1e6,0);
  const outputs = events.filter(e => e.type === 'tool_output');
  const operations = events.filter(e => ['search','expand'].includes(e.type));
  const packetsDelivered = outputs.filter(output => ranks.some(rank => rank.packetHash === output.packetHash && rank.graphVersion === output.graphVersion) && operations.some(operation => operation.packetHash === output.packetHash && operation.graphVersion === output.graphVersion && same(operation.nodeIds,output.nodeIds) && Number(operation.atMonotonicNs) <= Number(output.atMonotonicNs)));
  const expansions = events.filter(e => e.type === 'expand');
  const reads = events.filter(e => e.type === 'read');
  return {
    tracePresent,malformedTraceRecords:malformed,traceEvents:events.length,
    operations:events.map(e => e.type),nodeExpansions:expansions.length,nodeReads:reads.length,
    rankedPackets:ranks.length,rankedPacketsDelivered:packetsDelivered.length,
    subsequentReadsOfDeliveredNodes:reads.filter(e => packetsDelivered.some(o => o.graphVersion === e.graphVersion && Number(o.atMonotonicNs) < Number(e.atMonotonicNs) && (o.nodeIds ?? []).some(id => (e.nodeIds ?? []).includes(id)))).length,
    fallbackRanks:ranks.filter(e => e.fallbackReason).length,
    rankArms:[...new Set(ranks.map(e => e.requestedArm))],
    timingsMs:{graphBuild:durationMs('graph_built'),ranking:durationMs('rank'),search:durationMs('search'),expand:durationMs('expand'),read:durationMs('read')},
    jev:{accountingKnown,fetches:accountingKnown?values.length:null,observedFetches:values.length,validatedResponses:values.filter(v => v.transport.validatedResponse).length,requestIds:[...new Set(values.map(v => v.transport.providerRequestId).filter(Boolean))],models:[...new Set(values.map(v => v.model).filter(Boolean))],inputTokensKnownSubtotal:input.subtotal,inputUsageKnown:input.known,receipts:values.length,listPriceEstimateKnownUsd:input.subtotal === null?null:input.subtotal*0.042/1e6,billedUsd:null},
  };
}
export function classifyTrial(row,receipt,graph) {
  const modelResolved = receipt?.resolvedModel === row.model;
  const effortResolved = receipt?.resolvedEffort === row.effort;
  const controlClean = row.arm === 'jev' || (graph?.jev?.accountingKnown === true && graph.jev.fetches === 0);
  const armMatched = !(graph?.rankArms?.length) || graph.rankArms.every(arm => arm === row.arm);
  return {
    configurationValid:modelResolved && effortResolved && controlClean && armMatched,
    configurationDiagnostics:[...(!modelResolved?['resolved_model_mismatch_or_unknown']:[]),...(!effortResolved?['resolved_effort_mismatch_or_unknown']:[]),...(!controlClean?['control_jev_accounting_unknown_or_nonzero']:[]),...(!armMatched?['rank_arm_mismatch']:[])],
    traversalUsed:(graph?.nodeExpansions ?? 0)>0 && (graph?.nodeReads ?? 0)>0 && (graph?.rankedPacketsDelivered ?? 0)>0 && (graph?.subsequentReadsOfDeliveredNodes ?? 0)>0,
  };
}
export async function cleanupOwnedTrial({receipt,workspace,release}) {
  if(receipt?.cleanupRequired || receipt?.isolation?.cleanupRequired) return {workspaceRemoved:false,leaseReleased:false,cleanupError:{workspace,reason:'Owned process termination unconfirmed; lease retained'}};
  let cleanupError=null, workspaceRemoved=false, leaseReleased=false;
  try { await rm(workspace,{recursive:true,force:true}); workspaceRemoved=true; } catch(e) { cleanupError={workspace,message:e.message}; }
  try { await release(); leaseReleased=true; } catch(e) { cleanupError={...(cleanupError ?? {}),leaseMessage:e.message}; }
  return {workspaceRemoved,leaseReleased,cleanupError};
}
export async function claimTrial(path,value) {
  try { await save(path,value,true); return true; } catch(error) { if(error.code === 'EEXIST') return false; throw error; }
}
export async function run(options) {
  const output=resolve(options.out), plan=JSON.parse(await readFile(join(output,'plan.json'),'utf8'));
  validatePlan(plan);
  if(!same(await identities(plan.hosts),plan.identity)) throw Error('Frozen study source changed');
  if(!same(await hashes(plan.engine),plan.engineIdentity)) throw Error('Frozen prototype changed');
  for(const bug of plan.bugs) if(!same(await hashes(plan.fixtures[bug.id].path),plan.fixtures[bug.id].hashes)) throw Error('Frozen pre-fix project changed');
  const {bugs,prepareRuntime} = await import('./bugs.mjs');
  const max=Number(options['max-trials'] ?? Infinity);
  if(max !== Infinity && (!Number.isSafeInteger(max) || max<0)) throw Error('Invalid max-trials');
  const requestedHosts=options.host ? [options.host] : plan.hosts;
  if(requestedHosts.some(host => !plan.hosts.includes(host))) throw Error('Host not in frozen plan');
  const drivers=[];
  try {
    for(const host of requestedHosts) {
      const path=join(output,'drivers',host+'.json');
      await save(path,{pid:process.pid,host,at:new Date().toISOString()},true);
      drivers.push(path);
    }
  } catch(error) { for(const path of drivers) await rm(path,{force:true}); throw error; }
  const bugMap=new Map(bugs.map(b => [b.id,b]));
  const stop=new AbortController(), abort=() => stop.abort();
  process.once('SIGINT',abort); process.once('SIGTERM',abort);
  let executed=0;
  try {
    for(const row of plan.schedule) {
      if(stop.signal.aborted || executed>=max) break;
      if(options.host && row.host!==options.host) continue;
      const trial=join(output,'runs',row.id);
      if(await exists(join(trial,'started.json'))) continue;
      const release=await acquireLease(join(dirname(output),'model-leases'),row,stop.signal);
      const workspace=join('/private/tmp','cedar-'+randomUUID());
      const start=performance.now();
      let receipt=null,grade=null,error=null,graph=null,cleanup=null,claimed=false;
      const timings={};
      try {
        await mkdir(trial,{recursive:true,mode:0o700});
        claimed=await claimTrial(join(trial,'started.json'),{...row,workspace,at:new Date().toISOString(),environment:{loadAverage:loadavg()}});
        if(!claimed) continue;
        await cp(plan.fixtures[row.bugId].path,workspace,{recursive:true,dereference:false});
        await prepareRuntime(workspace);
        timings.fixtureSetupMs=performance.now()-start;
        const bug=bugMap.get(row.bugId);
        console.log(JSON.stringify({type:'started',id:row.id,host:row.host,bug:row.bugId,arm:row.arm,repetition:row.repetition}));
        const adapter=await import(pathToFileURL(join(HERE,'adapters',row.host+'.mjs')));
        const nativeStart=performance.now();
        receipt=await adapter.runTrial({workspace,prompt:taskPrompt(bug.prompt),arm:row.arm,model:row.model,effort:row.effort,timeoutMs:plan.timeoutMs,outputDir:trial,serverPath:join(plan.engine,'dist/server.mjs'),signal:stop.signal,authorizeProvider:true,jevApiKeyFile:row.arm === 'jev' ? process.env.JEV_API_KEY_FILE : null});
        timings.nativeWallMs=performance.now()-nativeStart;
        if(receipt.cleanupRequired || receipt.isolation?.cleanupRequired) throw Error('Owned native work termination unconfirmed');
        const artifactStart=performance.now();
        await copyArtifact(workspace,join(trial,'artifact'));
        const artifactHashes=await hashes(join(trial,'artifact'));
        await save(join(trial,'artifact-identity.json'),artifactHashes);
        await prepareRuntime(join(trial,'artifact'));
        timings.artifactCopyMs=performance.now()-artifactStart;
        const gradeStart=performance.now();
        grade=await bug.grade(join(trial,'artifact'));
        timings.gradingMs=performance.now()-gradeStart;
      } catch(e) { error={name:e.name,message:String(e.message).slice(0,2500)}; }
      finally {
        try { if(claimed) graph=await graphFacts(trial,receipt); } catch(e) { graph={error:e.message,jev:{accountingKnown:false,fetches:null}}; }
        cleanup=await cleanupOwnedTrial({receipt,workspace,release});
      }
      const flags=classifyTrial(row,receipt,graph);
      const result={...row,phase:plan.phase,receipt,grade,error,graph,artifactCorrect:grade?.passed===true,hostCompleted:receipt?.completion===true,completedFix:grade?.passed===true && receipt?.completion===true && flags.configurationValid,totalWallMs:performance.now()-start,timings,interrupted:stop.signal.aborted,...flags,...cleanup,finishedAt:new Date().toISOString()};
      await save(join(trial,'result.json'),result,true);
      await appendFile(join(output,'journal.jsonl'),JSON.stringify(result)+'\n',{mode:0o600});
      console.log(JSON.stringify({type:'finished',id:row.id,host:row.host,bug:row.bugId,arm:row.arm,completedFix:result.completedFix,configurationValid:result.configurationValid,traversalUsed:result.traversalUsed,wallMs:result.totalWallMs,error}));
      executed++;
      if(!cleanup.leaseReleased || (options['stop-on-invalid']==='true' && !result.configurationValid)) break;
    }
  } finally {
    process.removeListener('SIGINT',abort); process.removeListener('SIGTERM',abort);
    for(const path of drivers) { const owner=JSON.parse(await readFile(path,'utf8')); if(owner.pid===process.pid) await rm(path); }
  }
  return {executed};
}
function paired(plan,rows,host,first,second) {
  const relevant=rows.filter(r => r.host===host);
  const differences=[];
  for(const bug of plan.bugs) for(let repetition=0; repetition<plan.repetitions; repetition++) {
    const a=relevant.find(r => r.bugId===bug.id && r.repetition===repetition && r.arm===first);
    const b=relevant.find(r => r.bugId===bug.id && r.repetition===repetition && r.arm===second);
    if(a && b) differences.push({bug:bug.id,repetition,wallMs:b.totalWallMs-a.totalWallMs,completedFixDifference:Number(b.completedFix)-Number(a.completedFix)});
  }
  const perBug=plan.bugs.map(b => {
    const a=relevant.filter(r => r.bugId===b.id && r.arm===first && r.completedFix).length;
    const z=relevant.filter(r => r.bugId===b.id && r.arm===second && r.completedFix).length;
    return {bug:b.id,difference:(z-a)/plan.repetitions,completedFixCountDifference:z-a,scheduledPerArm:plan.repetitions,paired:differences.filter(d => d.bug===b.id).length};
  });
  return {completedFixDifference:perBug.reduce((n,b) => n+b.difference,0)/perBug.length,completedFixCountDifference:perBug.reduce((n,b) => n+b.completedFixCountDifference,0),pairedWallMs:distribution(differences.map(d => d.wallMs)),perBug,pairs:differences};
}
export async function summarize(options) {
  const output=resolve(options.out),plan=JSON.parse(await readFile(join(output,'plan.json'),'utf8'));
  validatePlan(plan);
  const rows=[],unfinished=[];
  for(const row of plan.schedule) {
    const directory=join(output,'runs',row.id),path=join(directory,'result.json');
    if(await exists(path)) {
      const result=JSON.parse(await readFile(path,'utf8'));
      for(const key of ROW_KEYS) if(result[key]!==row[key]) throw Error('Result identity mismatch');
      rows.push(result);
    } else unfinished.push({...row,state:await exists(join(directory,'started.json'))?'started_without_result':'unstarted'});
  }
  const hosts={};
  for(const host of plan.hosts) {
    hosts[host]={};
    for(const arm of ARMS) {
      const scheduled=plan.schedule.filter(r => r.host===host && r.arm===arm),r=rows.filter(r => r.host===host && r.arm===arm);
      const cost=sumKnown(r.map(x => x.receipt?.cost?.reportedUsd));
      const jevInput=sumKnown(r.map(x => x.graph?.jev?.inputTokensKnownSubtotal));
      const jevEstimate=sumKnown(r.map(x => x.graph?.jev?.listPriceEstimateKnownUsd));
      const fetches=sumKnown(r.map(x => x.graph?.jev?.fetches));
      hosts[host][arm]={scheduled:scheduled.length,recorded:r.length,missing:scheduled.length-r.length,completedFixes:r.filter(x=>x.completedFix).length,artifactPasses:r.filter(x=>x.artifactCorrect).length,hostCompleted:r.filter(x=>x.hostCompleted).length,interrupted:r.filter(x=>x.interrupted).length,invalid:r.filter(x=>!x.configurationValid).length,noTraversal:r.filter(x=>!x.traversalUsed).length,wallMs:distribution(r.map(x=>x.totalWallMs)),hostReportedCost:{knownSubtotalUsd:cost.subtotal,coverage:cost.known,totalUsd:cost.known===scheduled.length && scheduled.length?cost.subtotal:null,billedUsd:null},jev:{fetchesKnownSubtotal:fetches.subtotal,accountedTrials:fetches.known,uniqueRequestIds:new Set(r.flatMap(x=>x.graph?.jev?.requestIds??[])).size,knownInputTokens:jevInput.subtotal,inputUsageTrialCoverage:jevInput.known,knownListPriceEstimateUsd:jevEstimate.subtotal,estimateTrialCoverage:jevEstimate.known,billedUsd:null},perBug:plan.bugs.map(b=>{const v=r.filter(x=>x.bugId===b.id);return {bug:b.id,recorded:v.length,scheduled:plan.repetitions,completedFixes:v.filter(x=>x.completedFix).length,wallMs:v.map(x=>x.totalWallMs)};})};
    }
    hosts[host].paired={cheapMinusGraph:paired(plan,rows,host,'graph','cheap'),jevMinusGraph:paired(plan,rows,host,'graph','jev'),jevMinusCheap:paired(plan,rows,host,'cheap','jev')};
  }
  const summary={schema:plan.schema,phase:plan.phase,generatedAt:new Date().toISOString(),identity:plan.identity,hosts,unfinished,independentBugClusters:plan.bugs.length,interpretation:'Small paired historical-bug diagnostic. Repeats cluster by bug. Keep every assigned failure, missing outcome and no-use/fallback. Dollar billing unavailable unless independently reconciled; list prices are estimates only.'};
  await save(join(output,'summary.json'),summary,false);
  return summary;
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const argv=process.argv.slice(2),command=argv.shift(),options={};
  while(argv.length) { const key=argv.shift(); if(!key.startsWith('--')) throw Error('Expected named option'); options[key.slice(2)]=argv.shift(); }
  if(!options.out) throw Error('--out required');
  const method={freeze,run,summarize}[command];
  if(!method) throw Error('Unknown command');
  console.log(JSON.stringify(await method(options)));
}
