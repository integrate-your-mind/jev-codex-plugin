import {execFile as execFileCallback} from 'node:child_process';
import {createHash} from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, isAbsolute, join, relative, resolve, sep} from 'node:path';
import {isDeepStrictEqual, promisify} from 'node:util';
import {fileURLToPath, pathToFileURL} from 'node:url';

const execFile = promisify(execFileCallback);
const experimentDir = dirname(fileURLToPath(import.meta.url));
const publicationRoot = resolve(experimentDir, '../../..');
const configPath = join(experimentDir, 'experiment.json');
const freezePath = join(experimentDir, 'freeze.json');
const currentApiPath = join(publicationRoot, 'source/jev-workflows/src/outcomes.ts');
const fixtureEnginePath = join(publicationRoot, 'benchmarks/plugin-development/cases/fixture-engine.mjs');
const casesInputPath = join(publicationRoot, 'benchmarks/plugin-development/cases/inputs.json');
const casesOraclePath = join(publicationRoot, 'benchmarks/plugin-development/cases/oracle.json');

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function readJson(path: string): Promise<any> {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function hashFile(path: string): Promise<{sha256: string; sizeBytes: number}> {
  const bytes = await readFile(path);
  return {sha256: sha256(bytes), sizeBytes: bytes.byteLength};
}

function aggregateFiles(files: Record<string, {sha256: string; sizeBytes: number}>): string {
  return sha256(Object.entries(files)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([path, value]) => `${path}\0${value.sizeBytes}\0${value.sha256}\n`)
    .join(''));
}

async function packageVersion(path: string): Promise<string> {
  const value = await readJson(path);
  if (typeof value.version !== 'string') throw new Error(`dependency version missing: ${path}`);
  return value.version;
}

export async function validateFrozenInputs(): Promise<any> {
  const [freeze, config, freezeFile] = await Promise.all([
    readJson(freezePath),
    readJson(configPath),
    hashFile(freezePath),
  ]);
  if (freeze.schemaVersion !== 'jev-explicit-outcomes-freeze-v1') throw new Error('freeze schema mismatch');
  if (config.schemaVersion !== 'jev-explicit-outcomes-experiment-v1') throw new Error('experiment schema mismatch');
  if (freeze.baseCommit !== config.baseCommit) throw new Error('base commit mismatch');
  const actualFiles: Record<string, {sha256: string; sizeBytes: number}> = {};
  for (const [path, expected] of Object.entries(freeze.files) as Array<[string, any]>) {
    const absolute = resolve(publicationRoot, path);
    if (relative(publicationRoot, absolute).startsWith(`..${sep}`)) throw new Error(`frozen path escapes publication root: ${path}`);
    const actual = await hashFile(absolute);
    if (!isDeepStrictEqual(actual, {sha256: expected.sha256, sizeBytes: expected.sizeBytes})) {
      throw new Error(`frozen file mismatch: ${path}`);
    }
    actualFiles[path] = actual;
  }
  const aggregateSha256 = aggregateFiles(actualFiles);
  if (aggregateSha256 !== freeze.aggregateSha256) throw new Error('frozen file aggregate mismatch');
  for (const [path, expected] of Object.entries(freeze.gitFiles) as Array<[string, any]>) {
    const {stdout} = await execFile('git', ['show', `${freeze.baseCommit}:${path}`], {
      cwd: publicationRoot,
      encoding: 'buffer',
      maxBuffer: 2 * 1024 * 1024,
    });
    const actual = {sha256: sha256(stdout), sizeBytes: stdout.byteLength};
    if (!isDeepStrictEqual(actual, {sha256: expected.sha256, sizeBytes: expected.sizeBytes})) {
      throw new Error(`base commit file mismatch: ${path}`);
    }
  }
  const dependencyVersions = {
    tsx: await packageVersion(join(publicationRoot, 'source/jev-workflows/node_modules/tsx/package.json')),
    zod: await packageVersion(join(publicationRoot, 'source/jev-workflows/node_modules/zod/package.json')),
  };
  if (!isDeepStrictEqual(dependencyVersions, freeze.dependencyVersions)) throw new Error('dependency version mismatch');
  const apiSource = actualFiles['source/jev-workflows/src/outcomes.ts'];
  const frozenApiSource = actualFiles['benchmarks/plugin-development/experiment/variants/baseline/source/src/outcomes.ts'];
  const storeSource = actualFiles['source/jev-workflows/src/store.ts'];
  const frozenStoreSource = actualFiles['benchmarks/plugin-development/experiment/variants/baseline/source/src/store.ts'];
  if (!isDeepStrictEqual(apiSource, frozenApiSource) || !isDeepStrictEqual(storeSource, frozenStoreSource)) {
    throw new Error('current outcome storage source differs from frozen baseline');
  }
  return {
    baseCommit: freeze.baseCommit,
    freezeFile,
    aggregateSha256,
    fileCount: Object.keys(actualFiles).length,
    dependencyVersions,
    apiSource,
    frozenApiSource,
    storeSource,
    frozenStoreSource,
  };
}

