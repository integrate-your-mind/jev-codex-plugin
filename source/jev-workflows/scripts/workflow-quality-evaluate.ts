import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { createService, type Assessment } from '../src/service.js';
import { FileStore } from '../src/store.js';
import { decisionSchema, DECISION_RUBRIC_VERSION, decisionQuestions } from '../src/decision.js';
import { MODEL } from '../src/contracts.js';

export const REQUIRED_TAGS = [
  'no_available_choice',
  'changed_goal',
  'missing_evidence',
  'misleading_success',
  'close_alternatives',
  'adversarial_state',
  'real_capability_constraints',
] as const;

export type ExpectedLabel = {
  acceptableChoices: string[];
  requiredAbstention: boolean;
  rationale: string;
};

export type WorkflowCase = {
  id: string;
  split: 'development' | 'heldout';
  domain: 'tool' | 'model' | 'task' | 'skill' | 'context' | 'strategy' | 'result' | 'general';
  tags: string[];
  input: ReturnType<typeof decisionSchema.parse>;
  label: ExpectedLabel;
};

export type WorkflowDataset = {
  schemaVersion: 'workflow-quality-v1';
  labelPolicyVersion: string;
  splitPolicy: string;
  cases: WorkflowCase[];
};

export type ScoredCase = {
  evaluated: boolean;
  predictedChoice: string | null;
  abstained: boolean;
  correct: boolean | null;
  falseConfident: boolean;
};

export type EvaluationRow = {
  id: string;
  split: WorkflowCase['split'];
  domain: WorkflowCase['domain'];
  tags: string[];
  expected: ExpectedLabel;
  result: Assessment;
  score: ScoredCase;
};

const fixtureUrl = new URL('../fixtures/workflow-quality-v1.json', import.meta.url);
const domains = new Set(['tool', 'model', 'task', 'skill', 'context', 'strategy', 'result', 'general']);

function fail(message: string): never {
  throw new Error(message);
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function canonicalInput(input: ReturnType<typeof decisionSchema.parse>): string {
  return JSON.stringify(input);
}

/** Parse and validate labels before any provider result exists. */
export function loadDataset(raw: unknown): WorkflowDataset {
  const dataset = asRecord(raw, 'workflow-quality-v1');
  if (dataset.schemaVersion !== 'workflow-quality-v1') fail('workflow-quality-v1 has an unsupported schemaVersion.');
  if (typeof dataset.labelPolicyVersion !== 'string' || dataset.labelPolicyVersion.length === 0) fail('workflow-quality-v1 has no labelPolicyVersion.');
  if (typeof dataset.splitPolicy !== 'string' || !dataset.splitPolicy.toLowerCase().includes('provider')) fail('workflow-quality-v1 must state that split assignment is independent of provider results.');
  if (!Array.isArray(dataset.cases) || dataset.cases.length === 0) fail('workflow-quality-v1 must contain cases.');

  const seenIds = new Set<string>();
  const cases = dataset.cases.map((rawCase, index): WorkflowCase => {
    const item = asRecord(rawCase, `case ${index}`);
    const id = item.id;
    const split = item.split;
    const domain = item.domain;
    if (typeof id !== 'string' || id.length === 0 || seenIds.has(id)) fail(`case ${index} has a missing or duplicate id.`);
    if (split !== 'development' && split !== 'heldout') fail(`case ${id} has an invalid split.`);
    if (typeof domain !== 'string' || !domains.has(domain)) fail(`case ${id} has an invalid domain.`);
    seenIds.add(id);

    const parsedInput = decisionSchema.safeParse(item.input);
    if (!parsedInput.success) fail(`case ${id} has invalid decision input: ${parsedInput.error.message}`);
    if (parsedInput.data.domain !== domain) fail(`case ${id} domain does not match its input.`);
    decisionQuestions(parsedInput.data);

    if (!Array.isArray(item.tags) || item.tags.length === 0 || item.tags.some(tag => typeof tag !== 'string' || tag.length === 0)) fail(`case ${id} must have non-empty string tags.`);
    const label = asRecord(item.label, `label for ${id}`);
    if (!Array.isArray(label.acceptableChoices) || label.acceptableChoices.some(choice => typeof choice !== 'string')) fail(`label for ${id} has invalid acceptableChoices.`);
    const acceptableChoices = [...new Set(label.acceptableChoices as string[])];
    if (typeof label.requiredAbstention !== 'boolean') fail(`label for ${id} has no requiredAbstention boolean.`);
    if (typeof label.rationale !== 'string' || label.rationale.length < 20) fail(`label for ${id} needs a deterministic rationale.`);
    const candidateIds = new Set(parsedInput.data.candidates.map(candidate => candidate.id));
    const availableIds = new Set(parsedInput.data.candidates.filter(candidate => candidate.available).map(candidate => candidate.id));
    if (label.requiredAbstention && acceptableChoices.length !== 0) fail(`required-abstention label ${id} cannot accept a choice.`);
    if (!label.requiredAbstention && acceptableChoices.length === 0) fail(`non-abstention label ${id} needs an acceptable choice.`);
    if (acceptableChoices.some(choice => !candidateIds.has(choice) || !availableIds.has(choice))) fail(`label ${id} names a missing or unavailable candidate.`);
    return {id, split, domain: domain as WorkflowCase['domain'], tags: item.tags as string[], input: parsedInput.data, label: {acceptableChoices, requiredAbstention: label.requiredAbstention, rationale: label.rationale}};
  });

  assertNoSplitLeakage(cases);
  const required = new Set<string>(REQUIRED_TAGS);
  for (const item of cases) for (const tag of item.tags) required.delete(tag);
  if (required.size > 0) fail(`workflow-quality-v1 is missing required coverage tags: ${[...required].join(', ')}`);
  for (const split of ['development', 'heldout'] as const) {
    if (!cases.some(item => item.split === split)) fail(`workflow-quality-v1 has no ${split} cases.`);
    for (const domain of domains) if (!cases.some(item => item.split === split && item.domain === domain)) fail(`workflow-quality-v1 has no ${split} case for ${domain}.`);
  }
  return {schemaVersion: 'workflow-quality-v1', labelPolicyVersion: dataset.labelPolicyVersion as string, splitPolicy: dataset.splitPolicy as string, cases};
}

/** Reject exact case reuse across development and heldout splits. */
export function assertNoSplitLeakage(cases: WorkflowCase[]): void {
  const development = new Set(cases.filter(item => item.split === 'development').map(item => canonicalInput(item.input)));
  const duplicate = cases.find(item => item.split === 'heldout' && development.has(canonicalInput(item.input)));
  if (duplicate) fail(`heldout case ${duplicate.id} duplicates a development input.`);
}

export function scoreAssessment(item: WorkflowCase, result: Pick<Assessment, 'status' | 'choice'>): ScoredCase {
  const evaluated = result.status === 'assessed' || result.status === 'abstained';
  const predictedChoice = result.choice ?? null;
  const abstained = result.status === 'abstained' || predictedChoice === 'insufficient_evidence';
  const correct = !evaluated ? null : item.label.requiredAbstention ? abstained : result.status === 'assessed' && !abstained && predictedChoice !== null && item.label.acceptableChoices.includes(predictedChoice);
  return {evaluated, predictedChoice, abstained, correct, falseConfident: result.status === 'assessed' && correct !== true};
}

function average(values: number[]): number | null {
  return values.length === 0 ? null : Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(2));
}

