import {hash} from './identity.mjs';
import {checkCorpus} from './corpus.mjs';
export {hash} from './identity.mjs';

export const ARMS = Object.freeze(['model-alone', 'cheap', 'jev-first']);
export const ORDERS = Object.freeze([
  ['model-alone', 'cheap', 'jev-first'], ['model-alone', 'jev-first', 'cheap'],
  ['cheap', 'model-alone', 'jev-first'], ['cheap', 'jev-first', 'model-alone'],
  ['jev-first', 'model-alone', 'cheap'], ['jev-first', 'cheap', 'model-alone'],
].map(Object.freeze));
export const CODING_MS = 35 * 60_000;
export const TOTAL_MS = 45 * 60_000;
const HEX = /^[a-f0-9]{64}$/;
const own = (value, message) => { if (!value) throw new Error(message); };
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const digest = value => typeof value === 'string' && HEX.test(value);
const immutable = value => {
  if (value && typeof value === 'object') { Object.values(value).forEach(immutable); Object.freeze(value); }
  return value;
};
const verified = check => check?.status === 'verified' && Array.isArray(check.evidence) && check.evidence.some(nonempty);

export function validateGraderPreflights(tasks, preflights) {
  own(Array.isArray(preflights) && preflights.length === 6 && new Set(preflights.map(row => row.taskId)).size === 6, 'Freeze one preflight per task');
  for (const task of tasks) {
    const preflight = preflights.find(row => row.taskId === task.id);
    own(preflight?.baseRevision === task.baseRevision && preflight.graderHash === task.graderHash
      && preflight.referencePatchHash === task.referencePatchHash, 'Grader preflight must match the frozen task and repair');
    for (const [control, expected] of Object.entries({broken: 'fail', reference: 'pass', missing: 'fail', wrong: 'fail'})) {
      const result = preflight.controls?.[control];
      own(result?.verdict === expected && result.healthy === true && digest(result.evidenceHash)
        && Number.isFinite(result.durationMs) && result.durationMs > 0 && result.durationMs <= TOTAL_MS - CODING_MS,
      `Healthy ${control} grader control is required within ten minutes`);
    }
  }
  return true;
}

export function plannedSlots(tasks = Array.from({length: 6}, (_, index) => ({id: `unassigned-${index + 1}`}))) {
  own(tasks.length === 6, 'Exactly six bugs are required');
  return tasks.flatMap((task, index) => ORDERS[index].map((arm, position) => ({
    id: `${task.id}.${arm}`, taskId: task.id, arm, position, status: 'NOTSTARTED',
    startedAt: null, codingEndedAt: null, gradedAt: null, retainedPatchHash: null,
    verdict: null, approvals: 0, failedPublicCycles: 0, packet: null, uptake: null,
    packetUnavailable: null, identityVerified: false,
    billing: {billedUsd: null, complete: false, subscriptionCapacity: null},
  })));
}

export function pinEvidencePacket(packet, providerOptionLimit) {
  own(Array.isArray(packet?.cards) && packet.cards.length > 0 && packet.coverage, 'Freeze an actual nonempty evidence packet');
  return {contentHash: hash({query: packet.query, cards: [...packet.cards].sort((a, b) => a.id.localeCompare(b.id)), coverage: packet.coverage}),
    cheapOrder: packet.cards.map(card => card.id), bytes: packet.bytes, providerOptionLimit,
    inventoryCount: packet.coverage.inventoryCount, omittedCount: packet.coverage.omittedCount, inventoryDigest: packet.coverage.inventoryDigest};
}

