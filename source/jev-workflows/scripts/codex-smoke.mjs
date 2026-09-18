import {spawn, execFileSync} from 'node:child_process';
import {createInterface} from 'node:readline';
import {mkdir, writeFile, readFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {resolve, join} from 'node:path';
import assert from 'node:assert/strict';

// Developer integration test: real installed plugin, ephemeral Codex runtime, no generative turn.
const reportDir=resolve(process.argv[2] ?? '../jev-verification');
const fixtureDir=resolve(process.argv[3] ?? '../../work/jev-build/codex-fixture');
await mkdir(reportDir,{recursive:true});
await mkdir(fixtureDir,{recursive:true});
const configNames=JSON.parse(execFileSync('python3',['-c',`import os,json,tomllib,pathlib
p=pathlib.Path(os.environ.get('CODEX_HOME',str(pathlib.Path.home()/'.codex')))/'config.toml'
c=tomllib.loads(p.read_text()) if p.exists() else {}
print(json.dumps({'servers':list(c.get('mcp_servers',{})),'plugins':list(c.get('plugins',{}))}))
`],{encoding:'utf8'}));
const args=['app-server','--stdio','--disable','apps','--disable','remote_plugin'];
for(const name of configNames.servers) args.push('-c',`mcp_servers.${name}.enabled=false`);
for(const name of configNames.plugins) if(!name.startsWith('jev-workflows@')) args.push('-c',`plugins.${name}.enabled=false`);
const child=spawn('codex',args,{cwd:fixtureDir,stdio:['pipe','pipe','pipe'],env:{...process.env,JEV_HOOKS_ENABLED:'0'}});
const pending=new Map(); let nextId=0; let stderr='';
let childFailure;
const rejectPending=error=>{childFailure=error;for(const p of pending.values()){clearTimeout(p.timer);p.reject(error);}pending.clear();};
child.on('error',rejectPending);
child.on('exit',(code,signal)=>rejectPending(new Error(`Codex probe exited: ${code ?? signal}`)));
child.stderr.on('data',b=>{stderr=(stderr+b.toString()).slice(-12000);});
const lines=createInterface({input:child.stdout});
lines.on('line',line=>{
  let message;try{message=JSON.parse(line);}catch{return;}
  if(message.id!==undefined&&pending.has(message.id)) {
    const p=pending.get(message.id);pending.delete(message.id);clearTimeout(p.timer);
    message.error?p.reject(new Error(JSON.stringify(message.error))):p.resolve(message.result);
  } else if(message.id!==undefined&&message.method) {
    // The probe does not approve requests or perform any requested dynamic action.
    child.stdin.write(JSON.stringify({id:message.id,error:{code:-32601,message:'Probe does not handle server requests'}})+'\n');
  }
});
const rpc=(method,params)=>new Promise((resolvePromise,reject)=>{
  if(childFailure){reject(childFailure);return;}
  const id=++nextId;
  const timer=setTimeout(()=>{pending.delete(id);reject(new Error(`Timed out: ${method}`));},45000);
  pending.set(id,{resolve:resolvePromise,reject,timer});
  child.stdin.write(JSON.stringify({id,method,params})+'\n');
});
const report={startedAt:new Date().toISOString(),ephemeral:true,generativeTurns:0};
try {
  report.initialize=await rpc('initialize',{clientInfo:{name:'jev_plugin_probe',title:'Jev plugin integration test',version:'0.2.1'},capabilities:{experimentalApi:true,requestAttestation:false}});
  child.stdin.write(JSON.stringify({method:'initialized',params:{}})+'\n');
  if(process.env.JEV_INSTALL_PLUGIN==='1') report.install=await rpc('plugin/install',{marketplacePath:join(homedir(),'.agents/plugins/marketplace.json'),pluginName:'jev-workflows'});
  const plugin=await rpc('plugin/read',{marketplacePath:join(homedir(),'.agents/plugins/marketplace.json'),pluginName:'jev-workflows'});
  report.plugin=plugin.plugin;
  assert.ok(plugin.plugin.mcpServers.some(n=>n.includes('jev-workflows')));
  assert.equal(plugin.plugin.skills.length,3);
  const hooks=await rpc('hooks/list',{cwds:[fixtureDir]});
  report.hooks=hooks.data.map(entry=>({cwd:entry.cwd,hooks:entry.hooks.filter(h=>JSON.stringify(h).includes('jev-workflows')),errors:entry.errors.filter(e=>JSON.stringify(e).includes('jev-workflows'))}));
  const started=await rpc('thread/start',{cwd:fixtureDir,ephemeral:true});
  const threadId=started.thread.id;
  const status=await rpc('mcpServerStatus/list',{threadId,detail:'full'});
  const found=status.data.find(s=>s.name.includes('jev-workflows'));
  if(!found) throw new Error('Installed plugin MCP server missing from runtime inventory');
  report.mcp=found;
  const localStatus=await rpc('mcpServer/tool/call',{threadId,server:found.name,tool:'jev_status',arguments:{}});
  report.statusCall=localStatus;
  const preview=await rpc('mcpServer/tool/call',{threadId,server:found.name,tool:'classify_failure',arguments:{task:'Diagnose the isolated probe failure',command:'node synthetic-test.mjs',exitCode:1,output:'AssertionError: expected 4, received 3',evidence:[],mode:'preview'}});
  report.previewCall=preview;
  assert.equal(preview.structuredContent?.status,'preview');
  if(process.env.JEV_RUN_LIVE_EVAL==='1') {
    report.liveCall=await rpc('mcpServer/tool/call',{threadId,server:found.name,tool:'classify_failure',arguments:{task:'Diagnose the isolated probe failure',command:'node synthetic-test.mjs',exitCode:1,output:'AssertionError: expected 4, received 3',evidence:[{id:'probe-1',text:'The synthetic test reached an assertion.'}],mode:'evaluate'}});
    assert.equal(report.liveCall.structuredContent?.status,'assessed');
    assert.equal(report.liveCall.structuredContent?.category,'assertion_failure');
  }
  if(process.env.JEV_RUN_LIVE_EVAL==='1' && process.env.JEV_COMPLETION_INPUT){
    const completionInput=JSON.parse(await readFile(process.env.JEV_COMPLETION_INPUT,'utf8'));
    assert.equal(completionInput.mode,'evaluate');
    report.completionCall=await rpc('mcpServer/tool/call',{threadId,server:found.name,tool:'check_completion',arguments:completionInput});
    assert.ok(['assessed','abstained'].includes(report.completionCall.structuredContent?.status));
    assert.equal(report.completionCall.structuredContent?.model,'jev-1.13.0');
    assert.equal(report.completionCall.structuredContent?.receiptPersisted,true);
  }
  report.passed=true;
} catch(error) {
  report.passed=false;report.error=String(error);
  // Retain only a bounded redacted error; never persist environment/config contents.
  report.diagnostic=stderr.replaceAll(process.env.TYPESAFE_API_KEY || '__NO_KEY__','[REDACTED]');
  process.exitCode=1;
} finally {
  for(const p of pending.values()){clearTimeout(p.timer);p.reject(new Error('Probe closed'));}pending.clear();
  lines.close();child.stdin.end();child.kill('SIGTERM');
  await new Promise(r=>{if(child.exitCode!==null)r();else{child.once('exit',r);setTimeout(()=>{child.kill('SIGKILL');r();},2000).unref();}});
  report.finishedAt=new Date().toISOString();
  await writeFile(join(reportDir,'codex-runtime.json'),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({passed:report.passed,error:report.error,report:join(reportDir,'codex-runtime.json')},null,2));
}
