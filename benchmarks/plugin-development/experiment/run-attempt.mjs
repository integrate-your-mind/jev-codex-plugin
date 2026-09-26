import {createHash, randomUUID} from 'node:crypto';
import {constants} from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
} from 'node:fs/promises';
import {dirname, isAbsolute, join, relative, resolve, sep} from 'node:path';
import {isDeepStrictEqual} from 'node:util';

import {
  cleanupCase,
  executeCaseAction,
  inspectActionIds,
  prepareCase,
  verifyPostconditions,
} from '../cases/fixture-engine.mjs';
import {providerInput} from './adapter.mjs';

const FORBIDDEN_PROVIDER_KEYS = new Set([
  'acceptablechoices',
  'actionplan',
  'correctchoice',
  'expectedchoice',
  'negativecontrols',
  'oracle',
  'outcomepayload',
  'passingaction',
  'postconditions',
  'prohibitedactions',
]);
const ASSESSMENT_STATUSES = new Set(['assessed', 'abstained', 'unavailable', 'skipped', 'preview']);
const ATTEMPT_ID = /^[a-zA-Z0-9._:-]{1,200}$/;

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

function errorRecord(error) {
  return {
    name: error instanceof Error ? error.name : 'Error',
    message: error instanceof Error ? error.message : String(error),
  };
}

async function syncDirectory(path) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { await handle.sync(); }
  finally { await handle.close(); }
}