export function validateManifest(manifest, qualification, preflights) {
  own(manifest?.schemaVersion === 'desktop-ranking-pilot-v1', 'Unsupported pilot schema');
  own(manifest.privacy === 'private', 'Run evidence must have private storage');
  own(nonempty(manifest.studyId), 'Study ID is required');
  own(manifest.runtime?.host === 'codex-desktop', 'The pilot requires actual Codex desktop, never a CLI substitute');
  for (const key of ['appVersion', 'appBuild', 'codingModel', 'codingModelVersion', 'effort', 'jevDecisionModelVersion']) {
    own(nonempty(manifest.runtime[key]), `Pin runtime.${key}`);
  }
  own(manifest.runtime.unrelatedConsultations === false && manifest.runtime.callableJevTools === false
    && manifest.runtime.automaticHooks === false, 'Both packet arms must isolate the ranking feature');
  for (const key of ['permissionsHash', 'pluginPackageHash', 'jevPromptHash']) own(digest(manifest.runtime[key]), `Pin runtime.${key}`);
  own(manifest.policy?.codingMs === CODING_MS && manifest.policy.totalMs === TOTAL_MS
    && manifest.policy.packetMaxBytes === 16384 && manifest.policy.k1 === 1.2 && manifest.policy.b === 0.75,
  'The approved clock, packet and BM25 policy is frozen');
  own(qualification?.schemaVersion === 'desktop-qualification-v1' && qualification.host?.kind === 'codex-desktop'
    && verified(qualification.host.runtimeIdentity), 'Desktop-owned runtime identity requires evidence');
  own(qualification.host.version === manifest.runtime.appVersion && qualification.host.build === manifest.runtime.appBuild,
    'Qualification must match the frozen installed desktop');
  for (const key of ['tools', 'hooks', 'instructions', 'candidatePacket', 'transport']) {
    own(verified(qualification.baselineIsolation?.[key]), `Baseline ${key} isolation is unproved`);
  }
  own(manifest.qualificationHash === hash(qualification), 'Qualification receipt changed');
  checkCorpus(manifest.corpus, manifest.reservations);
  own(Array.isArray(manifest.tasks) && manifest.tasks.length === 6, 'Exactly six bugs are required');
  own(new Set(manifest.tasks.map(task => task.id)).size === 6, 'Task IDs must be unique');
  own(new Set(manifest.tasks.map(task => task.repository)).size >= 2, 'At least two repositories are required');
  own(new Set(manifest.tasks.map(task => task.taskType)).size >= 2, 'At least two task types are required');
  validateGraderPreflights(manifest.tasks, preflights);
  for (const task of manifest.tasks) {
    for (const key of ['id', 'repository', 'taskType', 'baseRevision']) own(nonempty(task[key]), `Task ${key} is required`);
    const metadata = manifest.corpus.tasks.find(row => row.id === task.id);
    own(metadata?.repository === task.repository && metadata.baseRevision === task.baseRevision && metadata.taskType === task.taskType
      && metadata.referencePatchHash === task.referencePatchHash, 'Frozen task must match its independently eligible corpus provenance');
    for (const key of ['publicFailureHash', 'inputHash', 'candidateCorpusHash', 'graderHash', 'referencePatchHash']) {
      own(digest(task[key]), `Pin task ${task.id}.${key}`);
    }
    own(task.publicFailureObserved === true, 'Every broken base needs a real public failing-test record');
    own(digest(task.packet?.contentHash) && Array.isArray(task.packet.cheapOrder) && task.packet.cheapOrder.length > 0,
      'Freeze the common packet and cheap order');
    own(new Set(task.packet.cheapOrder).size === task.packet.cheapOrder.length, 'Candidate IDs must be unique');
    own(Number.isSafeInteger(task.packet.bytes) && task.packet.bytes > 0 && task.packet.bytes <= 16384, 'Packet exceeds 16 KiB');
    own(Number.isSafeInteger(task.packet.providerOptionLimit) && task.packet.cheapOrder.length + 1 <= task.packet.providerOptionLimit,
      'Candidate options plus none exceed the actual provider limit');
    own(Number.isSafeInteger(task.packet.inventoryCount) && task.packet.inventoryCount >= task.packet.cheapOrder.length
      && Number.isSafeInteger(task.packet.omittedCount) && task.packet.inventoryCount === task.packet.cheapOrder.length + task.packet.omittedCount
      && task.packet.inventoryDigest === task.candidateCorpusHash,
      'Keep complete candidate coverage');
  }
  own(manifest.preflightHash === hash(preflights), 'Grader preflight identity changed');
  return true;
}

