import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';

// Independent artifact grader. Run AFTER a trial; never copy into its workspace.
const id = process.argv[2];
const mod = await import(pathToFileURL(resolve('solution.mjs')).href);
let checks = 0;
function eq(actual, expected) { assert.deepEqual(actual, expected); checks++; }
if (id === 'interval-repair') {
  eq(mod.mergeIntervals([]), []);
  eq(mod.mergeIntervals([[3,4],[1,3],[8,9]]), [[1,4],[8,9]]);
  eq(mod.mergeIntervals([[5,5],[7,2],[-3,-1],[-1,0]]), [[-3,0]]);
  let seed=42;
  const rand=()=>{seed=(seed*1664525+1013904223)>>>0;return seed;};
  for(let i=0;i<50;i++) {
    const input=Array.from({length:12},()=>[Number(rand()%21)-10,Number(rand()%21)-10]);
    const original=structuredClone(input);
    const active=new Set();
    for(const [a,b] of input) for(let n=a;n<b;n++) active.add(n);
    const expected=[];
    for(const n of [...active].sort((a,b)=>a-b)) {
      if(expected.length && expected.at(-1)[1]===n) expected.at(-1)[1]=n+1;
      else expected.push([n,n+1]);
    }
    eq(mod.mergeIntervals(input),expected); eq(input,original);
  }
} else if(id==='retry-repair') {
  const nowMs=Date.UTC(2026,8,26,12,0,0);
  for(const status of [200,400,401,403,404,500]) eq(mod.retryDelay({status,attempt:0,nowMs}),null);
  for(const status of [429,502,503,504]) {
    for(let attempt=0;attempt<3;attempt++) eq(mod.retryDelay({status,attempt,nowMs}),1000*2**attempt);
    eq(mod.retryDelay({status,attempt:3,nowMs}),null);
  }
  eq(mod.retryDelay({status:429,attempt:0,retryAfter:'0',nowMs}),0);
  eq(mod.retryDelay({status:503,attempt:1,retryAfter:'12',nowMs}),10000);
  eq(mod.retryDelay({status:503,attempt:1,retryAfter:new Date(nowMs+5000).toUTCString(),nowMs}),5000);
  eq(mod.retryDelay({status:503,attempt:1,retryAfter:new Date(nowMs-5000).toUTCString(),nowMs}),0);
  eq(mod.retryDelay({status:503,attempt:2,retryAfter:'nonsense',nowMs}),4000);
  eq(mod.retryDelay({status:401,attempt:0,retryAfter:'1',nowMs}),null);
} else if(id==='csv-parser') {
  const cases=[['',[]],['a,b\n',[['a','b']]],['a,b\r\nc,d',[['a','b'],['c','d']]],['"a,b","say ""hi"""\n',[['a,b','say "hi"']]],['"multi\nline",x',[['multi\nline','x']]],['a,,\n',[['a','','']]],['\n',[['']]],['a\n\n',[['a'],['']]]];
  for(const [input,expected] of cases) eq(mod.parseCsv(input),expected);
  for(const input of ['"unterminated','a,"b']) {assert.throws(()=>mod.parseCsv(input));checks++;}
} else if(id==='changed-route') {
  const list=[{id:'cheap-us',available:true,cost:1,latencyMs:5,region:'US',capabilities:['read','write']},{id:'slow-eu',available:true,cost:2,latencyMs:200,region:'EU',capabilities:['read','write']},{id:'fast-eu',available:true,cost:3,latencyMs:30,region:'EU',capabilities:['read','write']},{id:'offline',available:false,cost:0,latencyMs:1,region:'EU',capabilities:['read','write']}];
  const before=structuredClone(list);
  eq(mod.selectBackend({required:['write'],region:'EU',maxLatencyMs:50},list),'fast-eu');
  eq(mod.selectBackend({required:['read'],region:'EU',maxLatencyMs:250},list),'slow-eu');
  eq(mod.selectBackend({required:['read'],region:'US',maxLatencyMs:50},list),'cheap-us');
  eq(mod.selectBackend({required:['gpu'],region:'EU',maxLatencyMs:50},list),null);
  eq(mod.selectBackend({required:['read'],region:'EU',maxLatencyMs:20},list),null);
  eq(mod.selectBackend({required:['read'],region:'EU',maxLatencyMs:30},list),'fast-eu');
  eq(mod.selectBackend({required:['read'],region:'EU',maxLatencyMs:100},[{...list[2],id:'z'},{...list[2],id:'a'}]),'a');
  eq(list,before);
} else throw new Error('Unknown benchmark task');
console.log(JSON.stringify({task:id,passed:true,checks}));