export function summarizeRows(rows: EvaluationRow[], mode: 'preview' | 'live') {
  const scored = rows.filter(row => row.score.evaluated);
  const correct = scored.filter(row => row.score.correct === true).length;
  const latencies = rows.map(row => row.result.latencyMs).filter((value): value is number => typeof value === 'number');
  const inputTokens = rows.map(row => row.result.usage?.input_tokens).filter((value): value is number => typeof value === 'number');
  const outputTokens = rows.map(row => row.result.usage?.output_tokens).filter((value): value is number => typeof value === 'number');
  const transports = rows.map(row => row.result.transport).filter((value): value is NonNullable<Assessment['transport']> => value !== undefined);
  const providerRequestIds = [...new Set(transports.map(transport => transport.providerRequestId).filter((value): value is string => value !== null))];
  return {
    mode,
    totalCases: rows.length,
    scoredCases: mode === 'live' ? scored.length : 0,
    independentLabelCorrect: mode === 'live' ? correct : null,
    independentLabelAccuracy: mode === 'live' && scored.length > 0 ? Number((correct / scored.length).toFixed(4)) : null,
    falseConfidentDecisionCount: mode === 'live' ? rows.filter(row => row.score.falseConfident).length : null,
    abstentionCount: mode === 'live' ? rows.filter(row => row.score.abstained).length : null,
    unavailableCount: rows.filter(row => row.result.status === 'unavailable').length,
    skippedCount: rows.filter(row => row.result.status === 'skipped').length,
    requestEvidence: {
      attempted: transports.filter(transport => transport.fetchInvoked).length,
      responsesReceived: transports.filter(transport => transport.responseReceivedAt !== null).length,
      validatedResponses: transports.filter(transport => transport.validatedResponse).length,
      providerRequestIdCount: providerRequestIds.length,
      providerRequestIds,
    },
    latencyEstimateMs: {count: latencies.length, total: latencies.reduce((sum, value) => sum + value, 0), mean: average(latencies)},
    tokenEstimates: {count: Math.min(inputTokens.length, outputTokens.length), input: inputTokens.reduce((sum, value) => sum + value, 0), output: outputTokens.reduce((sum, value) => sum + value, 0), note: 'Provider usage fields are retained estimates for this run, not billing.'},
  };
}

