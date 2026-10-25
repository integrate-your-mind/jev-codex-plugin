import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const workspace = process.cwd();

function parseArgs(argv) {
  let sourceRoot = resolve(here, '../../source/jev-workflows');
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== '--source-root' || !argv[index + 1]) throw new Error('usage: node benchmarks/plugin-features/run.mjs [--source-root /absolute/source/jev-workflows]');
    sourceRoot = resolve(argv[++index]);
  }
  return {sourceRoot};
}

const {sourceRoot} = parseArgs(process.argv.slice(2));
const sourceModule = name => import(pathToFileURL(join(sourceRoot, 'src', name)).href);
const [{runDecisionHook}, {configurePolicy}, {updateTaskContext}, {createService}] = await Promise.all([
  sourceModule('decision-hook.ts'), sourceModule('policy.ts'), sourceModule('task-context.ts'), sourceModule('service.ts'),
]);
const scenarios = (await import('./scenarios.json', {with: {type: 'json'}})).default;
const truth = (await import('./truth-labels.json', {with: {type: 'json'}})).default;
const external = (await import('./external-reproductions.json', {with: {type: 'json'}})).default;

const clone = value => JSON.parse(JSON.stringify(value));
const jsonSha = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const normalizeRelative = value => value.split(sep).join('/');

async function sourceSha256(root) {
  const files = [];
  async function visit(directory) {
    for (const entry of (await readdir(directory, {withFileTypes: true})).sort((left, right) => left.name.localeCompare(right.name))) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) files.push(path);
    }
  }
  await visit(root);
  const hash = createHash('sha256');
  for (const path of files.sort()) {
    hash.update(normalizeRelative(relative(root, path)));
    hash.update('\0');
    hash.update(await readFile(path));
    hash.update('\0');
  }
  return hash.digest('hex');
}

function env(data) {
  return {PLUGIN_DATA: data, JEV_ENABLED: '1', TYPESAFE_API_KEY: 'benchmark-key'};
}

function serviceFor(mock, calls) {
  return {async classifyDecision(input) { calls.push(clone(input)); return clone(mock); }};
}

function outputText(result) {
  return result.hookSpecificOutput?.additionalContext ?? result.systemMessage ?? '';
}

function exactDecision(text, choice) {
  const decisions = [...text.matchAll(/decision=([a-zA-Z0-9._:-]+)/g)].map(match => match[1]);
  return decisions.length === 1 && decisions[0] === choice && text.includes(`status=assessed; decision=${choice};`);
}

function check(id, first, second, calls, metadata = {}) {
  const input = calls[0];
  const output = outputText(first);
  if (id === 'candidate_payload') return input?.candidates.some(candidate => candidate.id === 'safe-check') === true;
  if (id === 'advice_dynamic_candidate') return output.includes('status=assessed; decision=safe-check;') && !output.includes('decision=skip-check');
  if (id === 'advice_concrete_candidate') return exactDecision(output, 'read_thread');
  if (id === 'fallback_candidates') return JSON.stringify(input?.candidates ?? []).includes('proceed');
  if (id === 'neutral_abstention' || id === 'neutral_unavailable') return !output.includes('decision=');
  if (id === 'failure_evidence') return input?.evidence.some(evidence => evidence.id === 'tool.failure' && evidence.text.includes('tests failed')) === true;
  if (id === 'advice_choice') return output.includes('decision=gather_evidence');
  if (id === 'prompt_context') return calls.some(call => call.context.includes('Latest constraint'));
  if (id === 'replacement_context') return input?.context.includes('Ship the release note only') === true && !input.context.includes('Investigate the parser regression');
  if (id === 'bounded_valid_json') {
    const parsed = JSON.parse(input?.context ?? 'null');
    return Buffer.byteLength(input?.context ?? '') <= 5_000 && parsed.contextTruncated === true;
  }
  if (id === 'redaction') return !JSON.stringify(input).includes('super-secret-token');
  if (id === 'critical_survives') return input?.evidence.some(evidence => evidence.text.includes('CRITICAL: migration checksum mismatch')) === true;
  if (id === 'duplicate_dedup') return calls.length === 1 && second && Object.keys(second).length === 0;
  if (id === 'completion_evidence') return input?.evidence.some(evidence => evidence.id === 'result.message' && evidence.text.includes('Completed')) === true;
  if (id === 'ignored') return Object.keys(first).length === 0 && calls.length === 0;
  if (id === 'choice_filtered') return output.includes('status=unavailable; reason=invalid_choice;') && !output.includes('decision=') && !output.includes('invented-choice');
  if (id === 'candidate_schema') return input?.candidates.some(candidate => candidate.id === 'bad id!') !== true && input?.candidates.some(candidate => candidate.id === 'valid') === true;
  if (id === 'success_evidence') return input?.evidence.some(evidence => evidence.id === 'tool.result' && evidence.text.includes('BUILD_OK')) === true;
  if (id === 'provider_reached') return metadata.providerCalls === 1;
  if (id === 'provider_response_validated') return metadata.providerCalls === 1 && metadata.responseValidated === true;
  if (id === 'hook_context_bounded') return metadata.hookContextBytes !== undefined && metadata.hookContextBytes <= 5_000 && metadata.hookContextTruncated === true;
  if (id === 'context_bounded') return metadata.contextBytes !== undefined && metadata.contextBytes <= 12_000 && metadata.contextTruncated === true;
  return false;
}

