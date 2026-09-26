#!/usr/bin/env node
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {constants} from 'node:fs';
import {mkdir, open, readFile, realpath} from 'node:fs/promises';
import {isAbsolute, dirname, join, resolve, sep} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {performance} from 'node:perf_hooks';

import {buildFreeze, hash, validateTruthBoundary} from './freeze.mjs';
import {gradeRecords} from './grader.mjs';

const dir = dirname(fileURLToPath(import.meta.url));
const repo = resolve(dir, '..', '..', '..');
const defaultSource = join(repo, 'source/jev-workflows');
const requiredNodeVersion = 'v22.23.2';
const isWorker = process.argv.includes('--worker');

function parseArgs(argv = process.argv.slice(2)) {
  const config = {source: defaultSource, live: false, synthetic: 'valid'};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--live') { config.live = true; continue; }
    if (arg === '--worker') continue;
    if (!['--source', '--out', '--reviewed-freeze-sha', '--synthetic'].includes(arg)) throw new Error(`unknown argument: ${arg}`);
    const value = argv[++index];
    if (!value) throw new Error(`${arg} requires a value`);
    if (arg === '--source') config.source = resolve(value);
    if (arg === '--out') config.out = resolve(value);
    if (arg === '--reviewed-freeze-sha') config.reviewedFreezeSha = value;
    if (arg === '--synthetic') config.synthetic = value;
  }
  if (!config.out || !isAbsolute(config.out)) throw new Error('--out must be an absolute new file path');
  if (!['valid', 'malformed', 'unavailable', 'mixed', 'service-error'].includes(config.synthetic)) throw new Error('--synthetic must be valid, malformed, unavailable, mixed, or service-error');
  if (config.live && config.synthetic !== 'valid') throw new Error('--synthetic is a dry-run option');
  return config;
}

async function createLog(path) {
  await mkdir(dirname(path), {recursive: true, mode: 0o700});
  const handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  const records = [];
  return {
    records,
    async append(record) {
      records.push(structuredClone(record));
      await handle.writeFile(`${JSON.stringify(record)}\n`);
      await handle.sync();
    },
    async close() { await handle.sync(); await handle.close(); },
  };
}

class AttemptStore {
  reservations = [];
  receipts = [];
  saveDurationsMs = [];
  constructor(reservePlan = null) { this.reservePlan = reservePlan; }
  async reserve(bytes) {
    this.reservations.push(bytes);
    if (!this.reservePlan?.length) return true;
    const decision = this.reservePlan.shift();
    if (decision instanceof Error) throw decision;
    return decision;
  }
  async save(receipt) {
    const start = performance.now();
    this.receipts.push(structuredClone(receipt));
    this.saveDurationsMs.push(performance.now() - start);
  }
}

function validSyntheticResponse(payload) {
  const answers = Object.fromEntries(Object.entries(payload.questions).map(([id, question]) => {
    if (question.type === 'noul') return [id, {type: 'noul', noul: 0.5}];
    if (question.type === 'score') return [id, {
      type: 'score',
      score: 0,
      legend: Object.fromEntries(question.criteria.map((criterion, index) => [String(index), criterion])),
      probabilities: Object.fromEntries(question.criteria.map((_, index) => [String(index), index === 0 ? 1 : 0])),
      confidence: 1,
    }];
    const ids = Object.keys(question.criteria);
    const selected = ids[0];
    const remainder = ids.length > 1 ? 0.3 / (ids.length - 1) : 0;
    return [id, {
      type: 'choice',
      choice: selected,
      probabilities: Object.fromEntries(ids.map(candidate => [candidate, candidate === selected ? 0.7 : remainder])),
      confidence: 0.9,
    }];
  }));
  return {model: 'jev-1.13.0', answers, usage: {input_tokens: Object.keys(payload.questions).length * 10, output_tokens: Object.keys(payload.questions).length * 5}};
}

function safeTransport(transport) {
  if (!transport) return null;
  return {
    requestStartedAt: transport.requestStartedAt ?? null,
    fetchInvoked: transport.fetchInvoked === true,
    responseReceivedAt: transport.responseReceivedAt ?? null,
    responseStatus: transport.responseStatus ?? null,
    validatedResponse: transport.validatedResponse === true,
    providerRequestIdPresent: typeof transport.providerRequestId === 'string' && transport.providerRequestId.length > 0,
    providerRequestIdHeaderPresent: typeof transport.providerRequestIdHeader === 'string',
    retryAfterPresent: typeof transport.retryAfter === 'string',
    networkPolicyError: transport.networkPolicyError ?? null,
    responseValidationFailure: transport.responseValidationFailure ?? null,
    responseValidationDiagnostic: transport.responseValidationDiagnostic ?? null,
  };
}

