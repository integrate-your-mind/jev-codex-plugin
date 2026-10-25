#!/usr/bin/env node
/* Private decision-level evaluator. It imports each requested source entrypoint
 * in an isolated loader process, sends truth-free native hook events, and keeps
 * an append-only private attempt log. It never grades a coding task. */
import {createHash, randomUUID} from 'node:crypto';
import {constants} from 'node:fs';
import {mkdtemp, open, readFile, readdir, realpath, rm, stat} from 'node:fs/promises';
import {execFileSync, spawnSync} from 'node:child_process';
import {dirname, join, relative, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const dir = dirname(fileURLToPath(import.meta.url));
const defaultBaseline = resolve(dir, '../../source/jev-workflows');
const node = process.execPath;
const isWorker = process.argv.includes('--worker');
// The benchmark's baseline is a content pin. Git HEAD remains provenance only:
// benchmark files may be committed in the same checkout without changing the
// source tree being evaluated.
const expectedBaselineSourceSha256 = '7b805b1784720cf18748c4b0c6d727134eb76713c4b0ebe96fa96cc49b9348e8';
const expectedBaselineEntrypointSha256 = 'c1c42678a526277b8af022dbc279968db29901ff719973fa9db1e746cd5f56dd';

function argValue(args, name, fallback = undefined) {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] && !args[index + 1].startsWith('--') ? args[index + 1] : fallback;
}

function parseArgs() {
  const args = process.argv.slice(2).filter(value => value !== '--worker');
  const live = args.includes('--live');
  const baselineSource = resolve(argValue(args, '--baseline-source', defaultBaseline));
  const repairValue = argValue(args, '--repair-source', process.env.JEV_REPAIR_SOURCE);
  if (!repairValue) throw new Error('--repair-source is required (or set JEV_REPAIR_SOURCE)');
  const repairSource = resolve(repairValue);
  const out = argValue(args, '--out');
  if (!out) throw new Error('usage: run.mjs --dry-run --baseline-source PATH --repair-source PATH --out PATH');
  if (!isAbsolutePath(out)) throw new Error('--out must be an absolute path');
  if (live && (process.env.JEV_RUN_LIVE_EVAL !== '1' || process.env.JEV_LIVE_EVAL_AUTHORIZED !== '1')) {
    throw new Error('live evaluation requires --live plus JEV_RUN_LIVE_EVAL=1 and JEV_LIVE_EVAL_AUTHORIZED=1');
  }
  return {live, baselineSource, repairSource, out: resolve(out), workspace: resolve(argValue(args, '--workspace', process.cwd()))};
}

function isAbsolutePath(value) { return typeof value === 'string' && value.startsWith('/'); }
function hash(value) { return createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex'); }

async function listSourceFiles(root) {
  const files = [];
  async function visit(current) {
    const entries = await readdir(current, {withFileTypes: true});
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) files.push(path);
    }
  }
  await visit(join(root, 'src'));
  for (const name of ['package.json', 'tsconfig.json']) {
    try { if ((await stat(join(root, name))).isFile()) files.push(join(root, name)); } catch { /* source records fail below */ }
  }
  return files.sort();
}

async function digestSource(root) {
  const files = await listSourceFiles(root);
  const digest = createHash('sha256');
  const records = [];
  for (const path of files) {
    const bytes = await readFile(path);
    const name = relative(root, path);
    digest.update(name); digest.update('\0'); digest.update(bytes); digest.update('\0');
    records.push({path: name, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.byteLength});
  }
  return {sha256: digest.digest('hex'), files: records};
}