function syntheticReceipt(receiptId: string): Record<string, unknown> {
  return {
    schemaVersion: 'jev-explicit-outcomes-synthetic-storage-receipt-v1',
    receiptId,
    synthetic: true,
    purpose: 'offline recordDecisionOutcome storage contract only',
    provenance: {
      source: 'authored-test-fixture',
      providerContacted: false,
      providerRequestIdPresent: false,
      actionSuccessClaimed: false,
    },
  };
}

export async function seedSyntheticReceipt(stateRoot: string, receiptId: string): Promise<void> {
  const directory = join(stateRoot, 'receipts');
  await mkdir(directory, {recursive: true, mode: 0o700});
  const path = join(directory, `${receiptId}.json`);
  await writeFile(path, `${JSON.stringify(syntheticReceipt(receiptId), null, 2)}\n`, {encoding: 'utf8', flag: 'wx', mode: 0o600});
}

async function readStoredRecord(stateRoot: string, record: any): Promise<{record: any; sha256: string; sizeBytes: number; mode: string}> {
  const path = join(stateRoot, 'outcomes', `${record.outcomeId}.json`);
  const [bytes, info] = await Promise.all([readFile(path), stat(path)]);
  const readback = JSON.parse(bytes.toString('utf8'));
  if (!isDeepStrictEqual(readback, record)) throw new Error(`stored outcome readback differs: ${record.outcomeId}`);
  return {record: readback, sha256: sha256(bytes), sizeBytes: bytes.byteLength, mode: (info.mode & 0o777).toString(8).padStart(3, '0')};
}

function assertStoredCallerObservation(record: any, request: any): void {
  if (record.observedOutcome !== request.observed) throw new Error('plugin changed the caller observation');
  if (record.actualActionId !== request.actionId) throw new Error('plugin changed the action identifier');
  if (!isDeepStrictEqual(record.evidenceIds, request.evidenceRefs)) throw new Error('plugin changed evidence references');
  if (record.callerReported !== true || record.provenance?.callerClaimOnly !== true) throw new Error('caller provenance mismatch');
  if (record.provenance?.independentlyVerified !== false) throw new Error('plugin promoted caller report to independent verification');
  if ('providerRequestId' in record) throw new Error('synthetic receipt unexpectedly produced a provider request id');
}

function independentAssessment(caseId: string, artifact: any): string {
  if (caseId === 'outcome-normal') {
    if (artifact.verificationStatus !== 'verified' || !Object.values(artifact.checks ?? {}).every(Boolean)) throw new Error('normal evidence is not verified');
    return 'supported';
  }
  if (caseId === 'outcome-conflict') {
    if (artifact.verificationStatus !== 'local_only' || !artifact.missingEvidence?.includes('remote-artifact-readback')) throw new Error('missing-remote evidence mismatch');
    return 'unknown';
  }
  if (caseId === 'outcome-stale') {
    if (artifact.verificationStatus !== 'stale_unknown' || artifact.requiresNewAction !== true || artifact.receiptRevision === artifact.currentRevision) throw new Error('stale evidence mismatch');
    return 'unsupported';
  }
  if (caseId === 'outcome-adversarial') {
    if (artifact.verificationStatus !== 'failed' || artifact.exitCode === 0) throw new Error('failed-action evidence mismatch');
    return 'contradicted';
  }
  throw new Error(`unknown outcome case: ${caseId}`);
}

function schemaRegressionPayloads(base: any): Array<{name: string; value: any}> {
  return [
    {name: 'harness-status-field', value: {...base, status: 'verified'}},
    {name: 'harness-claim-field', value: {...base, claim: 'all tests passed'}},
    {name: 'harness-revision-field', value: {...base, revision: 'def456'}},
    {name: 'both-action-aliases', value: {...base, actualActionId: base.actionId}},
    {name: 'missing-action-alias', value: {...base, actionId: undefined}},
    {name: 'both-evidence-aliases', value: {...base, evidenceIds: [...base.evidenceRefs]}},
    {name: 'duplicate-evidence', value: {...base, evidenceRefs: [base.evidenceRefs[0], base.evidenceRefs[0]]}},
    {name: 'unsupported-observed-value', value: {...base, observed: 'verified'}},
    {name: 'caller-reported-false', value: {...base, callerReported: false}},
    {name: 'both-observed-aliases', value: {...base, observedOutcome: base.observed}},
  ];
}