export function freezeStudy(manifest, qualification, preflights) {
  validateManifest(manifest, qualification, preflights);
  return immutable({schemaVersion: 'desktop-ranking-state-v1', manifest: structuredClone(manifest), manifestHash: hash(manifest),
    qualification: structuredClone(qualification), preflights: structuredClone(preflights),
    slots: plannedSlots(manifest.tasks), events: [], halted: null, lastAt: null});
}

const eventFields = {
  start: [], identity: ['identityHash', 'evidenceHash'],
  packet: ['contentHash', 'order', 'decision', 'choiceAttempts', 'decisionModelVersion', 'promptHash', 'evidenceHash'],
  packet_unavailable: ['reason', 'choiceAttempts', 'evidenceHash'],
  approval: ['evidenceHash'], public_verification_failed: ['evidenceHash'],
  uptake: ['value', 'evidenceHash'], coding_ended: ['patchHash', 'reason', 'evidenceHash'],
  graded: ['patchHash', 'verdict', 'healthy', 'graderHash', 'evidenceHash'],
  billing: ['billedUsd', 'complete', 'subscriptionCapacity', 'evidenceHash'],
  tick: [], isolation_broken: ['reason', 'evidenceHash'],
};

export function reduceEvent(previous, event) {
  own(previous.manifestHash === hash(previous.manifest), 'Frozen manifest identity broke');
  own(!previous.halted, 'Scoring stopped; the retained study cannot resume');
  own(Object.hasOwn(eventFields, event.type), 'Unknown event type');
  const allowed = new Set(['id', 'type', 'slotId', 'at', 'manifestHash', ...eventFields[event.type]]);
  own(Object.keys(event).every(key => allowed.has(key)), 'Event contains unrecognized or private fields');
  own(nonempty(event.id) && !previous.events.some(row => row.id === event.id), 'Event IDs must be unique');
  own(event.manifestHash === previous.manifestHash, 'Event must join the frozen manifest');
  const at = Date.parse(event.at);
  own(Number.isFinite(at) && (previous.lastAt === null || at >= Date.parse(previous.lastAt)), 'Events must have monotonic observed times');
  const state = structuredClone(previous);
  const slot = state.slots.find(row => row.id === event.slotId);
  own(slot, 'Unknown slot; additional attempts are forbidden');
  const task = state.manifest.tasks.find(row => row.id === slot.taskId);
  const halt = reason => {
    state.halted = {reason, eventId: event.id, at: event.at};
    if (slot.status === 'CODING' || slot.status === 'GRADING') { slot.status = 'INFRASTRUCTURE_INVALID'; slot.verdict = 'infrastructure-invalid'; }
  };
  if (event.type === 'start') {
    own(slot.status === 'NOTSTARTED', 'A slot is single-use; retries are forbidden');
    own(!state.slots.some(row => row.status === 'CODING' || row.status === 'GRADING'), 'Attempts run serially');
    own(state.slots.find(row => row.status === 'NOTSTARTED')?.id === slot.id, 'Use the frozen balanced arm order');
    slot.startedAt = event.at;
    slot.status = 'CODING';
  } else {
    own(slot.startedAt !== null, 'Record the start before startup, retrieval, approvals, or human waits');
    const elapsed = at - Date.parse(slot.startedAt);
    own(elapsed >= 0, 'Event predates the assigned attempt');
    if ((slot.status === 'CODING' && elapsed > CODING_MS) || (slot.status === 'GRADING'
      && (elapsed > TOTAL_MS || at - Date.parse(slot.codingEndedAt) > TOTAL_MS - CODING_MS))) {
      halt('clock-limit-breached');
    } else if (event.type === 'identity' || event.type === 'isolation_broken') {
      own(digest(event.evidenceHash), 'Identity observations need evidence');
      if (event.type === 'isolation_broken' || event.identityHash !== hash(state.manifest.runtime)) halt(event.reason || 'runtime-identity-broke');
      else slot.identityVerified = true;
    } else if (event.type === 'packet') {
      own(slot.status === 'CODING', 'Packets must be observed during coding');
      own(digest(event.evidenceHash), 'Packet observations need evidence');
      const order = task.packet.cheapOrder;
      let identityMatches = slot.arm !== 'model-alone' && slot.packet === null && event.contentHash === task.packet.contentHash && Array.isArray(event.order)
        && event.order.length === order.length && new Set(event.order).size === order.length && event.order.every(id => order.includes(id));
      if (slot.arm === 'cheap') identityMatches &&= event.choiceAttempts === 0 && event.decision === 'cheap' && hash(event.order) === hash(order);
      else if (identityMatches) {
        identityMatches &&= event.choiceAttempts === 1 && ['selected', 'abstained', 'error'].includes(event.decision);
        identityMatches &&= event.promptHash === state.manifest.runtime.jevPromptHash
          && (event.decisionModelVersion === state.manifest.runtime.jevDecisionModelVersion
            || (event.decision !== 'selected' && event.decisionModelVersion === null));
        const expected = event.decision === 'selected' ? [event.order[0], ...order.filter(id => id !== event.order[0])] : order;
        identityMatches &&= hash(event.order) === hash(expected);
      }
      if (!identityMatches) halt('treatment-identity-broke');
      else slot.packet = {contentHash: event.contentHash, order: event.order, decision: event.decision, choiceAttempts: event.choiceAttempts};
    } else if (event.type === 'packet_unavailable') {
      own(slot.status === 'CODING' && slot.arm !== 'model-alone' && slot.packet === null && slot.packetUnavailable === null,
        'Record one unavailable delivery in a packet arm');
      own(['outage', 'transport-error', 'ignored'].includes(event.reason) && digest(event.evidenceHash)
        && (slot.arm === 'cheap' ? event.choiceAttempts === 0 : [0, 1].includes(event.choiceAttempts)), 'Unavailable delivery requires honest call coverage and evidence');
      slot.packetUnavailable = {reason: event.reason, choiceAttempts: event.choiceAttempts, evidenceHash: event.evidenceHash};
    } else if (event.type === 'approval' || event.type === 'public_verification_failed') {
      own(slot.status === 'CODING' && digest(event.evidenceHash), 'Coding observation needs evidence');
      slot[event.type === 'approval' ? 'approvals' : 'failedPublicCycles'] += 1;
    } else if (event.type === 'uptake') {
      own(slot.packet !== null && ['observed', 'ignored', 'unknown'].includes(event.value) && digest(event.evidenceHash), 'Uptake needs packet delivery evidence');
      own(slot.uptake === null, 'Uptake observation is immutable');
      slot.uptake = event.value;
    } else if (event.type === 'coding_ended') {
      own(slot.status === 'CODING' && digest(event.patchHash) && digest(event.evidenceHash), 'Retain one terminal patch before grading');
      own(['completed', 'timeout', 'failed', 'outage'].includes(event.reason), 'Retain the coding disposition');
      own(slot.arm === 'model-alone' || slot.packet !== null || slot.packetUnavailable !== null || event.reason !== 'completed',
        'Record actual packet delivery or its observed absence');
      slot.status = 'GRADING'; slot.codingEndedAt = event.at; slot.retainedPatchHash = event.patchHash; slot.codingReason = event.reason;
    } else if (event.type === 'graded') {
      own(slot.status === 'GRADING' && event.patchHash === slot.retainedPatchHash && digest(event.evidenceHash), 'Grade only the retained terminal patch');
      own(slot.identityVerified && event.graderHash === task.graderHash, 'Grading needs observed treatment configuration and the frozen independent grader');
      own(['verified-fix', 'not-fixed', 'infrastructure-invalid'].includes(event.verdict), 'Unknown independent grader verdict');
      own(event.verdict === 'infrastructure-invalid' || event.healthy === true, 'Broken grader infrastructure is not a coding failure');
      slot.status = event.verdict === 'infrastructure-invalid' ? 'INFRASTRUCTURE_INVALID' : 'COMPLETE';
      slot.gradedAt = event.at; slot.verdict = event.verdict;
    } else if (event.type === 'billing') {
      own(event.billedUsd === null || (Number.isFinite(event.billedUsd) && event.billedUsd >= 0), 'Billing is measured dollars or null');
      own(typeof event.complete === 'boolean' && (!event.complete || event.billedUsd !== null) && digest(event.evidenceHash), 'Complete billing requires observed dollars');
      own(event.subscriptionCapacity === null || (Number.isFinite(event.subscriptionCapacity) && event.subscriptionCapacity >= 0), 'Subscription capacity is separate from billed dollars');
      own(!slot.billing.complete, 'Complete billing is immutable');
      slot.billing = {billedUsd: event.billedUsd, complete: event.complete, subscriptionCapacity: event.subscriptionCapacity};
    }
  }
  state.events.push(structuredClone(event)); state.lastAt = event.at;
  return immutable(state);
}

