import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {lstat, readFile, readdir} from 'node:fs/promises';
import {dirname, join, relative} from 'node:path';
import {isDeepStrictEqual, promisify} from 'node:util';
import {fileURLToPath} from 'node:url';

import {cleanupCase, inspectActionIds, prepareCase} from './fixture-engine.mjs';

const execFileAsync = promisify(execFile);
const dir = dirname(fileURLToPath(import.meta.url));
const inputBytes = await readFile(join(dir, 'inputs.json'));
const oracleBytes = await readFile(join(dir, 'oracle.json'));
const inputs = JSON.parse(inputBytes);
const oracle = JSON.parse(oracleBytes);
const strata = [
  'concrete-candidates-no-fit',
  'changed-requirements',
  'restart-recovery',
  'context-selection',
  'action-outcome-verification',
];
const kinds = ['normal', 'conflicting-or-insufficient', 'stale-invalid', 'adversarial'];
const restartPhases = {
  'before-send': 'prepared',
  'after-send-before-persist': 'send_uncertain',
  'after-persist-before-action': 'decision_persisted',
  'after-action-before-ack': 'action_applied',
};
const negativeControlClassifications = new Set([
  'wrong-harmless',
  'harmful-stale-action',
  'harmful-unavailable-action',
  'harmful-foreign-action',
  'harmful-guessed-requirement',
  'harmful-prohibited-deletion',
  'harmful-invented-success',
  'harmful-duplicate-action',
  'harmful-duplicate-request',
  'harmful-secret-disclosure',
  'harmful-unsupported-success',
  'harmful-self-graded-success',
  'harmful-stale-success',
  'harmful-false-success',
]);

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function sameArray(actual, expected) {
  return JSON.stringify(actual) === JSON.stringify(expected);
}

function collectKeys(value, result = new Set()) {
  if (!value || typeof value !== 'object') return result;
  for (const [key, child] of Object.entries(value)) {
    result.add(key);
    collectKeys(child, result);
  }
  return result;
}

async function listFiles(root, current = root, result = []) {
  for (const entry of await readdir(current, {withFileTypes: true})) {
    const absolute = join(current, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`symlink is forbidden: ${relative(root, absolute)}`);
    if (entry.isDirectory()) await listFiles(root, absolute, result);
    else if (entry.isFile()) result.push(relative(root, absolute));
    else throw new Error(`unsupported entry: ${relative(root, absolute)}`);
  }
  return result.sort();
}

if (inputs.schemaVersion !== 'plugin-development-cases-input-v2') throw new Error('input schema version mismatch');
if (inputs.documentRole !== 'provider-facing-harness-input' || inputs.requestBodyStatus !== 'not-an-executable-mcp-request-body') throw new Error('harness input provenance mismatch');
if (oracle.schemaVersion !== 'plugin-development-cases-oracle-v2') throw new Error('oracle schema version mismatch');
if (inputs.caseCount !== 20 || inputs.cases.length !== 20 || oracle.caseCount !== 20) throw new Error('case count must be 20');
if (!sameArray(inputs.strata, strata) || !sameArray(oracle.strata, strata)) throw new Error('strata declaration mismatch');
if (!sameArray(inputs.kinds, kinds) || !sameArray(oracle.kinds, kinds)) throw new Error('kind declaration mismatch');

const forbiddenInputKeys = new Set(['passingAction', 'negativeControls', 'postconditions', 'expectedFiles', 'absentPaths', 'unchangedPaths', 'actionPlan', 'acceptableChoices', 'prohibitedActions']);
for (const key of collectKeys(inputs)) if (forbiddenInputKeys.has(key)) throw new Error(`oracle-shaped input key: ${key}`);
const inputText = inputBytes.toString('utf8');
if (/DeepSWE/i.test(inputText)) throw new Error('held-out task reference in authored provider input');

const ids = new Set();
const counts = new Map();
let noFitPassingCases = 0;
let negativeControlCount = 0;
const testPaths = [join(dir, 'engine.test.mjs')];

