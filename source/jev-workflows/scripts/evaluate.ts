import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { createService } from '../src/service.js';
import { FileStore } from '../src/store.js';
import { failureQuestions, ruleBaseline, RUBRIC_VERSION, MODEL, type FailureInput, type Category } from '../src/contracts.js';

// Explicit, paid-network evaluation script. Unit tests never invoke this script.
if (process.env.JEV_RUN_LIVE_EVAL !== '1') throw new Error('Set JEV_RUN_LIVE_EVAL=1 to authorize the synthetic live evaluation.');
if (!process.env.TYPESAFE_API_KEY) throw new Error('TYPESAFE_API_KEY is required; never put it in a command argument.');
const fixtureText = await readFile(new URL('../fixtures/failures.json', import.meta.url), 'utf8');
const fixtures = JSON.parse(fixtureText) as {id: string; split: string; expectedCategory: Category; input: FailureInput}[];
const directory = resolve(process.argv[2] ?? '../jev-verification');
await mkdir(directory, {recursive: true});
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const freeze = {createdAt: new Date().toISOString(), fixtureHash: hash(fixtureText), rubricHash: hash(JSON.stringify(failureQuestions)), rubricVersion: RUBRIC_VERSION, model: MODEL, fixtureCount: fixtures.length};
await writeFile(join(directory, 'evaluation-freeze.json'), JSON.stringify(freeze, null, 2) + '\n', {flag: 'wx'});
const service = createService({store: new FileStore(join(directory, 'live-receipts'))});
const results: Record<string, unknown>[] = [];
for (const fixture of fixtures) {
  const result = await service.classifyFailure({...fixture.input, mode: 'evaluate'});
  const baseline = ruleBaseline(fixture.input);
  const row = {id: fixture.id, split: fixture.split, expected: fixture.expectedCategory, baseline,
    baselineCorrect: baseline === fixture.expectedCategory,
    selectedCategoryCorrect: result.category === fixture.expectedCategory,
    acceptedCorrect: result.status === 'assessed' && result.category === fixture.expectedCategory,
    result};
  results.push(row);
  await writeFile(join(directory, 'failure-evaluation.json'), JSON.stringify({freeze, results}, null, 2) + '\n');
  process.stdout.write(`${fixture.id}: ${result.status} ${result.category ?? result.reasonCode}\n`);
}
const summaries = ['development', 'heldout'].map(split => {
  const rows = results.filter(r => r.split === split);
  return {split, total: rows.length, baselineCorrect: rows.filter(r => r.baselineCorrect).length,
    selectedCategoryCorrect: rows.filter(r => r.selectedCategoryCorrect).length,
    acceptedCorrect: rows.filter(r => r.acceptedCorrect).length,
    abstained: rows.filter(r => (r.result as {status: string}).status === 'abstained').length,
    unavailable: rows.filter(r => (r.result as {status: string}).status === 'unavailable').length};
});
await writeFile(join(directory, 'failure-summary.json'), JSON.stringify({freeze, summaries}, null, 2) + '\n');
process.stdout.write(JSON.stringify(summaries, null, 2) + '\n');
