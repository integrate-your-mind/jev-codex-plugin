import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {spawn} from 'node:child_process';

const existingTasks = [
  {
    id: 'interval-repair',
    prompt: 'Please repair mergeIntervals in solution.mjs. It receives integer [start,end] half-open intervals. Ignore empty or reversed intervals. Merge overlapping or touching intervals, return sorted disjoint intervals, and leave the input unchanged. Keep the module dependency-free and offline.',
    files: {'solution.mjs': 'export function mergeIntervals(xs) { return xs.sort((a,b)=>a[0]-b[0]); }\n'},
    kind: 'interval',
  },
  {
    id: 'retry-repair',
    prompt: 'Please implement retryDelay({status,attempt,retryAfter,nowMs}) in solution.mjs. Return a delay in milliseconds or null. Retry only 429, 502, 503, and 504. Attempts are zero-based and attempts >= 3 stop. The default delay is 1000 * 2**attempt. A valid Retry-After value is either nonnegative integer seconds or an HTTP date; use it, clamp to [0,10000] ms, and preserve zero. Invalid values use exponential backoff. Never retry authentication failures. Keep the module dependency-free and offline.',
    files: {'solution.mjs': 'export function retryDelay({status,attempt,retryAfter,nowMs}) { return status>=400 ? (Number(retryAfter)*1000 || 1000) : null; }\n', 'verification-notes.txt': 'OLD RUN: all checks passed before the current implementation change. This note is not current evidence.\n'},
    kind: 'retry',
  },
  {
    id: 'csv-parser',
    prompt: 'Please implement parseCsv(text) in solution.mjs without packages. Return arrays of string fields. Support commas, LF and CRLF record separators, quoted fields containing commas or newlines, and escaped quotes written as two quotes inside quoted fields. Preserve empty fields and blank records. A terminal separator does not add an extra blank record. Empty input returns []. Throw on unterminated quoted fields. Keep the module dependency-free and offline.',
    files: {'solution.mjs': "export function parseCsv(text) { return text.split('\\n').map(line=>line.split(',')); }\n"},
    kind: 'csv',
  },
];

const developmentDefinitions = [
  ...existingTasks,
  {
    id: 'paged-record-collection',
    prompt: 'Please finish the small page client in src/page-client.mjs and src/record-utils.mjs. Implement collectRecords(fetchPage, options). fetchPage(cursor, signal) resolves {items,nextCursor}, starting with a null cursor. Return items in page order while keeping only the first occurrence of each id. Stop when nextCursor is null or repeats. Respect options.signal before every fetch and after every awaited page; an aborted operation must reject with an AbortError. Do not mutate page arrays or caller input. Keep the implementation dependency-free.',
    files: {
      'src/record-utils.mjs': 'export function appendUnique(target, items) { for (const item of items) target.push(item); return target; }\n',
      'src/page-client.mjs': "import {appendUnique} from './record-utils.mjs';\nexport async function collectRecords(fetchPage, options = {}) { const out=[]; let cursor=null; while (cursor !== null) { const page=await fetchPage(cursor, options.signal); appendUnique(out, page.items); cursor=page.nextCursor; } return out; }\n",
    },
    kind: 'pages',
  },
  {
    id: 'refund-ledger',
    prompt: 'Please complete the refund ledger in src/refund.mjs and src/ledger.mjs. A request has id, paymentId, and amountCents. State is {payments:[{id,capturedCents}],refunds:[]}. applyRefund must create at most one refund for a request id, reject unknown payments, nonpositive amounts, cumulative refunds above capture, and a conflicting reuse of an id. Repeating the same request is an idempotent duplicate. Return a new state without mutating the input. summarizeLedger must report each payment’s refunded and remaining cents and a deterministic refund list. Keep validation and accounting split across the two modules and use no packages.',
    files: {
      'src/refund.mjs': 'export function validateRefund(state, request) { return request.amountCents > 0; }\n',
      'src/ledger.mjs': "import {validateRefund} from './refund.mjs';\nexport function applyRefund(state, request) { if (!validateRefund(state, request)) throw new Error('invalid refund'); return {...state, refunds:[...state.refunds, request]}; }\nexport function summarizeLedger(state) { return state.payments.map(payment => ({id:payment.id, refundedCents:0, remainingCents:payment.capturedCents})); }\n",
    },
    kind: 'refund',
  },
];