function validProviderFetch(selectedChoice, calls) {
  return async (_url, init) => {
    const payload = JSON.parse(String(init?.body));
    calls.push({payload, authorization: init?.headers?.authorization ?? init?.headers?.Authorization ?? null});
    const criteria = Object.keys(payload.questions?.decision?.criteria ?? {});
    if (!criteria.includes(selectedChoice)) throw new Error(`mock choice not available: ${selectedChoice}`);
    const remainder = criteria.length > 1 ? (1 - 0.91) / (criteria.length - 1) : 0;
    const probabilities = Object.fromEntries(criteria.map(id => [id, id === selectedChoice ? 0.91 : remainder]));
    return new Response(JSON.stringify({
      model: 'jev-1.13.0', answers: {decision: {type: 'choice', choice: selectedChoice, probabilities, confidence: 0.96}},
      usage: {input_tokens: 31, output_tokens: 11},
    }), {status: 200, headers: {'content-type': 'application/json', 'x-typesafe-request-id': 'benchmark-mock-request'}});
  };
}

async function runLargeContextScenario(scenario, environment) {
  const sessionId = 'large-saved-context-session';
  const opaqueSecret = 'sk-123456789012345';
  const segment = 'x'.repeat(1_500);
  const saved = await updateTaskContext({cwd: workspace, sessionId}, {
    operation: 'replace', rootObjective: `root-${segment}`,
    constraints: Array.from({length: 9}, (_, index) => `constraint-${index}-${index === 0 ? opaqueSecret : ''}${segment}`),
    criteria: ['Retain the latest constraint and result metadata.'], provenance: {source: 'system'},
  }, {env: environment});
  if (!saved) throw new Error('large saved task context was not persisted');
  const fetchCalls = [];
  const serviceInvocations = [];
  const rawService = createService({apiKey: 'benchmark-key', env: environment, fetchFn: validProviderFetch('proceed', fetchCalls)});
  const service = {
    ...rawService,
    async classifyDecision(input) {
      serviceInvocations.push(clone(input));
      return rawService.classifyDecision(input);
    },
  };
  const event = {...clone(scenario.event), cwd: workspace, session_id: sessionId, prompt: `Continue the bounded task ${opaqueSecret}`};
  const first = await runDecisionHook(JSON.stringify(event), {env: environment, service});
  const providerPayload = fetchCalls[0]?.payload;
  const contextText = providerPayload?.state?.context;
  const hookContextText = serviceInvocations[0]?.context;
  let hookContext;
  let context;
  try { hookContext = JSON.parse(hookContextText); } catch { hookContext = undefined; }
  try { context = JSON.parse(contextText); } catch { context = undefined; }
  const metadata = {
    providerCalls: fetchCalls.length,
    serviceInvocations: serviceInvocations.length,
    responseValidated: fetchCalls.length === 1 && outputText(first).includes('status=assessed'),
    hookContextBytes: typeof hookContextText === 'string' ? Buffer.byteLength(hookContextText) : undefined,
    hookContextTruncated: hookContext?.contextTruncated === true,
    contextBytes: typeof contextText === 'string' ? Buffer.byteLength(contextText) : undefined,
    contextTruncated: context?.contextTruncated === true,
  };
  const checks = Object.fromEntries(scenario.checks.map(name => [name, check(name, first, undefined, [], metadata)]));
  checks.no_secret_egress = !JSON.stringify([...serviceInvocations, ...fetchCalls.map(call => call.payload)]).includes(opaqueSecret);
  const requirementSatisfied = Object.values(checks).every(Boolean);
  return {
    first, calls: fetchCalls, serviceInvocations, checks, requirementSatisfied,
    behaviorObserved: fetchCalls.length === 0 ? 'hook_input_rejected_before_provider' : 'bounded_task_context_reached_synthetic_provider',
    classification: 'provider_reproduction', mockLayer: 'response-validating-synthetic-fetch', metadata,
  };
}

