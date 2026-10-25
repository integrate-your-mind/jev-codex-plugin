import { execFileSync, spawn } from 'node:child_process';
import { mkdir, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const sharedNodeModules = path.join(repoRoot, 'source/jev-workflows/node_modules');
const nodeLoader = path.join(sharedNodeModules, 'tsx/dist/loader.mjs');

function check(name, passed, error) {
  return {name, passed: Boolean(passed), ...(passed || !error ? {} : {error: String(error?.message ?? error)})};
}

async function materializeRevision(workspace, revision) {
  await mkdir(workspace, {recursive: true});
  const archive = execFileSync('git', ['archive', revision, 'source/jev-workflows'], {cwd: repoRoot, maxBuffer: 64 * 1024 * 1024});
  execFileSync('tar', ['-x', '--strip-components=2', '-C', workspace], {cwd: repoRoot, input: archive});
  await prepareRuntime(workspace);
  return workspace;
}

export async function prepareRuntime(workspace) {
  const nodeModules = path.join(workspace, 'node_modules');
  try {
    const target = await readlink(nodeModules);
    const resolvedTarget = path.resolve(path.dirname(nodeModules), target);
    if (resolvedTarget !== sharedNodeModules) throw new Error(`candidate node_modules points outside shared dependency runtime: ${resolvedTarget}`);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    await symlink(sharedNodeModules, nodeModules, 'dir');
  }
  return {nodeModules};
}

async function executeNode(workspace, source, timeoutMs = 8_000) {
  const tempDir = await fsMkdtemp('jev-graph-grader-');
  const script = path.join(tempDir, 'grader.mjs');
  await writeFile(script, source);
  try {
    return await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--import', nodeLoader, script, workspace, tempDir], {
        cwd: workspace,
        env: {PATH: process.env.PATH, NODE_ENV: 'test'},
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = ''; let stderr = ''; let timedOut = false; let settled = false;
      const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
      const finishReject = error => { if (settled) return; settled = true; clearTimeout(timer); reject(error); };
      child.stdout.on('data', chunk => { stdout += chunk; });
      child.stderr.on('data', chunk => { stderr += chunk; });
      child.once('error', error => finishReject(error));
      child.once('close', code => {
        if (settled) return;
        clearTimeout(timer);
        if (timedOut) return finishReject(new Error(`grader timed out after ${timeoutMs}ms`));
        if (code !== 0) return finishReject(new Error(`grader exited ${code}: ${stderr || stdout}`));
        try { settled = true; resolve(JSON.parse(stdout)); } catch (error) { finishReject(new Error(`invalid grader output: ${error.message}; ${stderr}; ${stdout}`)); }
      });
    });
  } finally {
    await rm(tempDir, {recursive: true, force: true});
  }
}