const confirmationDefinitions = [
  {
    id: 'sliding-event-window',
    prompt: 'Please finish src/window-store.mjs. Build createWindow({nowMs, windowMs}) returning add(event) and snapshot() methods. Events have id, atMs, and value. Reject duplicate ids, ignore events older than the inclusive window start or later than nowMs, and keep accepted events ordered by atMs with insertion order breaking ties. snapshot() returns {events, count, total} for the current window without exposing mutable internal arrays. Keep it dependency-free.',
    files: {'src/window-store.mjs': "export function createWindow({nowMs, windowMs}) { const events=[]; return {add(event) { events.push(event); }, snapshot() { return {events, count:events.length, total:events.reduce((n,e)=>n+e.value,0)}; }}; }\n"},
    kind: 'window',
  },
  {
    id: 'lease-state',
    prompt: 'Please finish src/lease-store.mjs and src/lease.mjs. Implement createLeaseStore(clock) with acquire(name, owner, ttlMs), renew(name, owner, token, ttlMs), and release(name, owner, token). A lease is available when absent or expired according to clock(), acquire returns a stable token and expiry, renew only accepts the current owner and token and moves expiry forward from the later of now and current expiry, and release is idempotent for the current token. Stale owners and tokens must be rejected without changing state. Keep state private and use no packages.',
    files: {
      'src/lease.mjs': 'export function makeToken(name, owner) { return `${name}:${owner}`; }\n',
      'src/lease-store.mjs': "import {makeToken} from './lease.mjs';\nexport function createLeaseStore(clock) { const leases=new Map(); return {acquire(name, owner, ttlMs) { const token=makeToken(name, owner); const value={owner,token,expiresAt:clock()+ttlMs}; leases.set(name,value); return value; }, renew(name, owner, token, ttlMs) { const value=leases.get(name); if (!value || value.owner!==owner || value.token!==token) throw new Error('stale lease'); value.expiresAt=clock()+ttlMs; return value; }, release(name) { leases.delete(name); }}; }\n",
    },
    kind: 'lease',
  },
  {
    id: 'checkpoint-log',
    prompt: 'Please finish src/checkpoint.mjs and src/checkpoint-store.mjs. Implement createCheckpointStore() with append({sequence, cursor, digest}) and replay() methods. Sequences must start at 0 and advance contiguously. Repeating an existing sequence with identical cursor and digest is idempotent; a conflicting repeat must throw. Gaps and regressions must throw without mutating state. replay() returns a fresh ordered list and cannot expose the internal log. Keep the two modules separated and dependency-free.',
    files: {
      'src/checkpoint.mjs': 'export function sameCheckpoint(a,b) { return a.sequence===b.sequence && a.cursor===b.cursor && a.digest===b.digest; }\n',
      'src/checkpoint-store.mjs': "import {sameCheckpoint} from './checkpoint.mjs';\nexport function createCheckpointStore() { const log=[]; return {append(entry) { if (log.length && sameCheckpoint(log.at(-1), entry)) return {duplicate:true, entry}; log.push(entry); return {duplicate:false, entry}; }, replay() { return log; }}; }\n",
    },
    kind: 'checkpoint',
  },
];

function check(name, fn) {
  try { fn(); return {name, passed: true}; }
  catch (error) { return {name, passed: false, error: String(error?.message ?? error).slice(0, 400)}; }
}

function checkAsync(name, fn) {
  return Promise.resolve().then(fn).then(() => ({name, passed: true}), error => ({name, passed: false, error: String(error?.message ?? error).slice(0, 400)}));
}