function safeResult(result) {
  return {
    status: result.status,
    reasonCode: result.reasonCode ?? null,
    model: result.model ?? null,
    providerVersionPresent: typeof result.model === 'string' && result.model.length > 0,
    answers: result.answers ?? null,
    usage: result.usage ?? null,
    latencyMs: result.latencyMs ?? null,
    receiptIdPresent: typeof result.receiptId === 'string' && result.receiptId.length > 0,
    receiptPersisted: result.receiptPersisted === true,
    transport: safeTransport(result.transport),
  };
}

export function mergeUsage(results) {
  if (results.length === 0) return null;
  if (!results.every(result => Number.isFinite(result.usage?.input_tokens) && Number.isFinite(result.usage?.output_tokens))) return null;
  return results.reduce((usage, result) => ({
    input_tokens: usage.input_tokens + result.usage.input_tokens,
    output_tokens: usage.output_tokens + result.usage.output_tokens,
  }), {input_tokens: 0, output_tokens: 0});
}

async function makeTransport({attempt, live, synthetic, log, oracleMarker}) {
  let fetchSequence = 0;
  let activeRequestGroup = null;
  const requests = [];
  async function fetchFn(url, init) {
    fetchSequence += 1;
    const requestGroup = activeRequestGroup;
    assert.ok(requestGroup, `${attempt.attemptId}: provider fetch has no active service request group`);
    const {requestOrdinal, requestGroupId, questionIds} = requestGroup;
    const startedAt = new Date().toISOString();
    const start = performance.now();
    const payloadText = String(init?.body ?? '');
    const payload = JSON.parse(payloadText);
    assert.equal(payloadText.includes(oracleMarker), false, 'oracle marker reached provider payload');
    assert.equal(/"(?:expected|oracle|truth|correctChoice)"\s*:/i.test(payloadText), false, 'truth-shaped field reached provider payload');
    const entry = {
      requestOrdinal,
      requestGroupId,
      fetchSequence,
      questionIds,
      startedAt,
      payloadSha256: hash(payloadText),
      payloadBytes: Buffer.byteLength(payloadText),
      payload,
      responseStatus: null,
      requestLatencyMs: null,
      rawResponse: null,
    };
    requests.push(entry);
    assert.deepEqual(Object.keys(payload.questions), questionIds, `${attempt.attemptId}: provider payload differs from active question group`);
    await log.append({kind: 'provider_request_started', attemptId: attempt.attemptId, requestOrdinal, requestGroupId, fetchSequence, questionIds: entry.questionIds, startedAt, payloadSha256: entry.payloadSha256, payloadBytes: entry.payloadBytes, payload});
    try {
      let response;
      if (live) response = await fetch(url, init);
      else {
        const responseBody = synthetic === 'malformed'
          ? {model: 'jev-1.13.0', answers: {}, usage: {input_tokens: 1, output_tokens: 1}}
          : validSyntheticResponse(payload);
        response = new Response(JSON.stringify(responseBody), {status: 200, headers: {'x-typesafe-request-id': `synthetic_${attempt.attemptId}_${requestOrdinal}`}});
      }
      entry.responseStatus = response.status;
      entry.requestLatencyMs = performance.now() - start;
      entry.rawPromise = response.clone().text()
        .then(text => { entry.rawResponse = text; })
        .catch(error => { entry.rawResponseError = {name: error?.name ?? 'Error', message: String(error?.message ?? error)}; });
      await log.append({kind: 'provider_response_received', attemptId: attempt.attemptId, requestOrdinal, requestGroupId, fetchSequence, responseStatus: response.status, providerRequestIdPresent: ['x-typesafe-request-id', 'x-request-id', 'request-id'].some(name => Boolean(response.headers.get(name))), receivedAt: new Date().toISOString(), requestLatencyMs: entry.requestLatencyMs});
      return response;
    } catch (error) {
      entry.requestLatencyMs = performance.now() - start;
      await log.append({kind: 'provider_transport_failed', attemptId: attempt.attemptId, requestOrdinal, requestGroupId, fetchSequence, failedAt: new Date().toISOString(), requestLatencyMs: entry.requestLatencyMs, error: {name: error?.name ?? 'Error', message: String(error?.message ?? error)}});
      throw error;
    }
  }
  return {
    fetchFn,
    requests,
    beginRequestGroup(requestGroup) {
      assert.equal(activeRequestGroup, null, `${attempt.attemptId}: overlapping service request groups`);
      activeRequestGroup = requestGroup;
    },
    endRequestGroup(requestGroupId) {
      assert.equal(activeRequestGroup?.requestGroupId, requestGroupId, `${attempt.attemptId}: service request group mismatch`);
      activeRequestGroup = null;
    },
  };
}