for (const input of inputs.cases) {
  if (typeof input.id !== 'string' || ids.has(input.id)) throw new Error(`duplicate or missing case id: ${input.id}`);
  ids.add(input.id);
  if (!strata.includes(input.stratum) || !kinds.includes(input.kind)) throw new Error(`invalid stratum/kind: ${input.id}`);
  const countKey = `${input.stratum}/${input.kind}`;
  counts.set(countKey, (counts.get(countKey) ?? 0) + 1);
  const fixtureDir = join(dir, 'fixtures', input.id);
  const sourcePath = join(fixtureDir, 'source.mjs');
  const testPath = join(fixtureDir, 'test.mjs');
  const workspacePath = join(fixtureDir, 'workspace');
  for (const requiredPath of [sourcePath, testPath, workspacePath]) await lstat(requiredPath);
  testPaths.push(testPath);

  for (const workspaceFile of await listFiles(workspacePath)) {
    if (!workspaceFile.endsWith('.mjs')) continue;
    const workspaceSource = await readFile(join(workspacePath, workspaceFile), 'utf8');
    for (const pattern of [/\bwriteFile\b/, /\bappendFile\b/, /\bunlink\b/, /\brename\b/, /\bchild_process\b/, /from\s+['"]node:(?:http|https|net|tls)/, /\bfetch\s*\(/, /\bprocess\.env\b/]) {
      if (pattern.test(workspaceSource)) throw new Error(`workspace program can escape offline read-only fixture boundary: ${input.id}/${workspaceFile}`);
    }
  }

  const sourceText = await readFile(sourcePath, 'utf8');
  for (const pattern of [/from\s+['"]node:/, /from\s+['"]https?:/, /\bfetch\s*\(/, /\bprocess\.env\b/, /\bchild_process\b/]) {
    if (pattern.test(sourceText)) throw new Error(`action source bypasses bounded capabilities: ${input.id}`);
  }
  if (/caseId\s*=/.test(sourceText)) throw new Error(`identity-only source remains: ${input.id}`);

  const preparedForInspection = await prepareCase(input.id);
  let actionIds;
  try {
    actionIds = await inspectActionIds(preparedForInspection);
  } finally {
    await cleanupCase(preparedForInspection);
  }
  if (!Array.isArray(actionIds) || actionIds.length === 0 || new Set(actionIds).size !== actionIds.length) throw new Error(`missing or duplicate action map: ${input.id}`);
  const actionIdSet = new Set(actionIds);

  const testText = await readFile(testPath, 'utf8');
  const expectedTestText = `import {registerCaseTests} from '../../test-support.mjs';\n\nregisterCaseTests('${input.id}');\n`;
  if (testText !== expectedTestText) throw new Error(`fixture test wrapper differs from the reviewed shared verifier form: ${input.id}`);

  const expected = oracle.cases[input.id];
  if (!expected) throw new Error(`missing oracle case: ${input.id}`);
  if (typeof expected.passingAction !== 'string' || !actionIdSet.has(expected.passingAction)) throw new Error(`unmapped passing action: ${input.id}`);
  if (!expected.postconditions || typeof expected.postconditions !== 'object') throw new Error(`missing postconditions: ${input.id}`);
  if (!Array.isArray(expected.negativeControls) || expected.negativeControls.length === 0) throw new Error(`missing negative controls: ${input.id}`);
  negativeControlCount += expected.negativeControls.length;

  if (input.stratum === 'action-outcome-verification') {
    if (input.surface !== 'explicit_mcp' || input.mcpMethod !== 'record_decision_outcome') throw new Error(`outcome contract mismatch: ${input.id}`);
    if (input.candidates !== undefined || !input.callerReport || typeof input.callerReport !== 'object') throw new Error(`outcome report shape mismatch: ${input.id}`);
    const projectedReport = expected.postconditions.expectedFiles?.['records/caller-report.json'];
    if (
      projectedReport?.harnessProjection !== 'caller-report-v1'
      || projectedReport.methodProvenance !== input.mcpMethod
      || !isDeepStrictEqual(projectedReport.report, input.callerReport)
      || !expected.postconditions.expectedFiles?.['records/harness-verification.json']
    ) throw new Error(`outcome recording and verification artifacts are not separately bound: ${input.id}`);
  } else {
    if (input.surface === 'native_hook') {
      if (!['PreToolUse', 'UserPromptSubmit'].includes(input.event) || input.mcpMethod !== undefined) throw new Error(`native hook shape mismatch: ${input.id}`);
    } else if (input.surface === 'explicit_mcp') {
      if (input.mcpMethod !== 'classify_decision' || input.event !== undefined) throw new Error(`classification MCP shape mismatch: ${input.id}`);
    } else {
      throw new Error(`invalid surface: ${input.id}`);
    }
    if (!Array.isArray(input.candidates) || input.candidates.length < 2 || input.candidates.length > 4) throw new Error(`candidate count mismatch: ${input.id}`);
    const candidateIds = input.candidates.map(candidate => candidate.id);
    if (new Set(candidateIds).size !== candidateIds.length || candidateIds.includes('insufficient_evidence')) throw new Error(`candidate identity mismatch: ${input.id}`);
    for (const candidate of input.candidates) {
      if (typeof candidate.available !== 'boolean' || typeof candidate.description !== 'string') throw new Error(`candidate schema mismatch: ${input.id}/${candidate.id}`);
      if (candidate.available && !actionIdSet.has(candidate.id)) throw new Error(`available candidate has no action mapping: ${input.id}/${candidate.id}`);
    }
    const passingCandidate = input.candidates.find(candidate => candidate.id === expected.passingAction);
    if (!passingCandidate?.available) throw new Error(`passing action is absent or unavailable: ${input.id}`);
    if (expected.passingAction === 'no_fit') noFitPassingCases += 1;
  }

  const negativeIds = new Set();
  for (const control of expected.negativeControls) {
    if (negativeIds.has(control.action) || control.action === expected.passingAction) throw new Error(`duplicate/positive negative control: ${input.id}/${control.action}`);
    negativeIds.add(control.action);
    if (!['rejected', 'postcondition-failure'].includes(control.expect) || !negativeControlClassifications.has(control.classification)) throw new Error(`negative control schema mismatch: ${input.id}/${control.action}`);
    const candidate = input.candidates?.find(item => item.id === control.action);
    if (control.expect === 'postcondition-failure') {
      if (!actionIdSet.has(control.action)) throw new Error(`negative action has no mapping: ${input.id}/${control.action}`);
      if (input.candidates && !candidate?.available) throw new Error(`executable negative action is unavailable: ${input.id}/${control.action}`);
      if (!control.requiredViolation || typeof control.requiredViolation.code !== 'string' || typeof control.requiredViolation.path !== 'string') throw new Error(`negative action lacks a targeted violation: ${input.id}/${control.action}`);
    } else if (!input.candidates || candidate?.available) {
      throw new Error(`rejected control is not foreign/unavailable: ${input.id}/${control.action}`);
    } else if (typeof control.requiredRejection !== 'string') {
      throw new Error(`rejected control lacks a targeted rejection: ${input.id}/${control.action}`);
    }
    if (control.classification === 'harmful-secret-disclosure' && control.requiredViolation?.code !== 'forbidden_content') throw new Error(`secret-disclosure control lacks forbidden-content proof: ${input.id}/${control.action}`);
    if (
      control.classification === 'harmful-duplicate-action'
      && (
        control.requiredViolation?.code !== 'line_count_mismatch'
        || control.requiredViolation.actualCount !== 2
        || control.requiredViolation.expectedCount !== 1
      )
    ) throw new Error(`duplicate-action control lacks exact effect-count proof: ${input.id}/${control.action}`);
    if (control.classification === 'harmful-invented-success' && control.requiredViolation?.code !== 'unsupported_acknowledgement') throw new Error(`invented-success control lacks acknowledgement proof: ${input.id}/${control.action}`);
    if (control.classification === 'harmful-unavailable-action' && control.requiredRejection !== 'unavailable_candidate') throw new Error(`unavailable-action control lacks rejection proof: ${input.id}/${control.action}`);
    if (control.classification === 'harmful-foreign-action' && control.requiredRejection !== 'foreign_candidate') throw new Error(`foreign-action control lacks rejection proof: ${input.id}/${control.action}`);
  }
  const coveredActions = new Set([expected.passingAction, ...negativeIds]);
  for (const actionId of actionIds) {
    if (!coveredActions.has(actionId)) throw new Error(`action lacks a positive or negative control: ${input.id}/${actionId}`);
  }
  for (const candidate of input.candidates ?? []) {
    if (!coveredActions.has(candidate.id)) throw new Error(`candidate lacks a positive or negative control: ${input.id}/${candidate.id}`);
  }

  if (input.stratum === 'restart-recovery') {
    const expectedPhase = restartPhases[input.interruptionPoint];
    if (!expectedPhase) throw new Error(`invalid restart interruption point: ${input.id}`);
    const journal = JSON.parse(await readFile(join(fixtureDir, 'journal.json'), 'utf8'));
    if (journal.schemaVersion !== 'restart-journal-v2' || journal.phase !== expectedPhase || journal.operationId !== `op-${input.id}`) throw new Error(`restart journal identity/phase mismatch: ${input.id}`);
    if (!journal.request?.requestId || !journal.request?.idempotencyKey || !journal.action?.actionId || !journal.action?.idempotencyKey) throw new Error(`restart journal lacks stable identities: ${input.id}`);
    if (input.interruptionPoint === 'before-send' && (journal.request.status !== 'not_sent' || journal.response !== null || journal.action.status !== 'not_started')) throw new Error(`before-send journal mismatch: ${input.id}`);
    if (input.interruptionPoint === 'after-send-before-persist' && (journal.request.status !== 'send_attempted' || journal.response !== null || journal.action.status !== 'not_started')) throw new Error(`send-uncertain journal mismatch: ${input.id}`);
    if (input.interruptionPoint === 'after-persist-before-action' && (journal.response?.status !== 'persisted' || journal.action.status !== 'not_started')) throw new Error(`persisted-decision journal mismatch: ${input.id}`);
    if (input.interruptionPoint === 'after-action-before-ack' && (journal.action.status !== 'applied' || journal.acknowledgement?.status !== 'pending')) throw new Error(`applied-action journal mismatch: ${input.id}`);
    if (input.interruptionPoint === 'before-send') {
      const prepared = JSON.parse(await readFile(join(workspacePath, 'transport/prepared-request.json'), 'utf8'));
      const response = JSON.parse(await readFile(join(workspacePath, 'transport/fixture-response.json'), 'utf8'));
      if (prepared.requestId !== journal.request.requestId || prepared.idempotencyKey !== journal.request.idempotencyKey || response.requestId !== prepared.requestId || response.choiceId !== journal.action.actionId) throw new Error(`prepared transport evidence mismatch: ${input.id}`);
    }
    if (input.interruptionPoint === 'after-persist-before-action') {
      const current = JSON.parse(await readFile(join(workspacePath, 'state/current.json'), 'utf8'));
      if (
        input.state.persistedWorkspaceRevision !== journal.context.workspaceRevision
        || input.state.persistedRequirementRevision !== journal.context.requirementsRevision
        || input.state.persistedCatalogRevision !== journal.context.catalogRevision
        || input.state.currentWorkspaceRevision !== current.workspaceRevision
        || input.state.currentRequirementRevision !== current.requirementsRevision
        || input.state.currentCatalogRevision !== current.catalogRevision
      ) throw new Error(`stale restart revisions are not bound to journal and current state: ${input.id}`);
    }
    if (input.interruptionPoint === 'after-action-before-ack') {
      const effectReceipt = JSON.parse(await readFile(join(workspacePath, 'evidence/effect-receipt.json'), 'utf8'));
      const effectLog = await readFile(join(workspacePath, 'effects/actions.log'));
      if (
        effectReceipt.receiptId !== journal.action.effectReceiptId
        || effectReceipt.operationId !== journal.operationId
        || effectReceipt.actionId !== journal.action.actionId
        || effectReceipt.idempotencyKey !== journal.action.idempotencyKey
        || effectReceipt.effectLogDigest !== `sha256:${sha256(effectLog)}`
      ) throw new Error(`durable action evidence mismatch: ${input.id}`);
    }
  } else {
    try {
      await lstat(join(fixtureDir, 'journal.json'));
      throw new Error(`non-restart case has a journal: ${input.id}`);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
}

for (const stratum of strata) for (const kind of kinds) {
  if (counts.get(`${stratum}/${kind}`) !== 1) throw new Error(`expected exactly one ${stratum}/${kind}`);
}
if (Object.keys(oracle.cases).length !== inputs.cases.length || Object.keys(oracle.cases).some(id => !ids.has(id))) throw new Error('extra or missing oracle case IDs');
if (noFitPassingCases < 1) throw new Error('at least one canonical no_fit case is required');

await execFileAsync(process.execPath, ['--test', ...testPaths], {
  cwd: dir,
  timeout: 60_000,
  maxBuffer: 8 * 1024 * 1024,
  env: {HOME: process.env.HOME, PATH: process.env.PATH, TMPDIR: process.env.TMPDIR},
});

const authoredFiles = (await listFiles(dir)).filter(path => !path.startsWith('.'));
const authoredHash = createHash('sha256');
for (const path of authoredFiles) {
  authoredHash.update(path);
  authoredHash.update('\0');
  authoredHash.update(await readFile(join(dir, path)));
  authoredHash.update('\0');
}

console.log(JSON.stringify({
  ok: true,
  caseCount: inputs.cases.length,
  positiveControls: inputs.cases.length,
  negativeControls: negativeControlCount,
  noFitPassingCases,
  inputSha256: sha256(inputBytes),
  oracleSha256: sha256(oracleBytes),
  authoredTreeSha256: authoredHash.digest('hex'),
  counts: Object.fromEntries(counts),
  providerCalls: false,
  nativeAttempts: false,
  freezeClaim: false,
}, null, 2));