async function fsMkdtemp(prefix) {
  const { mkdtemp } = await import('node:fs/promises');
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

const catalogPrompt = 'A hook event supplies the current tool choices while the same session has an older saved task context. Preserve the current event choices, reject duplicate and malformed entries instead of coercing them, and keep the decision input bounded and redacted before the service boundary.';
const diagnosticsPrompt = 'A provider response is structurally valid JSON but contains invalid decision payloads. Preserve precise validation reasons through the provider and service boundary for several failure variants, while keeping request credentials and evidence redacted.';
const credentialPrompt = 'A long lived process reads a protected credential file while the credential is rotated. Refresh it at each request, keep redaction and outbound authorization on one immutable snapshot, and prevent old cache or in flight results from crossing the rotation.';

const catalogGrader = String.raw`
const workspace = process.argv[2];
const runtime = process.argv[3];
const { pathToFileURL } = await import('node:url');
const path = await import('node:path');
const { runDecisionHook } = await import(pathToFileURL(path.join(workspace, 'src/decision-hook.ts')).href);
const { updateTaskContext } = await import(pathToFileURL(path.join(workspace, 'src/task-context.ts')).href);
const { configurePolicy } = await import(pathToFileURL(path.join(workspace, 'src/policy.ts')).href);
const root = runtime + '/catalog-data';
const env = {JEV_ENABLED:'1', TYPESAFE_API_KEY:'fake-grader-key', PLUGIN_DATA:root};
await configurePolicy({enabled:true, scope:'workspaces', workspaces:[workspace]}, env);
const scope = {cwd:workspace, sessionId:'catalog-session'};
await updateTaskContext(scope, {operation:'continue', candidateCatalogs:{tool:[{id:'stale_choice', description:'Old saved choice'}]}}, {env});
const calls = [];
const service = { async classifyDecision(input) { calls.push(input); return {status:'assessed', choice:'current_choice', confidence:0.99}; } };
const event = {hook_event_name:'PreToolUse', session_id:'catalog-session', turn_id:'turn-1', tool_use_id:'tool-1', cwd:workspace, tool_name:'Bash', model:'test-model', tool_input:{command:'printf ok'}, candidate_catalog:{tool:[{id:'current_choice', description:'Current event choice'}]}};
const run = async (candidate_catalog, suffix, toolInput = {command:'printf ok'}) => {
  const before = calls.length;
  await runDecisionHook({...event, turn_id:'turn-' + suffix, tool_use_id:'tool-' + suffix, candidate_catalog, tool_input:toolInput}, {env, service, hookTimeoutMs:4000});
  return calls[before];
};
const current = await run({tool:[{id:'current_choice', description:'Current event choice'}]}, 'current', {command:'printf fake-grader-key'});
const duplicate = await run({tool:[{id:'first', description:'First'}, {id:'first', description:'Conflicting duplicate'}]}, 'duplicate');
const malformed = await run({tool:[{id:'bad-availability', description:'Bad', available:'yes'}]}, 'malformed');
const encodedCurrent = JSON.stringify(current ?? {});
const contextOf = input => { try { return JSON.parse(input?.context ?? '{}'); } catch { return {}; } };
const duplicateContext = contextOf(duplicate);
const malformedContext = contextOf(malformed);
const checks = [
  {name:'current event catalog wins over stale saved catalog', passed:current?.candidates?.map(candidate => candidate.id).join(',') === 'current_choice' && !encodedCurrent.includes('stale_choice')},
  {name:'duplicate IDs fall back instead of resolving by order', passed:duplicateContext.candidateCatalog?.source === 'fallback:invalid_or_insufficient_catalog' && duplicate?.candidates?.map(candidate => candidate.id).join(',') === 'proceed,reconsider,gather_evidence'},
  {name:'non-boolean availability falls back instead of coercing', passed:malformedContext.candidateCatalog?.source === 'fallback:invalid_or_insufficient_catalog' && malformed?.candidates?.map(candidate => candidate.id).join(',') === 'proceed,reconsider,gather_evidence'},
  {name:'service input is bounded and redacted', passed:Buffer.byteLength(JSON.stringify(current ?? {})) < 48_000 && !encodedCurrent.includes('fake-grader-key')},
];
console.log(JSON.stringify({passed:checks.every(check => check.passed), checks, observed:{current:current?.candidateCatalog, duplicate:duplicate?.candidateCatalog, malformed:malformed?.candidateCatalog}}));
`;

const diagnosticsGrader = String.raw`
const workspace = process.argv[2];
const runtime = process.argv[3];
const { pathToFileURL } = await import('node:url');
const path = await import('node:path');
const { validateEvaluation } = await import(pathToFileURL(path.join(workspace, 'src/provider.ts')).href);
const { failureQuestions } = await import(pathToFileURL(path.join(workspace, 'src/contracts.ts')).href);
const base = {model:'jev-1.13.0', answers:{category:{type:'choice',choice:'assertion_failure',probabilities:{compile_error:0.1,assertion_failure:0.1,missing_dependency:0.1,unavailable_service:0.1,permission_failure:0.1,insufficient_evidence:0.1},confidence:0.9},reached_assertion:{type:'noul',noul:0.9},missing_context:{type:'noul',noul:0.1}},usage:{input_tokens:1,output_tokens:1}};
const input = {task:'Diagnose the failed command', command:'node run.js', exitCode:1, output:'provider-secret-evidence', evidence:[{id:'evidence-1',text:'provider-secret-evidence'}], mode:'evaluate'};
const cases = [
  ['probability_sum_invalid', base],
  ['choice_unknown', {...base, answers:{...base.answers, category:{...base.answers.category, choice:'not-a-real-choice', probabilities:{compile_error:0.9,assertion_failure:0.02,missing_dependency:0.02,unavailable_service:0.02,permission_failure:0.02,insufficient_evidence:0.02}}}}],
  ['answer_keys_mismatch', {...base, answers:{category:base.answers.category}}],
];
const checks = [];
for (const [expected, raw] of cases) {
  const env = {JEV_ENABLED:'1', TYPESAFE_API_KEY:'provider-secret-evidence', PLUGIN_DATA:runtime + '/diagnostic-data-' + expected};
  const service = (await import(pathToFileURL(path.join(workspace, 'src/service.ts')).href)).createService({env, enabled:true, fetchFn:async () => new Response(JSON.stringify(raw))});
  const result = await service.classifyFailure(input);
  const encoded = JSON.stringify(result);
  checks.push({name:'service preserves ' + expected, passed:result.status === 'unavailable' && result.reasonCode === 'invalid_response' && result.transport?.responseValidationFailure === expected && !encoded.includes('provider-secret-evidence')});
}
console.log(JSON.stringify({passed:checks.every(check => check.passed), checks}));
`;

const credentialGrader = String.raw`
const workspace = process.argv[2];
const runtime = process.argv[3];
const { writeFile, chmod } = await import('node:fs/promises');
const { createHash } = await import('node:crypto');
const { pathToFileURL } = await import('node:url');
const path = await import('node:path');
const { createService } = await import(pathToFileURL(path.join(workspace, 'src/service.ts')).href);
const keyPath = runtime + '/grader-key.env';
const env = {JEV_ENABLED:'1', JEV_API_KEY_FILE:keyPath, PLUGIN_DATA:runtime + '/credential-data'};
await writeFile(keyPath, 'TYPESAFE_API_KEY=first-fake-key' + String.fromCharCode(10)); await chmod(keyPath, 0o600);
const headers = [];
const response = {model:'jev-1.13.0',answers:{category:{type:'choice',choice:'assertion_failure',probabilities:{compile_error:0.01,assertion_failure:0.95,missing_dependency:0.01,unavailable_service:0.01,permission_failure:0.01,insufficient_evidence:0.01},confidence:0.95},reached_assertion:{type:'noul',noul:0.9},missing_context:{type:'noul',noul:0.1}},usage:{input_tokens:1,output_tokens:1}};
const fetchFn = async (_url, init) => { headers.push(init.headers.authorization); await new Promise(resolve => setTimeout(resolve, 30)); return new Response(JSON.stringify(response)); };
const service = createService({env, enabled:true, fetchFn});
const input = {task:'Diagnose the failed command',command:'node run.js',exitCode:1,output:'first-fake-key',evidence:[{id:'evidence-1',text:'first-fake-key'}],mode:'evaluate'};
const firstPromise = service.classifyFailure(input);
await new Promise(resolve => setTimeout(resolve, 10));
await writeFile(keyPath, 'TYPESAFE_API_KEY=second-fake-key' + String.fromCharCode(10)); await chmod(keyPath, 0o600);
const secondPromise = service.classifyFailure(input);
const [first, second] = await Promise.all([firstPromise, secondPromise]);
const encoded = JSON.stringify({first,second});
const firstFingerprint = createHash('sha256').update('first-fake-key').digest('hex');
const secondFingerprint = createHash('sha256').update('second-fake-key').digest('hex');
const checks = [
  {name:'first request uses first credential snapshot',passed:headers[0] === 'Bearer first-fake-key' && first.transport?.credentialFingerprint === firstFingerprint},
  {name:'rotated concurrent request uses second snapshot',passed:headers[1] === 'Bearer second-fake-key' && second.transport?.credentialFingerprint === secondFingerprint},
  {name:'rotation prevents old in-flight coalescing',passed:headers.length === 2 && first.receiptId !== second.receiptId},
  {name:'credentials stay out of assessment receipts',passed:!encoded.includes('first-fake-key') && !encoded.includes('second-fake-key')},
];
console.log(JSON.stringify({passed:checks.every(check => check.passed), checks, observed:{headers,firstStatus:first.status,secondStatus:second.status}}));
`;

export const sourceRoot = '.';
export const bugs = [
  {
    id: 'current-catalog-boundary', prompt: catalogPrompt,
    prefixSha: 'f67f0f35df13cbc0556539e6f86fe14e2c04d6f8', fixSha: '78612994bb856252fc300ffef17421d092f70b52',
    async materialize(workspace, {revision = 'prefix'} = {}) { return materializeRevision(workspace, revision === 'fix' ? this.fixSha : this.prefixSha); },
    async grade(workspace) { try { return await executeNode(workspace, catalogGrader); } catch (error) { return {passed:false, checks:[check('isolated catalog grader completed', false, error)]}; } },
  },
  {
    id: 'provider-validation-diagnostics', prompt: diagnosticsPrompt,
    prefixSha: '540119928ef7c5dd0daa8be446bb1563f1aeec46', fixSha: '5cff2ee98d926fe5e6a63d894537106a15431d6c',
    async materialize(workspace, {revision = 'prefix'} = {}) { return materializeRevision(workspace, revision === 'fix' ? this.fixSha : this.prefixSha); },
    async grade(workspace) { try { return await executeNode(workspace, diagnosticsGrader); } catch (error) { return {passed:false, checks:[check('isolated diagnostics grader completed', false, error)]}; } },
  },
  {
    id: 'credential-rotation-isolation', prompt: credentialPrompt,
    prefixSha: 'f57353ba6bc6288751d5a229e1359194d1b06a4c', fixSha: 'cde4dc8fb16ac8253df65c56aac36922e50be6d9',
    async materialize(workspace, {revision = 'prefix'} = {}) { return materializeRevision(workspace, revision === 'fix' ? this.fixSha : this.prefixSha); },
    async grade(workspace) { try { return await executeNode(workspace, credentialGrader); } catch (error) { return {passed:false, checks:[check('isolated credential grader completed', false, error)]}; } },
  },
];