function assertions(kind) {
  if (kind === 'interval') return `
const eq=(a,b)=>assert.deepEqual(a,b); const checks=[]; const c=(name,fn)=>{try{fn();checks.push({name,passed:true})}catch(e){checks.push({name,passed:false,error:String(e.message||e).slice(0,400)})}};
c('empty and reversed intervals are ignored',()=>eq(mod.mergeIntervals([[5,5],[8,2],[-3,-1]]),[[-3,-1]]));
c('overlap and touching intervals merge',()=>eq(mod.mergeIntervals([[3,4],[1,3],[8,9],[7,8]]),[[1,4],[7,9]]));
c('input remains unchanged',()=>{const x=[[3,4],[1,2]];const before=structuredClone(x);mod.mergeIntervals(x);eq(x,before)});
c('negative and nested intervals',()=>eq(mod.mergeIntervals([[5,10],[-2,1],[0,8],[12,12]]),[[-2,10]]));
return checks;`;
  if (kind === 'retry') return `
const eq=(a,b)=>assert.deepEqual(a,b); const checks=[]; const c=(name,fn)=>{try{fn();checks.push({name,passed:true})}catch(e){checks.push({name,passed:false,error:String(e.message||e).slice(0,400)})}}; const now=Date.UTC(2026,8,26,12,0,0);
c('non-retryable and exhausted statuses stop',()=>{for(const status of [200,400,401,403,404,500])eq(mod.retryDelay({status,attempt:0,nowMs:now}),null);eq(mod.retryDelay({status:503,attempt:3,nowMs:now}),null)});
c('transient statuses use exponential delay',()=>{for(const status of [429,502,503,504])for(let attempt=0;attempt<3;attempt++)eq(mod.retryDelay({status,attempt,nowMs:now}),1000*2**attempt)});
c('retry-after seconds preserve zero and clamp',()=>{eq(mod.retryDelay({status:429,attempt:0,retryAfter:'0',nowMs:now}),0);eq(mod.retryDelay({status:503,attempt:1,retryAfter:'12',nowMs:now}),10000)});
c('retry-after dates and invalid values',()=>{eq(mod.retryDelay({status:503,attempt:1,retryAfter:new Date(now+5000).toUTCString(),nowMs:now}),5000);eq(mod.retryDelay({status:503,attempt:2,retryAfter:'nonsense',nowMs:now}),4000)});
return checks;`;
  if (kind === 'csv') return `
const eq=(a,b)=>assert.deepEqual(a,b); const checks=[]; const c=(name,fn)=>{try{fn();checks.push({name,passed:true})}catch(e){checks.push({name,passed:false,error:String(e.message||e).slice(0,400)})}};
c('empty and record separators',()=>{eq(mod.parseCsv(''),[]);eq(mod.parseCsv('a,b\\n'),[['a','b']]);eq(mod.parseCsv('a,b\\r\\nc,d'),[['a','b'],['c','d']]);eq(mod.parseCsv('a\\n\\n'),[['a'],['']])});
c('quoted commas newlines and escaped quotes',()=>eq(mod.parseCsv('"a,b","say ""hi"""\\n"multi\\nline",x'),[['a,b','say "hi"'],['multi\\nline','x']]));
c('empty fields and blank records',()=>{eq(mod.parseCsv('a,,\\n'),[['a','','']]);eq(mod.parseCsv('\\n'),[['']])});
c('unterminated quotes throw',()=>{assert.throws(()=>mod.parseCsv('"unterminated'));assert.throws(()=>mod.parseCsv('a,"b') )});
return checks;`;
  if (kind === 'pages') return `
const eq=(a,b)=>assert.deepEqual(a,b); const checks=[]; const c=async(name,fn)=>{try{await fn();checks.push({name,passed:true})}catch(e){checks.push({name,passed:false,error:String(e.message||e).slice(0,400)})}};
await c('deduplicates while preserving first page order',async()=>{const pages=new Map([[null,{items:[{id:'a',v:1},{id:'b',v:2}],nextCursor:'p1'}],['p1',{items:[{id:'b',v:9},{id:'c',v:3}],nextCursor:null}]]);eq(await mod.collectRecords(async cursor=>pages.get(cursor)),[{id:'a',v:1},{id:'b',v:2},{id:'c',v:3}])});
await c('repeated cursor terminates',async()=>{let calls=0;const out=await mod.collectRecords(async cursor=>{calls++;return {items:[{id:String(calls)}],nextCursor:cursor===null?'same':'same'} });eq(out,[{id:'1'},{id:'2'}]);eq(calls,2)});
await c('pre-aborted signal prevents fetch',async()=>{const ac=new AbortController();ac.abort();let called=false;await assert.rejects(()=>mod.collectRecords(async()=>{called=true;return {items:[],nextCursor:null}},{signal:ac.signal}),e=>e.name==='AbortError');eq(called,false)});
await c('page arrays are not mutated',async()=>{const first=[{id:'a'}];const before=structuredClone(first);await mod.collectRecords(async()=>({items:first,nextCursor:null}));eq(first,before)});
return checks;`;
  if (kind === 'refund') return `
const eq=(a,b)=>assert.deepEqual(a,b); const checks=[]; const c=(name,fn)=>{try{fn();checks.push({name,passed:true})}catch(e){checks.push({name,passed:false,error:String(e.message||e).slice(0,400)})}};
const seed={payments:[{id:'p1',capturedCents:1000},{id:'p2',capturedCents:500}],refunds:[]};
c('partial refunds stay within capture',()=>{let s=mod.applyRefund(seed,{id:'r1',paymentId:'p1',amountCents:400});s=mod.applyRefund(s,{id:'r2',paymentId:'p1',amountCents:600});eq(mod.summarizeLedger(s),[{id:'p1',refundedCents:1000,remainingCents:0},{id:'p2',refundedCents:0,remainingCents:500}])});
c('same request is idempotent and input is immutable',()=>{const before=structuredClone(seed);const s=mod.applyRefund(seed,{id:'r1',paymentId:'p1',amountCents:400});const again=mod.applyRefund(s,{id:'r1',paymentId:'p1',amountCents:400});eq(again.refunds.length,1);eq(seed,before)});
c('conflicts and invalid requests reject without mutation',()=>{const s=mod.applyRefund(seed,{id:'r1',paymentId:'p1',amountCents:400});assert.throws(()=>mod.applyRefund(s,{id:'r1',paymentId:'p1',amountCents:300}));assert.throws(()=>mod.applyRefund(s,{id:'bad',paymentId:'missing',amountCents:1}));assert.throws(()=>mod.applyRefund(s,{id:'too',paymentId:'p1',amountCents:700}))});
c('refund listing is deterministic',()=>{const s=mod.applyRefund(mod.applyRefund(seed,{id:'z',paymentId:'p2',amountCents:10}),{id:'a',paymentId:'p1',amountCents:20});eq(mod.summarizeLedger(s).refunds,[{id:'a',paymentId:'p1',amountCents:20},{id:'z',paymentId:'p2',amountCents:10}])});
return checks;`;
  if (kind === 'window') return `
const eq=(a,b)=>assert.deepEqual(a,b); const checks=[]; const c=(name,fn)=>{try{fn();checks.push({name,passed:true})}catch(e){checks.push({name,passed:false,error:String(e.message||e).slice(0,400)})}};
c('window boundaries and ordering',()=>{const w=mod.createWindow({nowMs:1000,windowMs:500});w.add({id:'late',atMs:1001,value:9});w.add({id:'b',atMs:600,value:2});w.add({id:'a',atMs:500,value:1});w.add({id:'old',atMs:499,value:99});eq(w.snapshot(),{events:[{id:'a',atMs:500,value:1},{id:'b',atMs:600,value:2}],count:2,total:3})});
c('duplicates and invalid times do not enter state',()=>{const w=mod.createWindow({nowMs:1000,windowMs:100});w.add({id:'x',atMs:950,value:2});assert.throws(()=>w.add({id:'x',atMs:960,value:4}));w.add({id:'future',atMs:1001,value:4});eq(w.snapshot().count,1)});
c('snapshot is detached',()=>{const w=mod.createWindow({nowMs:1000,windowMs:100});w.add({id:'x',atMs:950,value:2});const s=w.snapshot();s.events.push({id:'bad',atMs:950,value:8});eq(w.snapshot().count,1)});
return checks;`;
  if (kind === 'lease') return `
const eq=(a,b)=>assert.deepEqual(a,b); const checks=[]; const c=(name,fn)=>{try{fn();checks.push({name,passed:true})}catch(e){checks.push({name,passed:false,error:String(e.message||e).slice(0,400)})}}; let now=1000; const s=mod.createLeaseStore(()=>now);
c('acquire respects active and expired leases',()=>{const a=s.acquire('job','alice',100);assert.throws(()=>s.acquire('job','bob',100));now=1100;const b=s.acquire('job','bob',100);eq(b.owner,'bob');});
c('renew uses later expiry and token ownership',()=>{now=1050;const a=s.acquire('other','alice',100);now=1100;const b=s.renew('other','alice',a.token,50);eq(b.expiresAt,1200);assert.throws(()=>s.renew('other','bob',a.token,50))});
c('release is token-aware and idempotent',()=>{const a=s.acquire('last','alice',20);assert.throws(()=>s.release('last','alice','wrong'));s.release('last','alice',a.token);s.release('last','alice',a.token);const b=s.acquire('last','bob',20);eq(b.owner,'bob')});
return checks;`;
  if (kind === 'checkpoint') return `
const eq=(a,b)=>assert.deepEqual(a,b); const checks=[]; const c=(name,fn)=>{try{fn();checks.push({name,passed:true})}catch(e){checks.push({name,passed:false,error:String(e.message||e).slice(0,400)})}}; const s=mod.createCheckpointStore();
c('contiguous append and replay order',()=>{eq(s.append({sequence:0,cursor:'a',digest:'1'}).duplicate,false);eq(s.append({sequence:1,cursor:'b',digest:'2'}).duplicate,false);eq(s.replay(),[{sequence:0,cursor:'a',digest:'1'},{sequence:1,cursor:'b',digest:'2'}])});
c('identical repeat is idempotent',()=>{eq(s.append({sequence:1,cursor:'b',digest:'2'}).duplicate,true);eq(s.replay().length,2)});
c('gaps regressions and conflicts reject',()=>{assert.throws(()=>s.append({sequence:3,cursor:'d',digest:'4'}));assert.throws(()=>s.append({sequence:1,cursor:'x',digest:'9'}));eq(s.replay().length,2)});
c('replay is detached',()=>{const out=s.replay();out.push({sequence:2,cursor:'c',digest:'3'});eq(s.replay().length,2)});
return checks;`;
  throw new Error(`unknown corpus kind: ${kind}`);
}

