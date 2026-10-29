import {checkCorpus} from './corpus.mjs';
import {hash, plannedSlots, validateGraderPreflights} from './pilot.mjs';

export function prepareDispositions({catalog, reservations, qualification, preflights, graderHash}) {
  const corpus = checkCorpus(catalog, reservations);
  validateGraderPreflights(catalog.tasks.map(task => ({...task, graderHash})), preflights);
  const dependencies = ['freeze-native-profile-permissions-package-input-and-evidence-packets'];
  const verified = check => check?.status === 'verified' && check.evidence?.length > 0;
  if (!verified(qualification.host?.runtimeIdentity)) dependencies.push('supported-desktop-owned-runtime-identity');
  for (const name of ['tools', 'hooks', 'instructions', 'candidatePacket', 'transport']) {
    if (!verified(qualification.baselineIsolation?.[name])) dependencies.push(`native-baseline-isolation.${name}`);
  }
  return {schemaVersion: 'desktop-pilot-preparation-v1', corpusHash: corpus.corpusHash, reservationsHash: corpus.reservationsHash,
    qualificationHash: hash(qualification), preflightHash: hash(preflights), graderHash,
    manifestFrozen: false, codingAttempts: 0, codingOutcomes: null, codingReward: null,
    graderControlCount: 24, graderControlsQualified: true, dependencies,
    slots: plannedSlots(catalog.tasks).map(slot => ({id: slot.id, taskId: slot.taskId, arm: slot.arm, position: slot.position,
      status: 'NOTSTARTED', disposition: 'Native qualification and frozen execution identity required; no coding attempt occurred.'})),
    publicFailures: preflights.map(row => ({taskId: row.taskId, baseRevision: row.baseRevision, graderHash: row.graderHash,
      trigger: `Run the inspected grade.py for ${row.taskId} on its broken base`, expected: 'healthy behavioral failure',
      observed: row.controls.broken, source: 'Non-model broken-base preflight; no reference repair applied.'})),
    nextAction: 'Root must prove task-scoped native baseline isolation and owning-runtime identity, then freeze exact profile, package, input and packets. If unsupported, return these eighteen NOTSTARTED dispositions for human review.'};
}

export function renderPreparationSvg(preparation, preflights) {
  const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
  const controls = ['broken', 'reference', 'missing', 'wrong'];
  const headings = controls.map((name, index) => `<text x="${330 + index * 105}" y="90">${name}</text>`).join('');
  const rows = preflights.map((row, index) => `<text x="20" y="${130 + index * 40}">${escape(row.taskId)}</text>${controls.map((control, column) => {
    const result = row.controls[control];
    return `<text x="${330 + column * 105}" y="${130 + index * 40}" fill="${result.healthy ? '#176b35' : '#a51d2d'}">${escape(result.verdict)}</text>`;
  }).join('')}`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="460" viewBox="0 0 800 460"><rect width="800" height="460" fill="white"/><g font-family="sans-serif" font-size="14" fill="#222"><text x="20" y="30" font-size="20">Observed new-task grader controls</text><text x="20" y="55">Healthy expected results: broken fail; reference pass; missing fail; wrong fail.</text>${headings}${rows}<text x="20" y="395">${preparation.slots.length} coding slots remain NOTSTARTED. No coding reward or fix rate was measured.</text><text x="20" y="425">Native baseline isolation and owning-runtime identity remain unproved.</text></g></svg>\n`;
}