function gitCommit(root) {
  try { return execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], {encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']}).trim() || null; }
  catch { return null; }
}

async function sourceRecord(arm, root) {
  const canonical = await realpath(root);
  const entry = join(canonical, 'src', 'decision-hook.ts');
  if (!(await stat(entry)).isFile()) throw new Error(`${arm}: missing src/decision-hook.ts`);
  const source = await digestSource(canonical);
  return {arm, sourceRoot: canonical, entrypoint: 'src/decision-hook.ts', gitCommit: gitCommit(canonical), sourceSha256: source.sha256,
    entrypointSha256: source.files.find(file => file.path === 'src/decision-hook.ts')?.sha256 ?? null, fileCount: source.files.length};
}

async function importSource(sourceRoot, moduleName, suffix) {
  if (!process.execArgv.some(arg => arg === '--import' || arg.startsWith('--import='))) throw new Error('source worker requires the pinned tsx loader');
  return import(`${pathToFileURL(join(sourceRoot, 'src', moduleName)).href}?arm=${suffix}`);
}

async function importArmModules(record) {
  const [hook, policy, context, service] = await Promise.all([
    importSource(record.sourceRoot, 'decision-hook.ts', `${record.arm}-hook`), importSource(record.sourceRoot, 'policy.ts', `${record.arm}-policy`), importSource(record.sourceRoot, 'task-context.ts', `${record.arm}-context`), importSource(record.sourceRoot, 'service.ts', `${record.arm}-service`),
  ]);
  if (typeof hook.runDecisionHook !== 'function' || typeof policy.configurePolicy !== 'function' || typeof context.updateTaskContext !== 'function' || typeof service.createService !== 'function') throw new Error(`${record.arm}: native APIs missing`);
  return {runDecisionHook: hook.runDecisionHook, configurePolicy: policy.configurePolicy, updateTaskContext: context.updateTaskContext, createService: service.createService};
}

function eventFor(episode, sessionId, cwd, attemptId) {
  const event = {hook_event_name: episode.event, cwd, session_id: sessionId, event_id: `${attemptId}:event`, turn_id: `${attemptId}:turn`, tool_use_id: `${attemptId}:tool`, agent_id: 'plugin-live-eval', source: 'plugin-live-eval', prompt: episode.prompt, last_assistant_message: episode.final, tool_name: episode.tool, tool_input: episode.input, tool_response: undefined, task_context: episode.taskContext, available_candidates: episode.availableCandidates, question: episode.question};
  if (episode.result !== undefined) event.tool_response = {is_error: episode.family === 'failure-recovery' || /CRITICAL|AssertionError|ENOENT|TypeError/.test(episode.result), output: episode.result, exit_code: episode.family === 'failure-recovery' || /CRITICAL|AssertionError|ENOENT|TypeError/.test(episode.result) ? 1 : 0};
  return event;
}

async function seedContext(modules, episode, env, sessionId, cwd, attemptId) {
  const scope = {cwd, sessionId, agentId: 'plugin-live-eval'};
  const update = {operation: 'replace', rootObjective: episode.taskContext.rootObjective, latestStep: `${episode.question} ${episode.taskContext.latestStep}`, constraints: episode.taskContext.constraints, criteria: episode.taskContext.criteria, corrections: episode.taskContext.corrections, evidenceRefs: episode.taskContext.evidenceRefs, candidateCatalogs: episode.taskContext.candidateCatalog, provenance: {source: 'system', eventId: `${attemptId}:seed`, turnId: `${attemptId}:seed-turn`, agentId: 'plugin-live-eval', timestamp: new Date().toISOString()}};
  const result = await modules.updateTaskContext(scope, update, {env});
  if (!result) throw new Error(`${attemptId}: native task context seed failed`);
  return hash(result);
}

function mockFetch(episode, capture) {
  return async (_url, init) => {
    capture.transportAttempts = (capture.transportAttempts ?? 0) + 1;
    const payload = JSON.parse(init.body);
    capture.payload = structuredClone(payload); capture.outgoingPayload = structuredClone(payload); capture.responseStatus = 200;
    const question = payload.questions?.decision;
    const criteria = question?.criteria ?? {};
    const candidateIds = Object.keys(criteria).filter(id => id !== 'insufficient_evidence');
    const abstain = (episode.family === 'evidence-missing-abstain' && episode.id !== 'evidence-03-clear') || (episode.family === 'completion-claim-boundary' && episode.id !== 'claim-03-supported');
    const choice = abstain ? 'insufficient_evidence' : (candidateIds[0] ?? 'insufficient_evidence');
    const probabilities = Object.fromEntries(Object.keys(criteria).map(id => [id, id === choice ? 0.67 : 0.33 / Math.max(1, Object.keys(criteria).length - 1)]));
    return new Response(JSON.stringify({model: 'jev-1.13.0', answers: {decision: {type: 'choice', choice, probabilities, confidence: abstain ? 0.42 : 0.78}}, usage: {input_tokens: JSON.stringify(payload).length, output_tokens: 64}}), {status: 200, headers: {'content-type': 'application/json', 'x-typesafe-request-id': 'dry-local'} });
  };
}

async function readPrivateServiceReceipt(stateRoot) {
  try {
    const receiptDir = join(stateRoot, 'receipts');
    const names = (await readdir(receiptDir)).filter(name => name.endsWith('.json')).sort().reverse();
    for (const name of names) {
      const value = JSON.parse(await readFile(join(receiptDir, name), 'utf8'));
      if (value?.tool === 'classify_decision') return {status: value.status ?? null, choice: value.choice ?? value.providerChoice ?? null, providerChoice: value.choice ?? value.providerChoice ?? null, confidence: typeof value.confidence === 'number' ? value.confidence : null, probabilities: value.probabilities ?? null, reasonCode: value.reasonCode ?? null, receiptId: typeof value.receiptId === 'string' ? value.receiptId : null, receiptPersisted: true, inputDigest: value.inputDigest ?? null, usage: value.usage ?? null, latencyMs: value.latencyMs ?? null, model: value.model ?? null, providerRequestIdPresent: value.transport?.providerRequestId != null, fetchInvoked: value.transport?.fetchInvoked === true, responseStatus: value.transport?.responseStatus ?? null, validatedResponse: value.transport?.validatedResponse ?? false, responseValidationFailure: value.transport?.responseValidationFailure ?? null, responseValidationDiagnostic: value.transport?.responseValidationDiagnostic ?? null};
    }
  } catch { /* private receipt unavailable is retained as a null measurement */ }
  return null;
}

function deliveredFromOutput(output) {
  const text = output?.hookSpecificOutput?.additionalContext ?? output?.systemMessage ?? '';
  const status = /status=([a-z_]+)/.exec(text)?.[1] ?? 'unavailable';
  const decision = /(?:^|; )decision=([A-Za-z0-9._:-]+)/.exec(text)?.[1] ?? null;
  return {status, decision, confidence: Number(/confidence=([0-9.]+)/.exec(text)?.[1] ?? NaN) || null, textDigest: hash(text), textBytes: Buffer.byteLength(text), neutralAbstention: status === 'abstained' && decision === null};
}

function safeAssessment(value) {
  if (!value) return null;
  return {status: value.status ?? null, choice: value.choice ?? value.providerChoice ?? null, providerChoice: value.choice ?? value.providerChoice ?? null, confidence: typeof value.confidence === 'number' ? value.confidence : null, probabilities: value.probabilities ?? null, reasonCode: value.reasonCode ?? null, receiptId: typeof value.receiptId === 'string' ? value.receiptId : null, receiptPersisted: value.receiptPersisted === true, inputDigest: value.inputDigest ?? null, usage: value.usage ?? null, latencyMs: value.latencyMs ?? null, model: value.model ?? null, providerRequestIdPresent: value.transport?.providerRequestId != null || value.providerRequestIdPresent === true, fetchInvoked: value.fetchInvoked === true || value.transport?.fetchInvoked === true, responseStatus: value.transport?.responseStatus ?? value.responseStatus ?? null, validatedResponse: value.transport?.validatedResponse ?? value.validatedResponse ?? null, responseValidationFailure: value.transport?.responseValidationFailure ?? value.responseValidationFailure ?? null, responseValidationDiagnostic: value.transport?.responseValidationDiagnostic ?? value.responseValidationDiagnostic ?? null};
}

function parity(a, b) {
  if (!a || !b) return false;
  return JSON.stringify({status: a.status, choice: a.choice, confidence: a.confidence, probabilities: a.probabilities, reasonCode: a.reasonCode, receiptId: a.receiptId, usage: a.usage}) === JSON.stringify({status: b.status, choice: b.choice, confidence: b.confidence, probabilities: b.probabilities, reasonCode: b.reasonCode, receiptId: b.receiptId, usage: b.usage});
}

function validateDryProjection(input, episode) {
  if (!input || typeof input.context !== 'string') throw new Error(`${episode.id}: mocked transport saw no hook context`);
  const encoded = input.context;
  const candidateIds = episode.availableCandidates.map(candidate => candidate.id);
  const candidateIdsMatch = candidateIds.every(id => input.candidates.some(candidate => candidate.id === id));
  const rootObjectivePresent = encoded.includes(episode.taskContext.rootObjective);
  const latestStepPresent = encoded.includes(episode.taskContext.latestStep) || (typeof episode.prompt === 'string' && encoded.includes(episode.prompt));
  const evidencePresent = episode.event === 'PreToolUse'
    ? latestStepPresent
    : input.evidence.some(item => item.text.includes(episode.question) || item.text.includes(episode.prompt ?? 'never-present') || item.text.includes(episode.result ?? 'never-present') || item.text.includes(episode.final ?? 'never-present'));
  const oracleAbsent = !encoded.includes('expectedChoice') && !JSON.stringify(input).includes('expectedChoice');
  if (!candidateIdsMatch || !rootObjectivePresent || !latestStepPresent || !evidencePresent || !oracleAbsent) throw new Error(`${episode.id}: dry projection lost task context, candidates, evidence, or truth boundary (${JSON.stringify({candidateIdsMatch, rootObjectivePresent, latestStepPresent, evidencePresent, oracleAbsent})})`);
  return {rootObjectivePresent, latestStepPresent, candidateIdsMatch, evidencePresent, oracleAbsent, candidateCount: input.candidates.length};
}

async function attempt({modules, record, episode, repeat, arm, out, outPath, live, cwd}) {
  const attemptId = `${episode.id}.r${repeat}.${arm}`;
  const sessionId = `plugin-live-eval-${repeat}-${episode.id}-${arm}`;
  const stateRoot = await mkdtemp(join(dirname(outPath), `.state-${attemptId}-`));
  const env = {...process.env, JEV_STATE_DIRECTORY: stateRoot, PLUGIN_DATA: stateRoot, JEV_ENABLED: '1'};
  const startedAt = new Date().toISOString();
  await out.append({kind: 'attempt_started', attemptId, episodeId: episode.id, family: episode.family, questionId: episode.questionId, questionIds: episode.questionIds, repeat, arm, sourceSha256: record.sourceSha256, startedAt});
  let finished;
  const capture = {};
  try {
    await modules.configurePolicy({enabled: true, scope: 'workspaces', workspaces: [cwd], maxHookCallsPerSession: null, maxCallsPerDay: null, maxBytesPerDay: null}, env);
    const contextDigest = await seedContext(modules, episode, env, sessionId, cwd, attemptId);
    const event = eventFor(episode, sessionId, cwd, attemptId);
    if (!live && !env.JEV_API_KEY_FILE && !env.TYPESAFE_API_KEY) env.TYPESAFE_API_KEY = 'dry-run-local-placeholder-key-0123456789abcdef';
    const transport = live ? async (url, init) => { capture.transportAttempts = (capture.transportAttempts ?? 0) + 1; capture.livePayloadDigest = hash(init?.body ?? ''); capture.livePayloadBytes = Buffer.byteLength(String(init?.body ?? '')); try { capture.outgoingPayload = JSON.parse(String(init?.body ?? '')); } catch { capture.outgoingPayload = null; } const response = await fetch(url, init); capture.responseStatus = response.status; return response; } : mockFetch(episode, capture);
    const nativeService = modules.createService({env, fetchFn: transport});
    const service = {async classifyDecision(input, signal) { const result = await nativeService.classifyDecision(input, signal); capture.assessment = structuredClone(result); return result; }};
    const clock = Date.now();
    const output = await modules.runDecisionHook(JSON.stringify(event), {env, service});
    const latencyMs = Date.now() - clock;
    const persisted = await readPrivateServiceReceipt(stateRoot);
    const assessment = safeAssessment(capture.assessment) ?? persisted;
    const delivered = deliveredFromOutput(output);
    if (delivered.status === 'abstained' && delivered.decision !== null) throw new Error(`${attemptId}: abstention emitted directional decision`);
    const modelInput = capture.outgoingPayload ?? null;
    const projection = live ? null : validateDryProjection({context: modelInput?.state?.context, candidates: modelInput?.state?.candidates, evidence: modelInput?.state?.evidence}, episode);
    finished = {kind: 'attempt_finished', attemptId, episodeId: episode.id, family: episode.family, questionId: episode.questionId, questionIds: episode.questionIds, repeat, arm, sourceSha256: record.sourceSha256, startedAt, finishedAt: new Date().toISOString(), status: 'completed', seededContextDigest: contextDigest, eventDigest: hash(event), inputDigest: assessment?.inputDigest ?? null, modelVisibleInput: modelInput, projection, validatedChoice: assessment?.status === 'assessed' ? assessment.choice : null, validatedProviderChoice: assessment?.providerChoice ?? assessment?.choice ?? null, validatedConfidence: assessment?.confidence ?? null, validatedProbabilities: assessment?.probabilities ?? null, modelVisibleDecision: assessment, receiptParity: parity(assessment, persisted), outgoingPayloadDigest: capture.livePayloadDigest ?? (modelInput ? hash(modelInput) : null), outgoingPayloadBytes: capture.livePayloadBytes ?? (modelInput ? Buffer.byteLength(JSON.stringify(modelInput)) : null), delivered, latencyMs, transportAttempts: capture.transportAttempts ?? 0, receipt: {receiptId: assessment?.receiptId ?? null, persisted: assessment?.receiptPersisted === true, providerRequestIdPresent: assessment?.providerRequestIdPresent ?? false, fetchInvoked: assessment?.fetchInvoked ?? false, usage: assessment?.usage ?? null, responseStatus: assessment?.responseStatus ?? capture.responseStatus ?? null, validatedResponse: assessment?.validatedResponse ?? null, responseValidationFailure: assessment?.responseValidationFailure ?? null, responseValidationDiagnostic: assessment?.responseValidationDiagnostic ?? null}};
  } catch (error) {
    finished = {kind: 'attempt_finished', attemptId, episodeId: episode.id, family: episode.family, questionId: episode.questionId, questionIds: episode.questionIds, repeat, arm, sourceSha256: record.sourceSha256, startedAt, finishedAt: new Date().toISOString(), status: 'error', transportAttempts: capture.transportAttempts ?? 0, outgoingPayloadDigest: capture.livePayloadDigest ?? null, error: {name: error?.name ?? 'Error', message: String(error?.message ?? error)}};
  } finally {
    await out.append(finished);
    await rm(stateRoot, {recursive: true, force: true});
  }
  return finished;
}

async function createOutput(path) {
  const handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  return {async append(value) {await handle.writeFile(JSON.stringify(value) + '\n', 'utf8'); await handle.sync();}, async close() {await handle.sync(); await handle.close();}};
}

async function runWorker(config) {
  const episodes = JSON.parse(await readFile(join(dir, 'episodes.json'), 'utf8'));
  const oracle = JSON.parse(await readFile(join(dir, 'oracle.json'), 'utf8'));
  const frozen = JSON.parse(await readFile(join(dir, 'freeze.json'), 'utf8'));
  if (hash(episodes) !== frozen.fixtureSha256 || hash(oracle) !== frozen.oracleSha256) throw new Error('fixture/oracle freeze mismatch');
  const records = await Promise.all([sourceRecord('baseline', config.baselineSource), sourceRecord('repair', config.repairSource)]);
  if (records[0].sourceSha256 !== expectedBaselineSourceSha256 || records[0].entrypointSha256 !== expectedBaselineEntrypointSha256) {
    throw new Error(`baseline source content pin mismatch: source=${records[0].sourceSha256} entrypoint=${records[0].entrypointSha256}`);
  }
  if (records[1].sourceSha256 !== '26958051bf006c7ba490847f21dffa5f9e9f3eb5d1840a4899b9d00485816a3c') throw new Error('repair source content pin mismatch');
  if (records[0].sourceSha256 === records[1].sourceSha256) throw new Error('baseline and repair source hashes are identical; refusing a same-arm evaluation');
  const orderFor = (index, repeat) => ((index % 2 === 0) === (repeat === 1)) ? ['baseline', 'repair'] : ['repair', 'baseline'];
  const header = {schemaVersion: 'plugin-live-eval-run-v2', mode: config.live ? 'live' : 'dry-run', providerCalls: config.live, truthPassedToProvider: false, createdAt: new Date().toISOString(), runtime: {node: process.version, platform: process.platform, arch: process.arch, execPath: process.execPath}, plannedAttempts: episodes.length * 2 * 2, repeats: 2, armOrder: Object.fromEntries(episodes.map((episode, index) => [episode.id, {repeat1: orderFor(index, 1), repeat2: orderFor(index, 2)}])), sourceRecords: records, oracleSha256: hash(oracle), fixtureSha256: hash(episodes), researchQuestionSha256: '63b7eda82324c113b4801a3918fad501ae6a716c8f765714ebc51158dee14b61', note: 'Decision-level diagnostics only; no task-quality, deployment, or provider-superiority claim is produced.'};
  const out = await createOutput(config.out);
  await out.append({kind: 'header', ...header});
  const cwd = await realpath(config.workspace);
  const modules = {baseline: await importArmModules(records[0]), repair: await importArmModules(records[1])};
  const results = [];
  try {
    for (let repeat = 1; repeat <= 2; repeat++) for (let index = 0; index < episodes.length; index++) {
      const episode = episodes[index];
      const order = orderFor(index, repeat);
      for (const arm of order) results.push(await attempt({modules: modules[arm], record: records.find(record => record.arm === arm), episode, repeat, arm, out, outPath: config.out, live: config.live, cwd}));
    }
    const after = await Promise.all(records.map(record => sourceRecord(record.arm, record.sourceRoot)));
    for (let index = 0; index < records.length; index++) if (after[index].sourceSha256 !== records[index].sourceSha256) throw new Error(`${records[index].arm}: source changed during evaluation`);
    const byId = new Map(oracle.episodes.map(row => [row.episodeId, row]));
    const completed = results.filter(row => row.status === 'completed');
    const scored = completed.map(row => { const truth = byId.get(row.episodeId); const dispositionCorrect = row.modelVisibleDecision?.status === truth.expectedDisposition; const rawChoiceCorrect = truth.expectedDisposition === 'assessed' && dispositionCorrect && row.validatedProviderChoice === truth.expectedChoice; const abstentionCorrect = truth.expectedDisposition === 'abstained' && dispositionCorrect && row.validatedChoice === null; const deliveredUsefulChoice = truth.expectedDisposition === 'assessed' && row.delivered.decision === truth.expectedChoice; return {...row, oracle: {expectedChoice: truth.expectedChoice, expectedDisposition: truth.expectedDisposition, dispositionCorrect, rawChoiceCorrect, abstentionCorrect, deliveredUsefulChoice}}; });
    const summary = {kind: 'summary', completedAttempts: completed.length, erroredAttempts: results.length - completed.length, plannedAttempts: header.plannedAttempts, serviceInvocations: completed.filter(row => row.modelVisibleDecision !== null).length, transportAttempts: results.reduce((sum, row) => sum + (row.transportAttempts ?? 0), 0), httpResponses: completed.filter(row => row.receipt.responseStatus !== null).length, validatedResponses: completed.filter(row => row.receipt.validatedResponse === true).length, persistedReceipts: completed.filter(row => row.receipt.persisted === true && row.receipt.receiptId !== null).length, receiptParityMatches: completed.filter(row => row.receiptParity === true).length, actionableAdvice: completed.filter(row => row.delivered.decision !== null).length, rawChoiceCorrect: scored.filter(row => row.oracle.rawChoiceCorrect).length, abstentionCorrect: scored.filter(row => row.oracle.abstentionCorrect).length, decisionOutcomeCorrect: scored.filter(row => row.oracle.rawChoiceCorrect || row.oracle.abstentionCorrect).length, deliveredUsefulChoice: scored.filter(row => row.oracle.deliveredUsefulChoice).length, neutralAbstentions: scored.filter(row => row.delivered.status === 'abstained' && row.delivered.decision === null).length, limitations: ['Oracle labels are decision-level synthetic judgments only.', 'A delivered choice is not evidence that a Codex task improved.', 'Billing is unknown and provider IDs/key fingerprints are intentionally omitted.', 'Errored attempts remain in the append-only log and are not retried.']};
    await out.append(summary); await out.close();
    console.log(JSON.stringify({ok: true, output: config.out, ...summary}));
  } catch (error) {
    await out.append({kind: 'run_error', error: {name: error?.name ?? 'Error', message: String(error?.message ?? error), stack: error?.stack ?? null}}); await out.close(); throw error;
  }
}

async function main() {
  const config = parseArgs();
  if (!isWorker) {
    const loader = join(config.baselineSource, 'node_modules', 'tsx', 'dist', 'loader.mjs');
    const compatLoader = join(dir, 'compat-loader.mjs');
    const childEnv = {...process.env, JEV_BASELINE_SOURCE_ROOT: config.baselineSource, JEV_REPAIR_SOURCE_ROOT: config.repairSource};
    const child = spawnSync(node, ['--import', loader, '--experimental-loader', compatLoader, fileURLToPath(import.meta.url), '--worker', ...process.argv.slice(2)], {stdio: 'inherit', env: childEnv});
    process.exitCode = child.status ?? 1; return;
  }
  await runWorker(config);
}

main().catch(error => {process.stderr.write(`${error?.message ?? error}\n`); process.exitCode = 1;});
