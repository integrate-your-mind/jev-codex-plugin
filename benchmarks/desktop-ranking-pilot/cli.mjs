import {mkdir, readFile, readdir, writeFile} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {acquirePinnedCatalog, checkCorpus} from './corpus.mjs';
import {freezeStudy, hash, reduceEvent, renderObservedSvg, summarizeStudy} from './pilot.mjs';
import {prepareDispositions, renderPreparationSvg} from './preparation.mjs';

const json = async path => JSON.parse(await readFile(path, 'utf8'));
const put = async (path, value) => {
  const body = `${JSON.stringify(value, null, 2)}\n`;
  await writeFile(path, body, {flag: 'wx'});
  if (hash(await json(path)) !== hash(value)) throw new Error('Written artifact failed readback');
};

export async function readStudy(directory) {
  let state = await json(join(directory, 'frozen.json'));
  const original = freezeStudy(state.manifest, state.qualification, state.preflights);
  if (hash(original) !== hash(state)) throw new Error('Frozen run was modified');
  const paths = (await readdir(join(directory, 'events'))).sort();
  for (const [index, path] of paths.entries()) {
    if (path !== `${String(index + 1).padStart(4, '0')}.json`) throw new Error('Event sequence has a gap or unknown file');
    state = reduceEvent(state, await json(join(directory, 'events', path)));
  }
  return state;
}

export async function main(args) {
  const [command, ...paths] = args;
  if (command === 'prepare' && paths.length === 6) {
    const catalog = await json(paths[0]);
    const preflights = await Promise.all(catalog.tasks.map(task => json(join(paths[3], `${task.id}.json`))));
    const graderHash = createHash('sha256').update(await readFile(paths[4])).digest('hex');
    const preparation = prepareDispositions({catalog, reservations: await json(paths[1]), qualification: await json(paths[2]), preflights, graderHash});
    const directory = resolve(paths[5]);
    await mkdir(directory, {recursive: true});
    await put(join(directory, 'notstarted-2026-10-28.json'), preparation);
    await put(join(directory, 'qualified-preflights-2026-10-28.json'), preflights);
    await writeFile(join(directory, 'grader-controls-2026-10-28.svg'), renderPreparationSvg(preparation, preflights), {flag: 'wx'});
    return {slots: preparation.slots.length, codingAttempts: 0, graderControlsQualified: true, dependencies: preparation.dependencies};
  }
  if (command === 'check-corpus' && paths.length === 2) return checkCorpus(await json(paths[0]), await json(paths[1]));
  if (command === 'acquire' && paths.length === 2) return acquirePinnedCatalog({...await json(paths[0]), destination: resolve(paths[1])});
  if (command === 'freeze' && paths.length === 4) {
    const state = freezeStudy(await json(paths[0]), await json(paths[1]), await json(paths[2]));
    const directory = resolve(paths[3]);
    await mkdir(directory, {recursive: true});
    await mkdir(join(directory, 'events'), {recursive: true});
    await put(join(directory, 'frozen.json'), state);
    return {manifestHash: state.manifestHash, slots: state.slots.length, attempted: 0};
  }
  if (command === 'record' && paths.length === 2) {
    const directory = resolve(paths[0]);
    const state = await readStudy(directory);
    const event = await json(paths[1]);
    const updated = reduceEvent(state, event);
    await put(join(directory, 'events', `${String(updated.events.length).padStart(4, '0')}.json`), event);
    const readback = await readStudy(directory);
    if (hash(updated) !== hash(readback)) throw new Error('Concurrent event or event readback mismatch');
    return {events: readback.events.length, halted: readback.halted, deadlines: activeDeadlines(readback)};
  }
  if ((command === 'status' || command === 'report') && paths.length === 1) {
    const directory = resolve(paths[0]);
    const state = await readStudy(directory);
    const report = summarizeStudy(state);
    if (command === 'report') {
      const prefix = join(directory, `report-${String(state.events.length).padStart(4, '0')}`);
      await put(`${prefix}.json`, report);
      await writeFile(`${prefix}.svg`, renderObservedSvg(report), {flag: 'wx'});
      return {report: `${prefix}.json`, chart: `${prefix}.svg`, scoring: report.scoring};
    }
    return {...report, deadlines: activeDeadlines(state)};
  }
  throw new Error('Use prepare catalog reservations qualification preflight-directory grader output-directory; check-corpus catalog reservations; acquire pinned-spec destination; freeze manifest qualification preflights private-run-dir; record private-run-dir event; status private-run-dir; report private-run-dir');
}

export function activeDeadlines(state) {
  const slot = state.slots.find(row => row.status === 'CODING' || row.status === 'GRADING');
  if (!slot) return null;
  const started = Date.parse(slot.startedAt);
  return {slotId: slot.id, codingStopsAt: new Date(started + state.manifest.policy.codingMs).toISOString(),
    gradingStopsAt: new Date(started + state.manifest.policy.totalMs).toISOString(),
    enforcement: 'The native execution owner must stop coding and grading by these deadlines. The reducer invalidates late observations.'};
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main(process.argv.slice(2)).then(result => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`))
    .catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