const results = [];
for (const scenario of scenarios) {
  const data = await mkdtemp(join(tmpdir(), 'jev-plugin-feature-'));
  const calls = [];
  let first = {};
  let second;
  try {
    const environment = env(data);
    await configurePolicy({enabled: true, scope: 'workspaces', workspaces: [workspace], maxHookCallsPerSession: null}, environment);
    if (scenario.id === 'large-context-schema') {
      const reproduction = await runLargeContextScenario(scenario, environment);
      results.push({id: scenario.id, requirement: truth.requirements[scenario.id], executionPassed: true,
        behaviorObserved: reproduction.behaviorObserved, requirementSatisfied: reproduction.requirementSatisfied,
        requirementStatus: reproduction.requirementSatisfied ? 'satisfied' : 'failed', checks: reproduction.checks,
        providerPayloadSha256: reproduction.calls[0] ? jsonSha(reproduction.calls[0].payload) : null,
        outputSha256: jsonSha(reproduction.first), serviceInvocations: reproduction.serviceInvocations.length,
        mockTransportCalls: reproduction.calls.length,
        classification: reproduction.classification, mockLayer: reproduction.mockLayer, metadata: reproduction.metadata});
      continue;
    }
    if (scenario.id === 'objective-replacement') {
      const scope = {cwd: workspace, sessionId: scenario.event.session_id};
      await updateTaskContext(scope, {operation: 'replace', rootObjective: 'Investigate the parser regression first.', provenance: {source: 'system'}}, {env: environment});
      await updateTaskContext(scope, {operation: 'replace', rootObjective: 'Ship the release note only.', constraints: ['Only the release note is in scope.'], provenance: {source: 'user_prompt', eventId: 'replace-0'}}, {env: environment});
    }
    const event = clone(scenario.event);
    event.cwd = workspace;
    first = await runDecisionHook(JSON.stringify(event), {env: environment, service: serviceFor(scenario.mock, calls)});
    if (scenario.followup) await runDecisionHook(JSON.stringify({...clone(scenario.followup), cwd: workspace}), {env: environment, service: serviceFor(scenario.mock, calls)});
    if (scenario.duplicate) second = await runDecisionHook(JSON.stringify({...clone(scenario.duplicate), cwd: workspace}), {env: environment, service: serviceFor(scenario.mock, calls)});
    const checks = Object.fromEntries(scenario.checks.map(name => [name, check(name, first, second, calls)]));
    const executionPassed = Object.keys(first).length > 0 || scenario.id === 'invalid-event';
    const requirementSatisfied = Object.values(checks).every(Boolean);
    results.push({id: scenario.id, requirement: truth.requirements[scenario.id], executionPassed,
      behaviorObserved: requirementSatisfied ? 'observed_requirement_satisfied' : 'observed_requirement_failed',
      requirementSatisfied, requirementStatus: requirementSatisfied ? 'satisfied' : 'failed', checks,
      providerPayloadSha256: calls[0] ? jsonSha(calls[0]) : null, outputSha256: jsonSha(first),
      serviceInvocations: calls.length, mockTransportCalls: 0,
      classification: 'fixture_replay', mockLayer: 'service-injection-bypasses-response-validation'});
  } catch (error) {
    results.push({id: scenario.id, requirement: truth.requirements[scenario.id], executionPassed: false,
      behaviorObserved: 'runner_error', requirementSatisfied: 'unknown', requirementStatus: 'unknown',
      error: String(error), classification: 'fixture_replay', mockLayer: 'service-injection-bypasses-response-validation'});
  } finally {
    await rm(data, {recursive: true, force: true});
  }
}

const output = {
  schemaVersion: 3,
  generatedAt: new Date().toISOString(),
  sourceRoot: `${basename(dirname(sourceRoot))}/${basename(sourceRoot)}`,
  sourceContentSha256: await sourceSha256(join(sourceRoot, 'src')),
  providerCalls: false,
  serviceInvocations: results.reduce((total, result) => total + (result.serviceInvocations ?? 0), 0),
  mockProviderCalls: results.reduce((total, result) => total + (result.mockTransportCalls ?? 0), 0),
  classification: 'mixed_fixture_replay_and_synthetic_provider',
  fixtureHashes: {scenarios: jsonSha(scenarios), truth: jsonSha(truth), external: jsonSha(external)},
  externalFixtures: external.fixtures.map(fixture => ({...fixture, observed: false})),
  scenarios: results,
};
process.stdout.write(JSON.stringify(output, null, 2) + '\n');