/** Reserve a fresh output directory before constructing a live service. */
export async function prepareOutputDirectory(requestedPath: string): Promise<string> {
  const output = resolve(requestedPath);
  await mkdir(dirname(output), {recursive: true});
  try {
    await mkdir(output, {recursive: false, mode: 0o700});
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') fail(`Results already exist at ${output}; choose a new output directory.`);
    throw error;
  }
  return output;
}

function parseArgs(args: string[]): {live: boolean; output: string | undefined; split: WorkflowCase['split'] | undefined; fixture: string | undefined} {
  let live = false;
  let output: string | undefined;
  let split: WorkflowCase['split'] | undefined;
  let fixture: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--live') live = true;
    else if (arg === '--out') output = args[++index];
    else if (arg === '--fixture') fixture = args[++index];
    else if (arg === '--split') {
      const value = args[++index];
      if (value !== 'development' && value !== 'heldout') fail('--split must be development or heldout.');
      split = value;
    } else fail(`Unknown argument ${arg}. Use --fixture /absolute/fixture.json --out /absolute/results --live --split development|heldout.`);
  }
  if (fixture !== undefined && !isAbsolute(fixture)) fail('--fixture requires an absolute JSON fixture path.');
  if (output !== undefined && !isAbsolute(output)) fail('--out requires a new absolute results directory.');
  if (live && process.env.JEV_RUN_LIVE_EVAL !== '1') fail('--live requires JEV_RUN_LIVE_EVAL=1; no provider request was made.');
  if (live && !process.env.TYPESAFE_API_KEY && !process.env.JEV_API_KEY_FILE) fail('--live requires TYPESAFE_API_KEY or JEV_API_KEY_FILE; no provider request was made.');
  if (live && output === undefined) fail('--live requires --out /absolute/results-directory so receipts and reports are isolated.');
  return {live, output, split, fixture};
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const fixtureText = await readFile(options.fixture === undefined ? fixtureUrl : pathToFileURL(resolve(options.fixture)), 'utf8');
  const dataset = loadDataset(JSON.parse(fixtureText));
  const cases = options.split ? dataset.cases.filter(item => item.split === options.split) : dataset.cases;
  const output = options.output === undefined ? undefined : await prepareOutputDirectory(options.output);
  const service = createService(options.live ? {store: new FileStore(join(output!, 'live-receipts'))} : {fetchFn: async () => { throw new Error('preview must not invoke fetch'); }});
  const rows: EvaluationRow[] = [];
  for (const item of cases) {
    const result = await service.classifyDecision({...item.input, mode: options.live ? 'evaluate' : 'preview'});
    const score = scoreAssessment(item, result);
    const row: EvaluationRow = {id: item.id, split: item.split, domain: item.domain, tags: item.tags, expected: item.label, result, score};
    rows.push(row);
    process.stdout.write(`${JSON.stringify({type: 'case', id: item.id, mode: options.live ? 'live' : 'preview', status: result.status, choice: result.choice ?? null})}\n`);
  }
  const mode = options.live ? 'live' : 'preview';
  const summary = {
    schemaVersion: 'workflow-quality-evaluation-v1',
    fixtureHash: createHash('sha256').update(fixtureText).digest('hex'),
    labelPolicyVersion: dataset.labelPolicyVersion,
    rubricVersion: DECISION_RUBRIC_VERSION,
    model: MODEL,
    split: options.split ?? 'all',
    splitFrozenBeforeProviderResults: true,
    ...summarizeRows(rows, mode),
    note: 'Accuracy is computed only against the independently labelled fixture cases. Latency and token values are run estimates, not billing or general model performance claims.',
  };
  process.stdout.write(`${JSON.stringify({type: 'summary', ...summary})}\n`);
  if (output !== undefined) {
    const resultsPath = join(output, 'workflow-quality-evaluation.json');
    const summaryPath = join(output, 'workflow-quality-summary.json');
    await writeFile(resultsPath, JSON.stringify({fixtureHash: summary.fixtureHash, labelPolicyVersion: dataset.labelPolicyVersion, mode, rows}, null, 2) + '\n', {flag: 'wx', mode: 0o600});
    await writeFile(summaryPath, JSON.stringify(summary, null, 2) + '\n', {flag: 'wx', mode: 0o600});
  }
}

if (process.argv[1] && fileURLToPath(pathToFileURL(process.argv[1])) === fileURLToPath(import.meta.url)) await main();