async function runAttempt({attempt, fixture, createService, log, live, synthetic, oracleMarker}) {
  const startedAt = new Date().toISOString();
  await log.append({kind: 'attempt_started', attemptId: attempt.attemptId, caseId: attempt.caseId, cluster: attempt.cluster, repeat: attempt.repeat, arm: attempt.arm, expectedProviderRequests: attempt.expectedProviderRequests, startedAt});
  const operationStart = performance.now();
  const store = new AttemptStore(synthetic === 'mixed' ? [new Error('synthetic reserve failure'), true, true] : null);
  const transport = await makeTransport({attempt, live, synthetic, log, oracleMarker});
  const env = {...process.env, JEV_ENABLED: '1', JEV_MAX_CALLS_PER_DAY: 'unlimited', JEV_MAX_BYTES_PER_DAY: 'unlimited'};
  if (!live) {
    delete env.JEV_API_KEY_FILE;
    if (synthetic === 'unavailable') delete env.TYPESAFE_API_KEY;
    else env.TYPESAFE_API_KEY = 'synthetic-benchmark-credential';
  }
  const service = createService({env, enabled: true, fetchFn: transport.fetchFn, store});
  const results = [];
  const answers = {};
  let harnessStatus = 'completed';
  let harnessError = null;
  try {
    const groups = attempt.arm === 'batch'
      ? [fixture.questions]
      : Object.entries(fixture.questions).map(([id, question]) => ({[id]: question}));
    for (let index = 0; index < groups.length; index += 1) {
      const questions = groups[index];
      const requestOrdinal = index + 1;
      const requestGroupId = `${attempt.attemptId}.request-${requestOrdinal}`;
      const questionIds = Object.keys(questions);
      transport.beginRequestGroup({requestOrdinal, requestGroupId, questionIds});
      try {
        if (synthetic === 'service-error') throw new Error('synthetic service exception before completion');
        const result = {
          requestOrdinal,
          requestGroupId,
          questionIds,
          ...safeResult(await service.evaluateDecisions({
            state: fixture.state,
            questions,
            policy: fixture.policy,
            origin: {source: 'service', agentId: 'batch-component-benchmark'},
            correlation: {requestId: attempt.attemptId},
            mode: 'evaluate',
          })),
        };
        results.push(result);
        if (result.answers) Object.assign(answers, result.answers);
        const raw = transport.requests.find(request => request.requestGroupId === requestGroupId);
        if (raw?.rawPromise) await raw.rawPromise;
        await log.append({kind: 'service_request_completed', attemptId: attempt.attemptId, requestOrdinal, requestGroupId, questionIds, completedAt: new Date().toISOString(), result});
      } finally {
        transport.endRequestGroup(requestGroupId);
      }
    }
  } catch (error) {
    harnessStatus = 'error';
    harnessError = {name: error?.name ?? 'Error', message: String(error?.message ?? error)};
  }
  await Promise.all(transport.requests.map(request => request.rawPromise).filter(Boolean));
  const operationDurationMs = performance.now() - operationStart;
  const accounting = {
    providerRequestsStarted: transport.requests.length,
    httpResponses: transport.requests.filter(request => request.responseStatus !== null).length,
    validatedResponses: results.filter(result => result.transport?.validatedResponse).length,
    fetchInvoked: transport.requests.length,
    receiptIdsPresent: results.filter(result => result.receiptIdPresent).length,
    persistedReceipts: results.filter(result => result.receiptPersisted).length,
    providerRequestIdsPresent: results.filter(result => result.transport?.providerRequestIdPresent).length,
    providerVersionsPresent: results.filter(result => result.providerVersionPresent).length,
    reservations: store.reservations.length,
    storeSaves: store.receipts.length,
    retriesConfigured: 0,
    retriesObserved: 0,
  };
  const finished = {
    kind: 'attempt_finished', attemptId: attempt.attemptId, caseId: attempt.caseId, cluster: attempt.cluster,
    repeat: attempt.repeat, arm: attempt.arm, expectedProviderRequests: attempt.expectedProviderRequests,
    startedAt, completedAt: new Date().toISOString(),
    harnessStatus, harnessError, operationDurationMs,
    persistenceDurationMs: store.saveDurationsMs.reduce((sum, value) => sum + value, 0),
    inputProjectionSha256: hash({state: fixture.state, questions: fixture.questions, policy: fixture.policy}),
    inputPolicy: fixture.policy,
    serviceRequestLatencyMs: results.map(result => result.latencyMs),
    providerRequests: transport.requests.map(({rawPromise: _rawPromise, ...request}) => request),
    serviceResults: results, answers, usage: mergeUsage(results), accounting,
  };
  await log.append(finished);
  return finished;
}