export function summarizeStudy(state) {
  own(state.manifestHash === hash(state.manifest), 'Frozen manifest identity broke; scoring is forbidden');
  const started = state.slots.filter(slot => slot.startedAt !== null);
  const finished = started.filter(slot => slot.gradedAt !== null || slot.status === 'INFRASTRUCTURE_INVALID');
  const scoring = state.halted ? 'stopped' : started.length === 0 ? 'not-started' : finished.length === 18 ? 'complete' : 'partial';
  const byArm = Object.fromEntries(ARMS.map(arm => {
    const slots = state.slots.filter(slot => slot.arm === arm);
    const assigned = slots.filter(slot => slot.startedAt !== null);
    const scored = assigned.filter(slot => slot.status === 'COMPLETE');
    const fixes = assigned.filter(slot => slot.verdict === 'verified-fix');
    const elapsed = assigned.reduce((sum, slot) => sum + Date.parse(slot.gradedAt ?? state.lastAt) - Date.parse(slot.startedAt), 0);
    const complete = slots.every(slot => slot.status === 'COMPLETE');
    const observedThroughMs = scored.length ? Math.max(...scored.map(slot => Date.parse(slot.gradedAt) - Date.parse(slot.startedAt))) : null;
    return [arm, {assigned: assigned.length, scheduled: 6, scored: scored.length,
      verifiedFixes: scoring === 'stopped' || !scored.length ? null : fixes.length, observedThroughMs,
      fullElapsedMs: assigned.length ? elapsed : null,
      fullTimePerFixMs: complete && fixes.length > 0 && !state.halted ? elapsed / fixes.length : null,
      billedUsd: assigned.length && assigned.every(slot => slot.billing.complete) ? assigned.reduce((sum, slot) => sum + slot.billing.billedUsd, 0) : null,
      billingComplete: assigned.length > 0 && assigned.every(slot => slot.billing.complete),
      approvals: assigned.reduce((sum, slot) => sum + slot.approvals, 0),
      failedPublicCycles: assigned.reduce((sum, slot) => sum + slot.failedPublicCycles, 0),
      packetDeliveries: assigned.filter(slot => slot.packet !== null).length,
      packetMissing: assigned.filter(slot => slot.packetUnavailable !== null).length,
      packetUnknown: assigned.filter(slot => slot.packet === null && slot.packetUnavailable === null).length,
      choiceAttempts: assigned.reduce((sum, slot) => sum + (slot.packet?.choiceAttempts ?? slot.packetUnavailable?.choiceAttempts ?? 0), 0),
      uptake: Object.fromEntries(['observed', 'ignored', 'unknown'].map(value => [value, assigned.filter(slot => (slot.uptake ?? 'unknown') === value).length])),
      codingDispositions: Object.fromEntries(['completed', 'timeout', 'failed', 'outage'].map(value => [value, assigned.filter(slot => slot.codingReason === value).length])),
      infrastructureInvalid: slots.filter(slot => slot.status === 'INFRASTRUCTURE_INVALID').length,
      denominatorBounds: {observed: assigned.filter(slot => slot.status === 'COMPLETE').length, assigned: assigned.length, scheduled: 6},
      verifiedFixBounds: state.halted ? null : {lower: fixes.length, upper: fixes.length + 6 - scored.length},
      stepCurve: scoring === 'stopped' || !scored.length ? null : [{elapsedMs: 0, fixes: 0}, ...fixes
        .map(slot => Date.parse(slot.gradedAt) - Date.parse(slot.startedAt)).sort((a, b) => a - b)
        .map((elapsedMs, index) => ({elapsedMs, fixes: index + 1})), {elapsedMs: complete ? TOTAL_MS : observedThroughMs, fixes: fixes.length}],
    }];
  }));
  const report = {schemaVersion: 'desktop-ranking-report-v1', studyId: state.manifest.studyId, manifestHash: state.manifestHash,
    scoring, halted: state.halted, attempted: started.length, remaining: 18 - started.length, byArm,
    paired: state.manifest.tasks.map(task => ({taskId: task.id, arms: Object.fromEntries(state.slots.filter(slot => slot.taskId === task.id)
      .map(slot => [slot.arm, {status: slot.status, verdict: slot.verdict, uptake: slot.uptake}]))})),
    limitation: 'Exploratory six-bug pilot. Subscription capacity is not billed dollars. No confirmation run is authorized.'};
  return {...report, exploratoryScreen: exploratoryScreen(report)};
}

