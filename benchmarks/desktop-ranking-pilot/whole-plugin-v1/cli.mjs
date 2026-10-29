import {mkdir, readFile, readdir, writeFile} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {freezeStudy, hash, reduceEvent, deadlines} from './controller.mjs';
import {summarizeStudy, exportCsv} from './report.mjs';

const json = async path => JSON.parse(await readFile(path, 'utf8'));
const put = async (path, value) => { await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, {flag: 'wx'}); if (hash(await json(path)) !== hash(value)) throw new Error('Artifact readback mismatch'); };
export async function readStudy(directory) {
  let state = await json(join(directory, 'frozen.json'));
  if (hash(freezeStudy(state.manifest)) !== hash(state)) throw new Error('Frozen whole-plugin state changed');
  const paths = (await readdir(join(directory, 'events'))).sort();
  for (const [index, path] of paths.entries()) {
    if (path !== `${String(index + 1).padStart(4, '0')}.json`) throw new Error('Event gap or unknown file');
    state = reduceEvent(state, await json(join(directory, 'events', path)));
  }
  return state;
}
export async function main(args) {
  const [command, ...paths] = args;
  if (command === 'template' && paths.length === 2) {
    const config = await json(paths[0]);
    const corpus = await json(new URL('../corpus-2026-10-28.json', import.meta.url));
    const reservations = await json(new URL('../reservations-2026-10-28.json', import.meta.url));
    const preflights = await json(new URL('../preparation-2026-10-28-attempt-5/qualified-preflights-2026-10-28.json', import.meta.url));
    const tasks = corpus.tasks.map(task => {
      const control = preflights.find(row => row.taskId === task.id);
      const supplied = config.tasks?.find(row => row.id === task.id) ?? {};
      return {id: task.id, repository: task.repository, taskType: task.taskType, baseRevision: task.baseRevision,
        referencePatchHash: task.referencePatchHash, graderHash: control.graderHash, inputHash: supplied.inputHash ?? task.problemStatementHash,
        publicFailureHash: supplied.publicFailureHash ?? control.controls.broken.evidenceHash, cheapPacketHash: supplied.cheapPacketHash ?? null};
    });
    const manifest = {schemaVersion: 'whole-plugin-pilot-v1', studyId: config.studyId, privacy: 'private', host: config.host, arms: config.arms,
      policy: {codingMs: 2100000, gradingMs: 600000, totalMs: 2700000, attempts: 18, interimAfter: 3,
        retrieval: {method: 'bm25', k1: 1.2, b: 0.75, maxBytes: 16384, maxCandidates: 254, source: 'frozen-broken-base', tieBreak: 'stable-id'}},
      corpus, reservations, preflights, preflightHash: hash(preflights), tasks};
    freezeStudy(manifest); await put(resolve(paths[1]), manifest); return {manifest: resolve(paths[1]), manifestHash: hash(manifest)};
  }
  if (command === 'freeze' && paths.length === 2) {
    const state = freezeStudy(await json(paths[0])); const directory = resolve(paths[1]);
    await mkdir(join(directory, 'events'), {recursive: true}); await put(join(directory, 'frozen.json'), state);
    return {manifestHash: state.manifestHash, slots: state.slots.map(slot => ({id: slot.id, status: slot.status}))};
  }
  if (command === 'record' && paths.length === 2) {
    const directory = resolve(paths[0]); const before = await readStudy(directory); const event = await json(paths[1]); const after = reduceEvent(before, event);
    await put(join(directory, 'events', `${String(after.events.length).padStart(4, '0')}.json`), event);
    const observed = await readStudy(directory); if (hash(observed) !== hash(after)) throw new Error('Concurrent event or readback mismatch');
    return {events: observed.events.length, halted: observed.halted, deadlines: deadlines(observed)};
  }
  if (command === 'status' && paths.length === 1) { const state = await readStudy(paths[0]); return {manifestHash: state.manifestHash, halted: state.halted, interim: state.interim, deadlines: deadlines(state), slots: state.slots}; }
  if (command === 'export' && [2, 3].includes(paths.length)) {
    const state = await readStudy(paths[0]); const report = summarizeStudy(state, paths[2] ?? state.lastAt);
    const directory = resolve(paths[1]); await mkdir(directory, {recursive: true});
    await put(join(directory, 'report.json'), report);
    const files = exportCsv(report); const artifacts = {'report.json': hash(report)};
    for (const [name, content] of Object.entries(files)) { await writeFile(join(directory, name), content, {flag: 'wx'}); artifacts[name] = hash(content); }
    return {directory, reportHash: hash(report), artifactsHash: hash(artifacts), artifacts};
  }
  throw new Error('Use template config.json manifest.json; freeze manifest.json private-run-dir; record private-run-dir event.json; status private-run-dir; export private-run-dir new-output-dir [as-of-ISO]');
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) main(process.argv.slice(2))
  .then(result => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)).catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