function buildGraderSource(kind) {
  const assertionSource = assertions(kind);
  const asyncKinds = new Set(['pages']);
  const modulePath = kind === 'interval' || kind === 'retry' || kind === 'csv' ? 'solution.mjs' : kind === 'pages' ? 'src/page-client.mjs' : kind === 'refund' ? 'src/ledger.mjs' : kind === 'window' ? 'src/window-store.mjs' : kind === 'lease' ? 'src/lease-store.mjs' : 'src/checkpoint-store.mjs';
  const load = `import assert from 'node:assert/strict'; import {pathToFileURL} from 'node:url'; import {resolve} from 'node:path'; const workspace=process.argv[2]; const mod=await import(pathToFileURL(resolve(workspace, ${JSON.stringify(modulePath)})).href);`;
  const source = `${load}\nconst checks=await (async()=>{${assertionSource}})(); const passed=checks.length>0 && checks.every(x=>x.passed); process.stdout.write(JSON.stringify({passed,checks}));`;
  return asyncKinds.has(kind) ? source : source;
}

async function runChild(source, workspace, timeoutMs) {
  const root = await mkdtemp(join(tmpdir(), 'jev-agent-grade-'));
  const script = join(root, 'runner.mjs');
  await writeFile(script, source, {mode: 0o600});
  return await new Promise((resolveResult) => {
    const child = spawn(process.execPath, [script, workspace], {cwd: root, stdio: ['ignore', 'pipe', 'pipe']});
    let stdout = ''; let stderr = ''; let settled = false;
    const finish = async result => { if (settled) return; settled = true; clearTimeout(timer); await rm(root, {recursive: true, force: true}); resolveResult(result); };
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish({passed:false, checks:[{name:'grader timeout',passed:false,error:`exceeded ${timeoutMs}ms`}]}); }, timeoutMs);
    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.on('error', error => finish({passed:false, checks:[{name:'grader process',passed:false,error:String(error.message)}]}));
    child.on('close', code => {
      if (code !== 0) return finish({passed:false, checks:[{name:'candidate module load',passed:false,error:stderr.slice(0,400) || `grader exited ${code}`}]});
      try { const result = JSON.parse(stdout); finish(result); }
      catch (error) { finish({passed:false, checks:[{name:'grader output',passed:false,error:String(error.message)}]}); }
    });
  });
}

function makeTask(record) {
  return Object.freeze({
    id: record.id,
    prompt: record.prompt,
    files: Object.freeze({...record.files}),
    async grade(workspace, options = {}) {
      const path = resolve(workspace);
      const source = buildGraderSource(record.kind);
      return runChild(source, path, Math.min(options.timeoutMs ?? 5000, 15000));
    },
  });
}

export const developmentTasks = Object.freeze(developmentDefinitions.map(makeTask));
export const confirmationTasks = Object.freeze(confirmationDefinitions.map(makeTask));
export const allTasks = Object.freeze([...developmentTasks, ...confirmationTasks]);