export function exploratoryScreen(report) {
  const baseline = report.byArm['model-alone'];
  const cheap = report.byArm.cheap;
  const jev = report.byArm['jev-first'];
  const measured = report.scoring === 'complete' && Object.values(report.byArm).every(arm => arm.infrastructureInvalid === 0 && arm.denominatorBounds.observed === 6);
  const delivery = cheap.packetDeliveries === 6 && jev.packetDeliveries === 6 && cheap.choiceAttempts === 0 && jev.choiceAttempts === 6;
  const uptake = jev.uptake.observed > 0 && jev.uptake.unknown === 0;
  const noAddedApprovals = jev.approvals <= baseline.approvals && jev.approvals <= cheap.approvals;
  const additionalFix = measured && jev.verifiedFixes >= cheap.verifiedFixes + 1 && jev.verifiedFixes >= baseline.verifiedFixes;
  const timeReduction = measured && [baseline, cheap, jev].every(arm => arm.fullTimePerFixMs !== null)
    && jev.verifiedFixes >= baseline.verifiedFixes && jev.verifiedFixes >= cheap.verifiedFixes
    && jev.fullTimePerFixMs <= baseline.fullTimePerFixMs * 0.8 && jev.fullTimePerFixMs <= cheap.fullTimePerFixMs * 0.8;
  return {eligible: measured && delivery && uptake && noAddedApprovals, passed: measured && delivery && uptake && noAddedApprovals && (additionalFix || timeReduction),
    checks: {validMeasurement: measured, observedDelivery: delivery, observedUptake: uptake, noAddedApprovals, additionalFix, timeReduction},
    nextAction: 'Return observed charts and evidence to Romy. This screen never starts or authorizes confirmation attempts.'};
}