async function verifyFreeze(config) {
  const freezePath = join(dir, 'freeze.json');
  const bytes = await readFile(freezePath);
  const freezeSha256 = hash(bytes);
  const frozen = JSON.parse(bytes);
  const current = await buildFreeze({sourceRoot: config.source, write: false, enforceRuntime: config.live});
  assert.deepEqual(current, frozen, 'frozen inputs, harness, selection rule, or service source changed');
  if (config.live) {
    if (process.version !== requiredNodeVersion) throw new Error(`live run requires Node ${requiredNodeVersion}; found ${process.version}`);
    if (process.env.JEV_RUN_LIVE_BATCH_BENCHMARK !== '1') throw new Error('live run requires JEV_RUN_LIVE_BATCH_BENCHMARK=1');
    if (config.reviewedFreezeSha !== freezeSha256) throw new Error('live run requires exact --reviewed-freeze-sha');
    if (!process.env.JEV_API_KEY_FILE && !process.env.TYPESAFE_API_KEY) throw new Error('live run requires an existing credential source');
    if (config.out.split(sep).includes('Documents')) throw new Error('live raw output must be outside Documents');
  }
  return {frozen, freezeSha256};
}

async function runWorker(config) {
  const {frozen, freezeSha256} = await verifyFreeze(config);
  const [inputs, oracle, schedule] = await Promise.all([
    readFile(join(dir, 'inputs.json'), 'utf8').then(JSON.parse),
    readFile(join(dir, 'oracle/oracle.json'), 'utf8').then(JSON.parse),
    readFile(join(dir, 'schedule.json'), 'utf8').then(JSON.parse),
  ]);
  validateTruthBoundary(inputs, oracle);
  const fixtures = new Map(inputs.cases.map(fixture => [fixture.id, fixture]));
  const module = await import(pathToFileURL(join(config.source, 'src/service.ts')).href);
  const log = await createLog(config.out);
  const header = {
    kind: 'header', schemaVersion: 'jev-batch-component-run-v1', mode: config.live ? 'live' : 'dry-synthetic',
    syntheticTransport: config.live ? null : config.synthetic, externalProviderCalls: config.live,
    truthPassedToProvider: false, freezeSha256, cohort: frozen.cohort,
    pluginVersion: frozen.pluginVersion, providerModel: frozen.providerModel,
    runtime: {node: process.version, platform: process.platform, arch: process.arch},
    plannedAttempts: schedule.attempts.length, plannedProviderRequests: frozen.plannedProviderRequests,
    noAdaptiveRetries: true, rawOutputPrivate: true,
  };
  await log.append(header);
  try {
    for (const attempt of schedule.attempts) {
      await runAttempt({attempt, fixture: fixtures.get(attempt.caseId), createService: module.createService, log, live: config.live, synthetic: config.synthetic, oracleMarker: oracle.oracleMarker});
    }
    const grade = gradeRecords(log.records, schedule, oracle);
    await log.append({kind: 'summary', ...grade});
    await log.close();
    process.stdout.write(`${JSON.stringify({ok: true, mode: header.mode, outputCreated: true, plannedAttempts: header.plannedAttempts, plannedProviderRequests: header.plannedProviderRequests, claimBoundary: grade.claimBoundary})}\n`);
  } catch (error) {
    await log.append({kind: 'run_error', error: {name: error?.name ?? 'Error', message: String(error?.message ?? error)}});
    await log.close();
    throw error;
  }
}

async function main() {
  const config = parseArgs();
  if (!isWorker) {
    const loader = join(config.source, 'node_modules/tsx/dist/loader.mjs');
    const child = spawnSync(process.execPath, ['--import', loader, fileURLToPath(import.meta.url), '--worker', ...process.argv.slice(2)], {stdio: 'inherit', env: process.env});
    process.exitCode = child.status ?? 1;
    return;
  }
  await realpath(config.source);
  await runWorker(config);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { process.stderr.write(`${error?.message ?? error}\n`); process.exitCode = 1; });
}
