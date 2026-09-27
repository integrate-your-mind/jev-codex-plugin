#!/usr/bin/env node
import {createHash} from 'node:crypto';
import {readFile, writeFile} from 'node:fs/promises';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const dir = dirname(fileURLToPath(import.meta.url));
const args = new Set(process.argv.slice(2));
const write = args.has('--write');
const episodes = JSON.parse(await readFile(join(dir, 'episodes.json'), 'utf8'));
const oracle = JSON.parse(await readFile(join(dir, 'oracle.json'), 'utf8'));
const legalEvents = new Set(['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop']);
const families = new Map();
const seen = new Set();
const oracleById = new Map(oracle.episodes.map(entry => [entry.episodeId, entry]));
const hash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const safeId = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;

if (oracle.schemaVersion !== 'plugin-live-eval-oracle-v2' || oracle.episodeCount !== 18 || oracle.episodes.length !== 18) throw new Error('oracle must contain exactly 18 v2 episodes');
if (episodes.length !== 18) throw new Error('expected exactly 18 authored episodes');
for (const episode of episodes) {
  if (!episode.id || seen.has(episode.id)) throw new Error(`duplicate or missing episode id: ${episode.id}`);
  seen.add(episode.id);
  if (!oracleById.has(episode.id)) throw new Error(`${episode.id}: missing independent oracle row`);
  families.set(episode.family, (families.get(episode.family) ?? 0) + 1);
  if (!legalEvents.has(episode.event)) throw new Error(`${episode.id}: unsupported event ${episode.event}`);
  if (!/^Q\d+$/.test(episode.questionId ?? '') || !Array.isArray(episode.questionIds) || episode.questionIds.length < 1 || episode.questionIds.some(id => !/^Q\d+$/.test(id))) throw new Error(`${episode.id}: missing research question mapping`);
  if (typeof episode.question !== 'string' || episode.question.length < 20) throw new Error(`${episode.id}: question missing`);
  if (!episode.taskContext || typeof episode.taskContext !== 'object') throw new Error(`${episode.id}: taskContext missing`);
  for (const field of ['rootObjective', 'latestStep']) if (typeof episode.taskContext[field] !== 'string' || !episode.taskContext[field]) throw new Error(`${episode.id}: taskContext.${field} missing`);
  for (const field of ['constraints', 'criteria', 'corrections', 'evidenceRefs']) if (!Array.isArray(episode.taskContext[field]) || episode.taskContext[field].length < 1) throw new Error(`${episode.id}: taskContext.${field} missing`);
  if (!Array.isArray(episode.availableCandidates) || episode.availableCandidates.length < 2 || episode.availableCandidates.length > 12) throw new Error(`${episode.id}: concrete candidates required`);
  const candidateIds = new Set();
  for (const candidate of episode.availableCandidates) {
    if (!candidate || !safeId.test(candidate.id) || candidateIds.has(candidate.id) || candidate.id === 'insufficient_evidence') throw new Error(`${episode.id}: invalid or duplicate candidate id`);
    if (typeof candidate.description !== 'string' || candidate.description.length < 12 || /^candidate /i.test(candidate.description)) throw new Error(`${episode.id}: candidate descriptions must be concrete`);
    candidateIds.add(candidate.id);
  }
  if (episode.taskContext.candidateCatalog?.tool?.length !== episode.availableCandidates.length) throw new Error(`${episode.id}: taskContext candidate catalog does not match available candidates`);
  if ('expectedChoice' in episode) throw new Error(`${episode.id}: truth must remain in oracle.json`);
  const oracleRow = oracleById.get(episode.id);
  if (!['assessed', 'abstained'].includes(oracleRow.expectedDisposition)) throw new Error(`${episode.id}: invalid oracle disposition`);
  if (oracleRow.expectedDisposition === 'abstained') {
    if (oracleRow.expectedChoice !== null) throw new Error(`${episode.id}: abstention oracle must use null expectedChoice`);
  } else if (!candidateIds.has(oracleRow.expectedChoice)) throw new Error(`${episode.id}: invalid oracle choice`);
}
for (const family of oracle.families) if (families.get(family) !== 3) throw new Error(`${family}: expected exactly 3 episodes`);
for (const row of oracle.episodes) if (!seen.has(row.episodeId)) throw new Error(`oracle contains unexpected episode ${row.episodeId}`);

const providerInputs = episodes.map(({id, family, questionId, event, question, taskContext, availableCandidates, ...eventFields}) => ({
  id, family, questionId, event, question,
  task_context: {...taskContext, candidateCatalog: taskContext.candidateCatalog},
  available_candidates: availableCandidates,
  ...eventFields,
}));
const freeze = {
  schemaVersion: 'plugin-live-eval-freeze-v2',
  episodeCount: episodes.length,
  familyCounts: Object.fromEntries([...families].sort()),
  repeats: 2,
  plannedAttempts: episodes.length * 2 * 2,
  fixtureSha256: hash(episodes),
  oracleSha256: hash(oracle),
  providerInputsSha256: hash(providerInputs),
  createdAt: new Date().toISOString(),
  truthBoundary: 'Oracle labels are loaded for validation/scoring only and never included in task_context, event payload, service input, or provider transport.',
};
if (write) {
  await writeFile(join(dir, 'provider-inputs.json'), JSON.stringify(providerInputs, null, 2) + '\n');
  await writeFile(join(dir, 'freeze.json'), JSON.stringify(freeze, null, 2) + '\n');
}
console.log(JSON.stringify({ok: true, write, ...freeze}));