async function countOutcomeFiles(stateRoot: string): Promise<number> {
  const directory = join(stateRoot, 'outcomes');
  if (!(await exists(directory))) return 0;
  return (await readdir(directory)).filter(name => name.endsWith('.json')).length;
}

async function exerciseRegressions(api: any, stateRoot: string, config: any, canonicalRequest: any): Promise<any> {
  const schemaInvalid = schemaRegressionPayloads(canonicalRequest).map(({name, value}) => ({
    name,
    rejected: !api.decisionOutcomeSchema.safeParse(value).success,
  }));
  if (!api.decisionOutcomeSchema.safeParse(canonicalRequest).success || schemaInvalid.some((item: any) => !item.rejected)) {
    throw new Error('actual outcome schema regression');
  }

  const beforeRejectedCalls = await countOutcomeFiles(stateRoot);
  let missingReceiptError: string | null = null;
  try {
    await api.recordDecisionOutcome({...canonicalRequest, receiptId: config.regressionReceipts.missing}, {directory: stateRoot});
  } catch (error) {
    missingReceiptError = error instanceof Error ? error.message : String(error);
  }
  if (missingReceiptError !== 'receipt_not_found') throw new Error(`missing receipt was not rejected: ${missingReceiptError}`);

  const invalidReceiptId = config.regressionReceipts.invalidPersisted;
  await mkdir(join(stateRoot, 'receipts'), {recursive: true, mode: 0o700});
  await writeFile(join(stateRoot, 'receipts', `${invalidReceiptId}.json`), JSON.stringify({
    schemaVersion: 'jev-explicit-outcomes-intentionally-invalid-receipt-v1',
    receiptId: 'does-not-match-file-name',
    synthetic: true,
  }), {encoding: 'utf8', flag: 'wx', mode: 0o600});
  let invalidReceiptError: string | null = null;
  try {
    await api.recordDecisionOutcome({...canonicalRequest, receiptId: invalidReceiptId}, {directory: stateRoot});
  } catch (error) {
    invalidReceiptError = error instanceof Error ? error.message : String(error);
  }
  if (invalidReceiptError !== 'receipt_invalid') throw new Error(`invalid receipt was not rejected: ${invalidReceiptError}`);
  if (await countOutcomeFiles(stateRoot) !== beforeRejectedCalls) throw new Error('rejected receipt call stored an outcome');

  const duplicateReceiptId = config.regressionReceipts.duplicate;
  await seedSyntheticReceipt(stateRoot, duplicateReceiptId);
  const duplicateRequest = {
    receiptId: duplicateReceiptId,
    actionId: 'action-duplicate-observation',
    evidenceRefs: ['synthetic-evidence:duplicate-observation'],
    observed: 'unknown',
    callerReported: true,
    observedAt: '2026-09-26T20:04:00Z',
  };
  const first = await api.recordDecisionOutcome(duplicateRequest, {directory: stateRoot});
  const second = await api.recordDecisionOutcome(duplicateRequest, {directory: stateRoot});
  if (first.outcomeId === second.outcomeId) throw new Error('duplicate observations did not receive distinct record identities');
  const [firstReadback, secondReadback] = await Promise.all([
    readStoredRecord(stateRoot, first),
    readStoredRecord(stateRoot, second),
  ]);
  return {
    schema: {
      validPayloads: 1,
      invalidPayloads: schemaInvalid.length,
      invalidCases: schemaInvalid,
      harnessOnlyFieldsRejected: ['status', 'claim', 'revision'],
    },
    receipts: {
      missing: {attempts: 1, rejected: true, error: missingReceiptError, storedRecords: 0},
      invalidPersisted: {attempts: 1, rejected: true, error: invalidReceiptError, storedRecords: 0},
    },
    duplicateObservations: {
      calls: 2,
      storedRecords: 2,
      deduplicated: false,
      effectIdempotencyEstablished: false,
      outcomeIdsDistinct: true,
      records: [firstReadback, secondReadback],
    },
  };
}

function validateConfig(config: any): void {
  if (config.schemaVersion !== 'jev-explicit-outcomes-experiment-v1') throw new Error('experiment schema mismatch');
  if (!Array.isArray(config.cases) || config.cases.length !== config.denominators.cases) throw new Error('case denominator mismatch');
  if (new Set(config.cases.map((item: any) => item.caseId)).size !== config.cases.length) throw new Error('duplicate experiment case');
  if (config.cases.some((item: any) => item.callerObserved !== 'supported')) throw new Error('caller translation must preserve verified as supported');
}

