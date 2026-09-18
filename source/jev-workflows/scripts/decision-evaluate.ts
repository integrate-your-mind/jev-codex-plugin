import { createHash } from 'node:crypto';
import { readFile, mkdir, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { createService } from '../src/service.js';
import { FileStore } from '../src/store.js';
import { decisionSchema, DECISION_RUBRIC_VERSION, decisionQuestions, type DecisionInput } from '../src/decision.js';
import { MODEL } from '../src/contracts.js';

type Fixture = {
  id: string;
  input: DecisionInput;
  expectedChoice: string;
};

type Assessment = {
  status?: string;
  choice?: string;
  reasonCode?: string;
  [key: string]: unknown;
};

const hash = (text: string): string => createHash('sha256').update(text).digest('hex');
const fixtureUrl = new URL('../fixtures/decisions.json', import.meta.url);

function fail(message: string): never {
  throw new Error(message);
}

async function mustNotExist(path: string): Promise<void> {
  try {
    await stat(path);
    fail(`Results already exist at ${path}; choose a new target directory.`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

function loadFixtures(text: string): Fixture[] {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    fail('fixtures/decisions.json is not valid JSON.');
  }
  if (!Array.isArray(raw) || raw.length === 0) fail('fixtures/decisions.json must contain at least one case.');
  const seen = new Set<string>();
  return raw.map((candidate, index): Fixture => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      fail(`Decision fixture ${index} is not an object.`);
    }
    const item = candidate as Record<string, unknown>;
    if (typeof item.id !== 'string' || item.id.length === 0 || seen.has(item.id)) {
      fail(`Decision fixture ${index} has a missing or duplicate id.`);
    }
    seen.add(item.id);
    const parsed = decisionSchema.safeParse(item.input);
    if (!parsed.success) fail(`Decision fixture ${item.id} has invalid input.`);
    if (typeof item.expectedChoice !== 'string') fail(`Decision fixture ${item.id} has no expectedChoice.`);
    const expected = item.expectedChoice;
    const candidateIds = new Set(parsed.data.candidates.map(candidateItem => candidateItem.id));
    if (expected !== 'insufficient_evidence' && !candidateIds.has(expected)) {
      fail(`Decision fixture ${item.id} expects an unlisted candidate.`);
    }
    // Constructing the question set validates that the frozen fixture can form
    // the same bounded taxonomy that the service will send to the provider.
    decisionQuestions(parsed.data);
    return {id: item.id, input: parsed.data, expectedChoice: expected};
  });
}

if (process.env.JEV_RUN_LIVE_EVAL !== '1') {
  fail('Set JEV_RUN_LIVE_EVAL=1 to authorize the synthetic decision evaluation.');
}
if (!process.env.TYPESAFE_API_KEY) {
  fail('TYPESAFE_API_KEY is required for explicit evaluation; it is never printed.');
}

const targetArg = process.argv[2];
if (!targetArg || !isAbsolute(targetArg)) {
  fail('Provide a new absolute results directory: npm run eval:decision -- /absolute/results-directory');
}
const targetDirectory = resolve(targetArg);
await mkdir(targetDirectory, {recursive: true});

const resultsPath = join(targetDirectory, 'decision-evaluation.json');
const summaryPath = join(targetDirectory, 'decision-summary.json');
const freezePath = join(targetDirectory, 'evaluation-freeze.json');
await mustNotExist(resultsPath);
await mustNotExist(summaryPath);
await mustNotExist(freezePath);

const fixtureText = await readFile(fixtureUrl, 'utf8');
const fixtures = loadFixtures(fixtureText);
const expected = fixtures.map(fixture => ({id: fixture.id, expectedChoice: fixture.expectedChoice}));
const freeze = {
  schemaVersion: 'decision-evaluation-v1',
  createdAt: new Date().toISOString(),
  fixtureHash: hash(fixtureText),
  rubricVersion: DECISION_RUBRIC_VERSION,
  rubricHash: hash(JSON.stringify(fixtures.map(fixture => decisionQuestions(decisionSchema.parse(fixture.input))))),
  model: MODEL,
  fixtureCount: fixtures.length,
  expected,
};
await writeFile(freezePath, JSON.stringify(freeze, null, 2) + '\n', {flag: 'wx', mode: 0o600});

const service = createService({store: new FileStore(join(targetDirectory, 'live-receipts'))});
const rows: Array<Record<string, unknown>> = [];
for (const fixture of fixtures) {
  const preview = await service.classifyDecision({...fixture.input, mode: 'preview'});
  process.stdout.write(`${JSON.stringify({type: 'preview', id: fixture.id, assessment: preview})}\n`);

  const result = await service.classifyDecision({...fixture.input, mode: 'evaluate'});
  const assessment = result as Assessment;
  const correct = assessment.choice === fixture.expectedChoice;
  const accepted = assessment.status === 'assessed' && correct;
  const row = {
    id: fixture.id,
    domain: fixture.input.domain,
    expectedChoice: fixture.expectedChoice,
    correct,
    accepted,
    abstained: assessment.status === 'abstained',
    preview,
    result,
  };
  rows.push(row);
  process.stdout.write(`${JSON.stringify({type: 'result', ...row})}\n`);
}

const aggregate = {
  total: rows.length,
  correct: rows.filter(row => row.correct).length,
  accepted: rows.filter(row => row.accepted).length,
  abstentions: rows.filter(row => row.abstained).length,
  unavailable: rows.filter(row => (row.result as Assessment).status === 'unavailable').length,
};
const summary = {
  freeze,
  aggregate,
  note: 'These are synthetic decision fixtures for contract and integration evaluation; they are not real-model benchmarks or evidence of general model performance.',
};
await writeFile(resultsPath, JSON.stringify({freeze, rows}, null, 2) + '\n', {flag: 'wx', mode: 0o600});
await writeFile(summaryPath, JSON.stringify(summary, null, 2) + '\n', {flag: 'wx', mode: 0o600});
process.stdout.write(`${JSON.stringify({type: 'aggregate', ...aggregate})}\n`);