export function renderObservedSvg(report) {
  const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
  const colors = ['#333333', '#1368aa', '#9b3d9b'];
  const lines = ARMS.map((arm, index) => {
    const curve = report.byArm[arm].stepCurve;
    if (!curve) return '';
    let path = '';
    curve.forEach((point, position) => { path += `${position ? ' H' : 'M'}${70 + point.elapsedMs / TOTAL_MS * 600}${position ? ' V' : ' '}${330 - point.fixes / 6 * 270}`; });
    return `<path d="${path}" fill="none" stroke="${colors[index]}" stroke-width="3"/>`;
  }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="760" height="440" viewBox="0 0 760 440"><rect width="760" height="440" fill="white"/><g font-family="sans-serif" fill="#222"><text x="35" y="28" font-size="18">Observed verified fixes by common task-time allowance</text><text x="35" y="50" font-size="13">${escape(report.scoring)}; ${report.attempted} assigned attempts; unknown billing stays null</text><path d="M70 60V330H670" fill="none" stroke="#555"/><text x="54" y="335">0</text><text x="54" y="65">6</text><text x="65" y="352">0</text><text x="650" y="352">45 min</text><text x="260" y="375">Elapsed time including startup, waits, retrieval and grading</text>${ARMS.map((arm, index) => `<text x="${70 + index * 210}" y="410" fill="${colors[index]}">${escape(arm)}</text>`).join('')}${lines}${!lines ? '<text x="120" y="190">No eligible observed fix curve. No zero-reward result is inferred.</text>' : ''}</g></svg>\n`;
}
