import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir, mkdtemp, readFile, rm, rmdir, writeFile} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {main, readStudy} from './cli.mjs';
import {evidence, event, fixture} from './test-fixture.mjs';

const repository = join(dirname(fileURLToPath(import.meta.url)), '../..');
const json = async (path, value) => writeFile(path, JSON.stringify(value));

test('offline CLI freezes, appends with readback, resumes, and reports a private synthetic run', async () => {
  const parent = join(repository, '.agent-work/desktop-pilot-cli-tests');
  await mkdir(parent, {recursive: true});
  const directory = await mkdtemp(join(parent, 'synthetic-'));
  try {
    const input = fixture();
    const paths = ['manifest', 'qualification', 'preflights'].map(name => join(directory, `${name}.json`));
    await Promise.all(paths.map((path, index) => json(path, [input.manifest, input.qualification, input.preflights][index])));
    const run = join(directory, 'private-run');
    const frozen = await main(['freeze', ...paths, run]);
    assert.equal(frozen.slots, 18);
    await assert.rejects(main(['freeze', ...paths, run]), {code: 'EEXIST'});
    const startPath = join(directory, 'event.json');
    const state = await readStudy(run);
    await json(startPath, event(state, 'start', 0));
    const result = await main(['record', run, startPath]);
    assert.equal(result.events, 1);
    assert.equal(result.deadlines.codingStopsAt, '2026-10-28T00:35:00.000Z');
    await assert.rejects(main(['record', run, startPath]), /unique/);
    const resumed = await readStudy(run);
    assert.equal(resumed.slots[0].status, 'CODING');
    const observed = await main(['report', run]);
    assert.equal(observed.scoring, 'partial');
    const report = JSON.parse(await readFile(observed.report, 'utf8'));
    assert.equal(report.byArm['model-alone'].billedUsd, null);
    assert.equal((await readFile(observed.chart, 'utf8')).includes('<svg'), true);
    await json(join(run, 'events/0003.json'), {...event(resumed, 'approval', 1), evidenceHash: evidence});
    await assert.rejects(readStudy(run), /sequence/);
  } finally {
    await rm(directory, {recursive: true, force: true});
    await rmdir(parent);
  }
});