async function writeReceipt(path: string, receipt: any): Promise<void> {
  if (!isAbsolute(path)) throw new Error('receipt path must be absolute');
  await mkdir(dirname(path), {recursive: true, mode: 0o700});
  const handle = await open(path, 'wx', 0o600).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('receipt_exists');
    throw error;
  });
  try {
    await handle.writeFile(`${JSON.stringify(receipt, null, 2)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(path, 0o600);
}

export async function runExperiment({receiptPath}: {receiptPath: string}): Promise<any> {
  if (!isAbsolute(receiptPath)) throw new Error('receipt path must be absolute');
  if (await exists(receiptPath)) throw new Error('receipt_exists');
  const [config, sourceBefore] = await Promise.all([readJson(configPath), validateFrozenInputs()]);
  validateConfig(config);
  const privateRoot = dirname(receiptPath);
  await mkdir(privateRoot, {recursive: true, mode: 0o700});
  const stateRoot = await mkdtemp(join(privateRoot, '.explicit-outcomes-state-'));
  await chmod(stateRoot, 0o700);
  const startedAt = new Date().toISOString();
  let receipt: any;
  let cleanupVerified = false;
  try {
    const [api, fixtureEngine, inputs, oracle] = await Promise.all([
      import(pathToFileURL(currentApiPath).href),
      import(pathToFileURL(fixtureEnginePath).href),
      readJson(casesInputPath),
      readJson(casesOraclePath),
    ]);
    const results: any[] = [];
    for (const caseConfig of config.cases) {
      const input = inputs.cases.find((item: any) => item.id === caseConfig.caseId);
      const expected = oracle.cases[caseConfig.caseId];
      if (!input || !expected) throw new Error(`missing fixture contract: ${caseConfig.caseId}`);
      if (input.callerReport?.status !== 'verified' || typeof input.callerReport.actionId !== 'string') throw new Error(`caller report translation mismatch: ${caseConfig.caseId}`);
      await seedSyntheticReceipt(stateRoot, caseConfig.storageReceiptId);
      const apiRequest = {
        receiptId: caseConfig.storageReceiptId,
        actionId: input.callerReport.actionId,
        evidenceRefs: [...caseConfig.evidenceRefs],
        observed: caseConfig.callerObserved,
        callerReported: true,
        observedAt: caseConfig.observedAt,
      };
      const pluginRecord = await api.recordDecisionOutcome(apiRequest, {directory: stateRoot});
      assertStoredCallerObservation(pluginRecord, apiRequest);
      const readback = await readStoredRecord(stateRoot, pluginRecord);

      const prepared = await fixtureEngine.prepareCase(caseConfig.caseId);
      let artifact: any;
      let artifactSha256: string;
      let verification: any;
      try {
        const execution = await fixtureEngine.executeCaseAction(prepared, expected.passingAction);
        if (execution.status !== 'completed') throw new Error(`fixture action did not complete: ${caseConfig.caseId}`);
        verification = await fixtureEngine.verifyPostconditions(prepared);
        if (!verification.pass) throw new Error(`fixture oracle failed: ${caseConfig.caseId}`);
        const artifactBytes = await readFile(join(prepared.root, 'records/harness-verification.json'));
        artifact = JSON.parse(artifactBytes.toString('utf8'));
        artifactSha256 = sha256(artifactBytes);
      } finally {
        await fixtureEngine.cleanupCase(prepared);
      }
      const assessment = independentAssessment(caseConfig.caseId, artifact);
      if (artifact.verificationStatus !== caseConfig.expectedFixtureVerificationStatus || assessment !== caseConfig.expectedIndependentAssessment) {
        throw new Error(`independent assessment mismatch: ${caseConfig.caseId}`);
      }
      results.push({
        caseId: caseConfig.caseId,
        callerHarnessInput: input.callerReport,
        translation: {
          sourceStatus: input.callerReport.status,
          storedCallerObservation: apiRequest.observed,
          omittedHarnessOnlyFields: ['status', 'claim', 'revision', 'exitCode', 'stdoutDigest'].filter(field => field in input.callerReport),
        },
        apiRequest,
        pluginStorage: {
          record: pluginRecord,
          readback: {exactMatch: true, sha256: readback.sha256, sizeBytes: readback.sizeBytes, mode: readback.mode},
        },
        independentHarness: {
          action: expected.passingAction,
          artifact,
          artifactSha256,
          oraclePass: verification.pass,
          violations: verification.violations,
          assessment,
        },
        callerAndHarnessAgree: apiRequest.observed === assessment,
      });
    }
    const regressions = await exerciseRegressions(api, stateRoot, config, results[0].apiRequest);
    const storedRecordCount = await countOutcomeFiles(stateRoot);
    const assessmentCounts = Object.fromEntries(['supported', 'unknown', 'unsupported', 'contradicted'].map(status => [
      status,
      results.filter(item => item.independentHarness.assessment === status).length,
    ]));
    const divergenceCount = results.filter(item => !item.callerAndHarnessAgree).length;
    const summary = {
      plannedCases: config.denominators.cases,
      completedCases: results.length,
      excludedCases: 0,
      callerSupportedObservations: results.filter(item => item.pluginStorage.record.observedOutcome === 'supported').length,
      independentHarnessActions: results.length,
      independentHarnessOraclePasses: results.filter(item => item.independentHarness.oraclePass).length,
      independentAssessmentCounts: assessmentCounts,
      callerHarnessDivergences: divergenceCount,
      apiCallsAttempted: results.length + regressions.receipts.missing.attempts + regressions.receipts.invalidPersisted.attempts + regressions.duplicateObservations.calls,
      apiCallsStored: storedRecordCount,
      apiCallsRejected: regressions.receipts.missing.attempts + regressions.receipts.invalidPersisted.attempts,
      storedRecordReadbacks: results.length + regressions.duplicateObservations.records.length,
      storedRecordReadbackMatches: results.length + regressions.duplicateObservations.records.length,
    };
    if (!isDeepStrictEqual(assessmentCounts, config.denominators.expectedHarnessAssessments)
      || divergenceCount !== config.denominators.expectedCallerHarnessDivergences
      || summary.apiCallsAttempted !== config.denominators.totalApiCalls
      || storedRecordCount !== config.denominators.expectedStoredRecords) {
      throw new Error('result denominator mismatch');
    }
    const sourceAfter = await validateFrozenInputs();
    if (!isDeepStrictEqual(sourceBefore, sourceAfter)) throw new Error('source or fixture inputs changed during experiment');
    receipt = {
      schemaVersion: 'jev-explicit-outcomes-receipt-v1',
      startedAt,
      finishedAt: new Date().toISOString(),
      scope: 'offline direct API storage contract plus independent authored fixture grading',
      execution: {
        nodeVersion: process.version,
        platform: process.platform,
        architecture: process.arch,
        api: 'recordDecisionOutcome',
        apiInvocation: 'direct-source-import',
        mcpTransportInvoked: false,
        providerInvoked: false,
        modelInvoked: false,
        credentialsReadByRunner: false,
        syntheticReceiptsOnly: true,
      },
      provenance: {
        source: sourceBefore,
        sourceStableDuringRun: true,
        fixtureInputs: 'benchmarks/plugin-development/cases',
        fixtureEngine: 'benchmarks/plugin-development/cases/fixture-engine.mjs',
        independentVerificationOwnedBy: 'experiment-harness',
        pluginIndependentVerificationClaim: false,
      },
      denominators: config.denominators,
      summary,
      cases: results,
      regressions,
      limits: [
        'The plugin record stores a caller observation and references; it does not verify the reported effect.',
        'The independent assessment comes from the authored fixture engine, not from Jev or an MCP provider.',
        'Repeated identical observations create distinct records; this experiment establishes no effect idempotency.',
        'No MCP transport, provider, model, installation, grading service, or held-out coding task was invoked.',
      ],
    };
  } finally {
    await rm(stateRoot, {recursive: true, force: true});
    cleanupVerified = !(await exists(stateRoot));
  }
  if (!cleanupVerified) throw new Error('temporary state cleanup could not be verified');
  receipt.cleanup = {temporaryStateRemoved: true, retainedReceiptOnly: true};
  await writeReceipt(receiptPath, receipt);
  return receipt;
}

function parseReceiptArgument(args: string[]): string {
  if (args.length !== 2 || args[0] !== '--receipt' || !isAbsolute(args[1])) {
    throw new Error('usage: run.ts --receipt /absolute/private/path.json');
  }
  return args[1];
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const receiptPath = parseReceiptArgument(process.argv.slice(2));
  const result = await runExperiment({receiptPath});
  process.stdout.write(`${JSON.stringify({
    receiptPath,
    summary: result.summary,
    cleanup: result.cleanup,
  }, null, 2)}\n`);
}

export {experimentDir, publicationRoot};