async function writeExclusive(path, contents) {
  const handle = await open(
    path,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(contents);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectory(dirname(path));
}

async function writeExclusiveJson(path, value) {
  await writeExclusive(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function exists(path) {
  try { await lstat(path); return true; }
  catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function readBoundedRegularFile(path, maximumBytes) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > maximumBytes) {
      throw new Error(`attempt evidence must be a bounded regular file: ${path}`);
    }
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

async function readBoundedJson(path, maximumBytes = 16 * 1024 * 1024) {
  const bytes = await readBoundedRegularFile(path, maximumBytes);
  return {bytes, value: JSON.parse(bytes.toString('utf8'))};
}

function exactRowIdentity(row) {
  return {
    row: row.row,
    attemptId: row.attemptId,
    caseId: row.caseId,
    repeat: row.repeat,
    arm: row.arm,
  };
}

function elapsedMs(started) {
  return Number((performance.now() - started).toFixed(3));
}

export async function ensurePrivateOutputRoot(path) {
  if (!isAbsolute(path)) throw new Error('attempt output root must be absolute');
  await mkdir(path, {recursive: true, mode: 0o700});
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('attempt output root must be a real directory');
  await chmod(path, 0o700);
  return path;
}

async function createJournal(path) {
  const handle = await open(
    path,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  );
  await syncDirectory(dirname(path));
  let tail = Promise.resolve();
  let closed = false;
  return {
    append(record) {
      if (closed) throw new Error('attempt journal is closed');
      const retained = structuredClone(record);
      tail = tail.then(async () => {
        await handle.writeFile(`${JSON.stringify(retained)}\n`);
        await handle.sync();
      });
      return tail;
    },
    async close() {
      if (closed) return;
      closed = true;
      try { await tail; await handle.sync(); }
      finally { await handle.close(); }
    },
  };
}

function assertProviderBoundary(value, path = '$') {
  if (Array.isArray(value)) {
    value.forEach((child, index) => assertProviderBoundary(child, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_PROVIDER_KEYS.has(key.toLowerCase())) {
      throw new Error(`oracle-shaped field reached provider payload at ${path}.${key}`);
    }
    assertProviderBoundary(child, `${path}.${key}`);
  }
}

async function boundedResponseText(response, maximum = 65_536) {
  if (!response.body) return {text: '', complete: true};
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > maximum) {
        await reader.cancel().catch(() => {});
        return {text: null, complete: false, observedBytesAtLeast: bytes};
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  return {text: Buffer.concat(chunks).toString('utf8'), complete: true};
}

function providerRequestIdentifier(headers) {
  for (const name of ['x-typesafe-request-id', 'x-request-id', 'request-id']) {
    const value = headers.get(name);
    if (value) return {header: name, value};
  }
  return {header: null, value: null};
}

function recordedTransport({attemptId, fetchFn, journal, transportKind}) {
  const records = [];
  let fetchCount = 0;
  return {
    records,
    get fetchCount() { return fetchCount; },
    async fetch(input, init) {
      const requestClockStarted = performance.now();
      fetchCount += 1;
      if (fetchCount !== 1) throw new Error(`${attemptId}: hook made more than one provider request`);
      const requestBody = typeof init?.body === 'string' ? init.body : String(init?.body ?? '');
      let requestPayload;
      try { requestPayload = JSON.parse(requestBody); }
      catch { throw new Error(`${attemptId}: provider request body is not JSON`); }
      assertProviderBoundary(requestPayload);
      const record = {
        requestOrdinal: fetchCount,
        transportKind,
        endpoint: String(input),
        method: init?.method ?? 'GET',
        requestStartedAt: new Date().toISOString(),
        requestBody,
        requestPayload,
        requestSha256: digest(requestBody),
        requestBytes: Buffer.byteLength(requestBody),
        responseStatus: null,
        providerRequestIdHeader: null,
        providerRequestId: null,
        responseBody: null,
        responseBodyComplete: null,
      };
      records.push(record);
      await journal.append({kind: 'request_started', attemptId, ...record});
      try {
        const response = await fetchFn(input, init);
        const identifier = providerRequestIdentifier(response.headers);
        const captured = await boundedResponseText(response.clone());
        Object.assign(record, {
          responseReceivedAt: new Date().toISOString(),
          requestElapsedMs: elapsedMs(requestClockStarted),
          responseStatus: response.status,
          providerRequestIdHeader: identifier.header,
          providerRequestId: identifier.value,
          responseBody: captured.text,
          responseBodyComplete: captured.complete,
          responseBodySha256: captured.text === null ? null : digest(captured.text),
          ...(captured.observedBytesAtLeast ? {responseObservedBytesAtLeast: captured.observedBytesAtLeast} : {}),
        });
        await journal.append({kind: 'response_received', attemptId, ...record});
        return response;
      } catch (error) {
        record.transportError = errorRecord(error);
        record.failedAt = new Date().toISOString();
        record.requestElapsedMs = elapsedMs(requestClockStarted);
        await journal.append({kind: 'request_failed', attemptId, ...record});
        throw error;
      }
    },
  };
}

async function listFiles(root, current = root, result = []) {
  if (!(await exists(current))) return result;
  for (const entry of await readdir(current, {withFileTypes: true})) {
    const absolute = join(current, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`plugin state contains symlink: ${absolute}`);
    if (entry.isDirectory()) await listFiles(root, absolute, result);
    else if (entry.isFile()) result.push(absolute);
  }
  return result.sort();
}

async function retainedJson(path, root) {
  const text = await readFile(path, 'utf8');
  let parsed = null;
  let parseError = null;
  try { parsed = JSON.parse(text); }
  catch (error) { parseError = errorRecord(error); }
  return {
    path: relative(root, path).split(sep).join('/'),
    sha256: digest(text),
    bytes: Buffer.byteLength(text),
    text,
    parsed,
    parseError,
  };
}

async function pluginEvidence(stateRoot) {
  const all = await listFiles(stateRoot);
  const servicePaths = all.filter(path => path.includes(`${sep}receipts${sep}`) && path.endsWith('.json'));
  const invocationPaths = all.filter(path => path.includes(`${sep}invocations${sep}`) && path.endsWith('.json'));
  return {
    serviceReceipts: await Promise.all(servicePaths.map(path => retainedJson(path, stateRoot))),
    invocationReceipts: await Promise.all(invocationPaths.map(path => retainedJson(path, stateRoot))),
  };
}

export function parseDeliveredAssessment(hookResult, candidates) {
  const text = hookResult?.hookSpecificOutput?.additionalContext ?? hookResult?.systemMessage;
  if (typeof text !== 'string' || text.length === 0) {
    return {status: 'not_delivered', assessmentStatus: null, candidateId: null, reason: 'missing_hook_output'};
  }
  const marker = 'JEV advisory: ';
  if (!text.startsWith(marker)) return {status: 'invalid', assessmentStatus: null, candidateId: null, reason: 'unrecognized_hook_output', text};
  const body = text.slice(marker.length).split('; advisory only')[0].split('; continue ordinary reasoning')[0];
  const fields = new Map();
  for (const part of body.split('; ')) {
    const separator = part.indexOf('=');
    if (separator <= 0) continue;
    const key = part.slice(0, separator);
    const value = part.slice(separator + 1);
    if (fields.has(key)) return {status: 'invalid', assessmentStatus: null, candidateId: null, reason: 'duplicate_delivery_field', text};
    fields.set(key, value);
  }
  const assessmentStatus = fields.get('status') ?? null;
  if (!ASSESSMENT_STATUSES.has(assessmentStatus)) {
    return {status: 'invalid', assessmentStatus, candidateId: null, reason: 'invalid_assessment_status', text};
  }
  const decision = fields.get('decision') ?? null;
  if (assessmentStatus === 'abstained') {
    return {status: 'abstained', assessmentStatus, candidateId: null, reason: fields.get('reason') ?? 'abstained', text};
  }
  if (assessmentStatus !== 'assessed') {
    return {status: 'not_delivered', assessmentStatus, candidateId: null, reason: fields.get('reason') ?? assessmentStatus, text};
  }
  if (!decision) return {status: 'not_delivered', assessmentStatus, candidateId: null, reason: 'assessed_without_delivered_candidate', text};
  const candidate = candidates.find(item => item.id === decision);
  if (!candidate) return {status: 'rejected', assessmentStatus, candidateId: null, rejectedCandidateId: decision, reason: 'foreign_candidate', text};
  if (candidate.available === false) return {status: 'rejected', assessmentStatus, candidateId: null, rejectedCandidateId: decision, reason: 'unavailable_candidate', text};
  return {status: 'delivered', assessmentStatus, candidateId: candidate.id, reason: null, text};
}

function eventFor(input, attemptId, cwd) {
  const projected = providerInput(input);
  return {
    hook_event_name: 'PreToolUse',
    cwd,
    session_id: `plugin-development:${attemptId}`,
    event_id: `plugin-development:${attemptId}`,
    turn_id: `turn:${attemptId}`,
    tool_use_id: `tool:${attemptId}`,
    agent_id: 'plugin-development-experiment',
    source: 'plugin-development-experiment',
    tool_name: 'fixture_action',
    tool_input: {
      task: projected.task,
      question: projected.question,
      state: projected.state,
    },
    available_candidates: projected.candidates,
  };
}

function actualResponseModel(transport) {
  const record = transport.records[0];
  if (!record || typeof record.responseBody !== 'string') return null;
  try {
    const parsed = JSON.parse(record.responseBody);
    return typeof parsed?.model === 'string' ? parsed.model : null;
  } catch {
    return null;
  }
}

function validatedResponseStage(evidence, transport, expectedProviderModel) {
  const serviceReceipt = evidence.serviceReceipts.length === 1 ? evidence.serviceReceipts[0].parsed : null;
  const pluginTransport = serviceReceipt?.transport ?? null;
  const actualModel = actualResponseModel(transport);
  const modelVersionStatus = actualModel === null
    ? 'unavailable'
    : expectedProviderModel === null
      ? 'not_frozen'
      : actualModel === expectedProviderModel ? 'matches' : 'drift';
  const status = modelVersionStatus === 'drift'
    ? 'model_drift'
    : pluginTransport?.validatedResponse === true
    ? 'validated'
    : transport.records.some(record => record.responseStatus !== null)
      ? 'not_validated'
      : transport.records.some(record => record.transportError)
        ? 'transport_error'
        : 'unknown';
  return {
    status,
    assessmentStatus: serviceReceipt?.status ?? null,
    reasonCode: serviceReceipt?.reasonCode ?? null,
    receiptId: serviceReceipt?.receiptId ?? null,
    receiptPersisted: evidence.serviceReceipts.length === 1,
    providerModel: serviceReceipt?.model ?? null,
    expectedProviderModel,
    actualResponseModel: actualModel,
    modelVersionStatus,
    modelDrift: modelVersionStatus === 'drift',
    usage: serviceReceipt?.usage ?? null,
    transport: pluginTransport,
  };
}

function requestStage(transport) {
  return {
    status: transport.fetchCount === 1
      ? (transport.records[0]?.transportError ? 'error' : 'sent')
      : transport.fetchCount === 0 ? 'not_sent' : 'invalid',
    count: transport.fetchCount,
    requestSha256: transport.records[0]?.requestSha256 ?? null,
    requestBytes: transport.records[0]?.requestBytes ?? null,
    requestElapsedMs: transport.records[0]?.requestElapsedMs ?? null,
  };
}

function sameAttemptIdentity(value, row, manifestSha256) {
  return isDeepStrictEqual(value?.rowIdentity, exactRowIdentity(row))
    && value?.manifestSha256 === manifestSha256;
}

async function inspectExistingAttempt(paths, row, manifestSha256) {
  try {
    const reservation = await readBoundedJson(paths.reservationPath);
    if (reservation.value?.schemaVersion !== 'plugin-development-attempt-reservation-v2'
      || !sameAttemptIdentity(reservation.value, row, manifestSha256)) {
      throw new Error('existing reservation row or manifest identity mismatch');
    }
    if (!(await exists(paths.completionPath))) {
      return {priorStatus: 'ambiguous_started', priorEvidenceStatus: 'reservation_only'};
    }
    const completion = await readBoundedJson(paths.completionPath);
    if (completion.value?.schemaVersion !== 'plugin-development-attempt-completion-v1'
      || !sameAttemptIdentity(completion.value, row, manifestSha256)) {
      throw new Error('existing completion row or manifest identity mismatch');
    }
    const [result, journal] = await Promise.all([
      readBoundedJson(paths.resultPath),
      readBoundedRegularFile(paths.journalPath, 64 * 1024 * 1024),
    ]);
    const actualFiles = {
      reservation: {sha256: digest(reservation.bytes), bytes: reservation.bytes.byteLength},
      result: {sha256: digest(result.bytes), bytes: result.bytes.byteLength},
      journal: {sha256: digest(journal), bytes: journal.byteLength},
    };
    if (!isDeepStrictEqual(completion.value.files, actualFiles)) {
      throw new Error('existing attempt evidence hash mismatch');
    }
    if (result.value?.schemaVersion !== 'plugin-development-attempt-result-v1'
      || !isDeepStrictEqual(result.value.row, row)
      || result.value.manifestSha256 !== manifestSha256) {
      throw new Error('existing result row or manifest identity mismatch');
    }
    return {
      priorStatus: 'completed_existing',
      priorEvidenceStatus: 'validated_complete',
      result: result.value,
      completion: completion.value,
    };
  } catch (error) {
    return {
      priorStatus: 'ambiguous_started',
      priorEvidenceStatus: 'integrity_failure',
      priorEvidenceError: errorRecord(error),
    };
  }
}

async function reserveAttempt(outputRoot, row, manifestSha256) {
  const reservationPath = join(outputRoot, `${row.attemptId}.reservation.json`);
  const resultPath = join(outputRoot, `${row.attemptId}.result.json`);
  const journalPath = join(outputRoot, `${row.attemptId}.events.jsonl`);
  const completionPath = join(outputRoot, `${row.attemptId}.completion.json`);
  const paths = {reservationPath, resultPath, journalPath, completionPath};
  try {
    await writeExclusiveJson(reservationPath, {
      schemaVersion: 'plugin-development-attempt-reservation-v2',
      rowIdentity: exactRowIdentity(row),
      manifestSha256: manifestSha256 ?? null,
      reservationId: randomUUID(),
      startedAt: new Date().toISOString(),
    });
    return {reserved: true, ...paths};
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    return {reserved: false, ...paths, ...await inspectExistingAttempt(paths, row, manifestSha256 ?? null)};
  }
}

/**
 * Execute one frozen row. This is the only attempt state machine used by the
 * deterministic transport and live provider runners.
 */
export async function runAttempt({
  row,
  outputRoot,
  runDecisionHook,
  configurePolicy,
  fetchFn,
  transportKind,
  environment = process.env,
  manifestSha256 = null,
  expectedProviderModel = null,
  beforeReserve = null,
  cleanupPrepared = cleanupCase,
  offline = false,
}) {
  const operationClockStarted = performance.now();
  if (!row || !ATTEMPT_ID.test(row.attemptId ?? '')) throw new Error('invalid attempt row');
  if (typeof runDecisionHook !== 'function' || typeof configurePolicy !== 'function') throw new Error('variant hook API missing');
  if (typeof fetchFn !== 'function') throw new Error('attempt fetch transport missing');
  if (beforeReserve !== null && typeof beforeReserve !== 'function') throw new Error('beforeReserve must be a function');
  if (typeof cleanupPrepared !== 'function') throw new Error('cleanupPrepared must be a function');
  const boundManifestSha256 = manifestSha256 ?? null;
  await ensurePrivateOutputRoot(outputRoot);
  if (beforeReserve) await beforeReserve({row: structuredClone(row), manifestSha256: boundManifestSha256});
  const reservation = await reserveAttempt(outputRoot, row, boundManifestSha256);
  if (!reservation.reserved) {
    return {
      attemptId: row.attemptId,
      execution: reservation.priorStatus,
      priorEvidenceStatus: reservation.priorEvidenceStatus,
      priorEvidenceError: reservation.priorEvidenceError ?? null,
      reservationPath: reservation.reservationPath,
      journalPath: reservation.journalPath,
      resultPath: reservation.resultPath,
      completionPath: reservation.completionPath,
      result: reservation.result ?? null,
      completion: reservation.completion ?? null,
      lookupElapsedMs: elapsedMs(operationClockStarted),
    };
  }

  const journalPath = reservation.journalPath;
  const stateRoot = join(outputRoot, `${row.attemptId}.state`);
  const journal = await createJournal(journalPath);
  const startedAt = new Date().toISOString();
  let prepared;
  let transport;
  let stateCreated = false;
  let result = {
    schemaVersion: 'plugin-development-attempt-result-v1',
    row: structuredClone(row),
    startedAt,
    completedAt: null,
    transportKind,
    manifestSha256: boundManifestSha256,
    expectedProviderModel,
    hookCalls: 0,
    providerRequests: [],
    pluginEvidence: {serviceReceipts: [], invocationReceipts: []},
    stages: {
      request: {status: 'not_started', count: 0},
      validatedResponse: {status: 'unknown'},
      delivery: {status: 'not_delivered', candidateId: null, reason: 'not_started'},
      action: {status: 'not_attempted', candidateId: null, reason: 'not_started'},
      postcondition: {status: 'unknown', pass: null, violations: null},
    },
    harnessStatus: 'running',
    harnessError: null,
    cleanup: {status: 'not_started', error: null},
    operationElapsedMs: null,
  };
  try {
    await journal.append({kind: 'attempt_started', row, startedAt, manifestSha256: boundManifestSha256, transportKind, expectedProviderModel});
    await mkdir(stateRoot, {mode: 0o700});
    stateCreated = true;
    await chmod(stateRoot, 0o700);
    prepared = await prepareCase(row.caseId);
    result.caseProvenance = {
      authoredSurface: prepared.input.surface ?? null,
      authoredEvent: prepared.input.event ?? null,
      authoredMcpMethod: prepared.input.mcpMethod ?? null,
      exercisedComponent: 'runDecisionHook',
      normalizedHookEvent: 'PreToolUse',
      candidateCatalogSource: 'authored supplied catalog',
      nativeMcpInvocationExercised: false,
      nativeCatalogDiscoveryExercised: false,
    };
    const env = {
      ...environment,
      PLUGIN_DATA: stateRoot,
      JEV_STATE_DIRECTORY: stateRoot,
      JEV_ENABLED: '1',
      JEV_MAX_CALLS_PER_DAY: 'unlimited',
      JEV_MAX_BYTES_PER_DAY: 'unlimited',
    };
    if (offline) {
      delete env.JEV_API_KEY_FILE;
      env.TYPESAFE_API_KEY = 'synthetic-plumbing-credential';
    }
    await configurePolicy({
      enabled: true,
      scope: 'workspaces',
      workspaces: [prepared.root],
      maxHookCallsPerSession: null,
      maxCallsPerDay: null,
      maxBytesPerDay: null,
    }, env);
    transport = recordedTransport({attemptId: row.attemptId, fetchFn, journal, transportKind});
    const event = eventFor(prepared.input, row.attemptId, prepared.root);
    result.providerInputSha256 = digest(JSON.stringify(providerInput(prepared.input)));
    await journal.append({kind: 'hook_invocation_started', attemptId: row.attemptId, eventSha256: digest(JSON.stringify(event))});
    result.hookCalls += 1;
    const hookResult = await runDecisionHook(JSON.stringify(event), {env, fetchFn: transport.fetch});
    await journal.append({kind: 'hook_invocation_completed', attemptId: row.attemptId, hookResult});
    if (result.hookCalls !== 1) throw new Error('attempt did not make exactly one hook invocation');

    result.providerRequests = structuredClone(transport.records);
    result.stages.request = requestStage(transport);
    result.pluginEvidence = await pluginEvidence(stateRoot);
    result.stages.validatedResponse = validatedResponseStage(result.pluginEvidence, transport, expectedProviderModel);
    const delivery = parseDeliveredAssessment(hookResult, prepared.input.candidates ?? []);
    result.stages.delivery = delivery;
    await journal.append({kind: 'delivery_evaluated', attemptId: row.attemptId, delivery});

    if (delivery.status === 'delivered') {
      const actionIds = await inspectActionIds(prepared);
      if (!actionIds.includes(delivery.candidateId)) {
        result.stages.action = {status: 'rejected', candidateId: delivery.candidateId, reason: 'missing_fixture_action'};
      } else {
        await journal.append({kind: 'action_started', attemptId: row.attemptId, candidateId: delivery.candidateId});
        const execution = await executeCaseAction(prepared, delivery.candidateId);
        result.stages.action = {
          status: execution.status,
          candidateId: delivery.candidateId,
          reason: execution.reason ?? null,
          workspaceAfter: execution.after ?? null,
        };
        await journal.append({kind: 'action_finished', attemptId: row.attemptId, action: result.stages.action});
        if (execution.status === 'completed') {
          const grade = await verifyPostconditions(prepared);
          result.stages.postcondition = {
            status: grade.pass ? 'passed' : 'failed',
            pass: grade.pass,
            violations: grade.violations,
            oracle: 'independent-authored-fixture-engine',
          };
          await journal.append({kind: 'postcondition_checked', attemptId: row.attemptId, postcondition: result.stages.postcondition});
        }
      }
    } else {
      result.stages.action = {
        status: 'not_attempted',
        candidateId: null,
        reason: delivery.status === 'abstained' ? 'abstention' : delivery.reason,
      };
      result.stages.postcondition = {status: 'unknown', pass: null, violations: null};
    }
    result.harnessStatus = result.stages.postcondition.status === 'passed'
      ? 'completed_verified'
      : result.stages.postcondition.status === 'failed'
        ? 'completed_failed'
        : 'unresolved';
  } catch (error) {
    result.harnessStatus = 'error';
    result.harnessError = errorRecord(error);
    if (transport) {
      result.providerRequests = structuredClone(transport.records);
      result.stages.request = requestStage(transport);
    }
    if (stateCreated) {
      result.pluginEvidence = await pluginEvidence(stateRoot).catch(() => result.pluginEvidence);
      if (transport) result.stages.validatedResponse = validatedResponseStage(result.pluginEvidence, transport, expectedProviderModel);
    }
    if (result.stages.action.status === 'not_attempted') {
      result.stages.action = {status: 'not_attempted', candidateId: null, reason: 'harness_error'};
    }
    await journal.append({kind: 'attempt_error', attemptId: row.attemptId, error: result.harnessError}).catch(() => {});
  } finally {
    if (prepared) {
      try {
        await cleanupPrepared(prepared);
        result.cleanup = {status: 'completed', error: null};
        await journal.append({kind: 'fixture_cleanup_completed', attemptId: row.attemptId});
      } catch (error) {
        const cleanupError = errorRecord(error);
        result.cleanup = {status: 'failed', error: cleanupError};
        result.harnessStatusBeforeCleanupFailure = result.harnessStatus;
        result.harnessStatus = 'error';
        result.cleanupError = cleanupError;
        if (result.harnessError === null) result.harnessError = cleanupError;
        await journal.append({kind: 'fixture_cleanup_failed', attemptId: row.attemptId, error: cleanupError}).catch(() => {});
      }
    } else {
      result.cleanup = {status: 'not_needed', error: null};
    }
  }

  result.completedAt = new Date().toISOString();
  result.operationElapsedMs = elapsedMs(operationClockStarted);
  try {
    await writeExclusiveJson(reservation.resultPath, result);
    await journal.append({kind: 'result_persisted', attemptId: row.attemptId, resultPath: reservation.resultPath, resultSha256: digest(`${JSON.stringify(result, null, 2)}\n`)});
  } catch (error) {
    await journal.append({kind: 'result_persistence_failed', attemptId: row.attemptId, error: errorRecord(error)}).catch(() => {});
    throw error;
  } finally {
    await journal.close();
  }
  const [reservationBytes, resultBytes, journalBytes] = await Promise.all([
    readBoundedRegularFile(reservation.reservationPath, 1024 * 1024),
    readBoundedRegularFile(reservation.resultPath, 16 * 1024 * 1024),
    readBoundedRegularFile(reservation.journalPath, 64 * 1024 * 1024),
  ]);
  const completion = {
    schemaVersion: 'plugin-development-attempt-completion-v1',
    rowIdentity: exactRowIdentity(row),
    manifestSha256: boundManifestSha256,
    completionRecordedAt: new Date().toISOString(),
    completeOperationElapsedMs: elapsedMs(operationClockStarted),
    files: {
      reservation: {sha256: digest(reservationBytes), bytes: reservationBytes.byteLength},
      result: {sha256: digest(resultBytes), bytes: resultBytes.byteLength},
      journal: {sha256: digest(journalBytes), bytes: journalBytes.byteLength},
    },
  };
  await writeExclusiveJson(reservation.completionPath, completion);
  return {
    attemptId: row.attemptId,
    execution: 'executed',
    reservationPath: reservation.reservationPath,
    journalPath,
    resultPath: reservation.resultPath,
    completionPath: reservation.completionPath,
    result,
    completion,
  };
}
