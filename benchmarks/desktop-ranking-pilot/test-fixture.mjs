import {CODING_MS, TOTAL_MS, freezeStudy, hash, reduceEvent} from './pilot.mjs';

export const evidence = hash('synthetic-evidence-only');
const verified = () => ({status: 'verified', evidence: ['synthetic-fixture-only']});
export const at = milliseconds => new Date(Date.parse('2026-10-28T00:00:00Z') + milliseconds).toISOString();

export function fixture() {
  const qualification = {schemaVersion: 'desktop-qualification-v1', host: {kind: 'codex-desktop', version: 'synthetic', build: 'synthetic', runtimeIdentity: verified()},
    baselineIsolation: Object.fromEntries(['tools', 'hooks', 'instructions', 'candidatePacket', 'transport'].map(key => [key, verified()]))};
  const tasks = Array.from({length: 6}, (_, index) => ({id: `synthetic-bug-${index}`, repository: `synthetic/repo-${index % 2}`,
    taskType: index % 2 ? 'serialization' : 'parsing', baseRevision: String(index + 2).repeat(40), publicFailureObserved: true,
    ...Object.fromEntries(['publicFailureHash', 'inputHash', 'candidateCorpusHash', 'graderHash'].map(key => [key, evidence])), referencePatchHash: hash(`synthetic-repair-${index}`),
    packet: {contentHash: evidence, cheapOrder: ['first', 'second', 'third'], bytes: 100, providerOptionLimit: 4, inventoryCount: 4, omittedCount: 1, inventoryDigest: evidence},
  }));
  const preflights = tasks.map(task => ({taskId: task.id, baseRevision: task.baseRevision, graderHash: task.graderHash,
    referencePatchHash: task.referencePatchHash, controls: Object.fromEntries(['broken', 'reference', 'missing', 'wrong'].map(control => [control,
      {verdict: control === 'reference' ? 'pass' : 'fail', healthy: true, evidenceHash: evidence, durationMs: 50}]))}));
  const manifest = {schemaVersion: 'desktop-ranking-pilot-v1', studyId: 'SYNTHETIC-TEST-NOT-A-BENCHMARK', privacy: 'private',
    runtime: {host: 'codex-desktop', appVersion: 'synthetic', appBuild: 'synthetic', codingModel: 'synthetic-model', codingModelVersion: 'synthetic-model-pinned',
      effort: 'high', jevDecisionModelVersion: 'synthetic-choice-pinned', permissionsHash: evidence, pluginPackageHash: evidence, jevPromptHash: evidence,
      unrelatedConsultations: false, callableJevTools: false, automaticHooks: false},
    policy: {codingMs: CODING_MS, totalMs: TOTAL_MS, packetMaxBytes: 16384, k1: 1.2, b: 0.75},
    qualificationHash: hash(qualification), preflightHash: hash(preflights), reservations: {tasks: [{id: 'synthetic-old-reserved', repository: 'synthetic/old', baseRevision: '1'.repeat(40), issues: []}], sourceHash: evidence},
    corpus: {schemaVersion: 'desktop-pilot-corpus-v1', source: {revision: '1'.repeat(40), artifactHash: evidence}, tasks: tasks.map((task, index) => ({
      id: task.id, repository: task.repository, baseRevision: task.baseRevision, taskType: task.taskType, referencePatchHash: task.referencePatchHash,
      classification: {kind: 'bug', reviewed: true, evidence: 'Synthetic bug only'}, issues: [`https://github.com/${task.repository}/issues/${index}`],
      problemStatementHash: evidence, testPatchHash: evidence,
    }))}, tasks};
  return {manifest, qualification, preflights};
}
export const freeze = input => freezeStudy(input.manifest, input.qualification, input.preflights);
export function event(state, type, elapsedMs, fields = {}) {
  return {id: `synthetic-event-${state.events.length}`, manifestHash: state.manifestHash, type,
    slotId: state.slots.find(slot => slot.status === 'CODING' || slot.status === 'GRADING')?.id ?? state.slots.find(slot => slot.status === 'NOTSTARTED')?.id,
    at: at(elapsedMs), ...fields};
}
export function finish(state, startMs, verdict = 'verified-fix') {
  state = reduceEvent(state, event(state, 'identity', startMs + 50, {identityHash: hash(state.manifest.runtime), evidenceHash: evidence}));
  state = reduceEvent(state, event(state, 'coding_ended', startMs + 100, {patchHash: evidence, reason: 'completed', evidenceHash: evidence}));
  return reduceEvent(state, event(state, 'graded', startMs + 150, {patchHash: evidence, verdict, healthy: true, graderHash: evidence, evidenceHash: evidence}));
}
