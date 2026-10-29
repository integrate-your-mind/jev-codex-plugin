import {hash} from '../identity.mjs';
import {ORDERS, CODING_MS, TOTAL_MS, validateGraderPreflights} from '../pilot.mjs';
import {checkCorpus} from '../corpus.mjs';
export {hash};
export const ARMS = ['plugin-off', 'cheap', 'plugin-on'];
export const TASK_IDS = ['psf__requests-2931', 'psf__requests-5414', 'psf__requests-6028', 'sympy__sympy-16886', 'sympy__sympy-19346', 'sympy__sympy-24562'];
const names = {'model-alone': 'plugin-off', cheap: 'cheap', 'jev-first': 'plugin-on'};
const assert = (value, message) => { if (!value) throw new Error(message); };
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const text = value => typeof value === 'string' && value.length > 0;
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
const terminal = slot => ['COMPLETE', 'INFRASTRUCTURE_INVALID'].includes(slot.status);
const continuationKeys=['schemaVersion','parentStudyId','parentManifestHash','parentStateHash','importedSlotsHash','importedSlotIds','humanApprovalEvidenceHash'];
const sameProtocol=(first,second)=>{
  const {studyId:firstId,continuation:firstLink,...firstPins}=first;
  const {studyId:secondId,continuation:secondLink,...secondPins}=second;
  return hash(firstPins)===hash(secondPins);
};

export function exposureValid(arm, value) {
  const enabled = arm === 'plugin-on';
  return value?.pluginEnabled === enabled && value.mode === (enabled ? 'changed_state' : 'off')
    && ['tools', 'hooks', 'guidance'].every(key => value[key] === (enabled ? 'normal' : 'absent'))
    && value.adviceConnection === enabled && digest(value.configurationHash)
    && (enabled ? digest(value.packageHash) : value.packageHash === null || digest(value.packageHash));
}

export function validateManifest(manifest) {
  assert(manifest?.schemaVersion === 'whole-plugin-pilot-v1' && manifest.privacy === 'private' && text(manifest.studyId), 'Use a private whole-plugin-pilot-v1 manifest');
  assert(manifest.host?.kind === 'codex-desktop' && manifest.host.model === 'gpt-6.1-sol' && manifest.host.effort === 'ultra'
    && digest(manifest.host.settingsEvidenceHash), 'Freeze native Codex desktop sol/ultra settings evidence');
  for (const key of ['appVersion', 'backendVersion']) assert(manifest.host[key] === null || text(manifest.host[key]), 'Unknown host versions must be null');
  assert(manifest.policy?.codingMs === CODING_MS && manifest.policy.totalMs === TOTAL_MS && manifest.policy.gradingMs === 600000
    && manifest.policy.attempts === 18 && manifest.policy.interimAfter === 3, 'Use the approved eighteen-slot 35+10 minute policy');
  assert(manifest.policy.retrieval?.method === 'bm25' && manifest.policy.retrieval.k1 === 1.2 && manifest.policy.retrieval.b === 0.75
    && manifest.policy.retrieval.maxBytes === 16384 && manifest.policy.retrieval.maxCandidates === 254
    && manifest.policy.retrieval.source === 'frozen-broken-base' && manifest.policy.retrieval.tieBreak === 'stable-id', 'Preserve the frozen BM25 retrieval policy');
  assert(ARMS.every(arm => exposureValid(arm, manifest.arms?.[arm])), 'Freeze OFF, cheap and changed-state ON exposure separately');
  checkCorpus(manifest.corpus, manifest.reservations);
  assert(hash(manifest.tasks?.map(task => task.id)) === hash(TASK_IDS), 'Keep the same six bugs in the frozen order');
  validateGraderPreflights(manifest.tasks, manifest.preflights);
  assert(manifest.preflightHash === hash(manifest.preflights), 'Grader control identity changed');
  for (const task of manifest.tasks) {
    const source = manifest.corpus.tasks.find(row => row.id === task.id);
    assert(source?.baseRevision === task.baseRevision && source.repository === task.repository
      && source.referencePatchHash === task.referencePatchHash, 'Task source identity changed');
    for (const key of ['inputHash', 'publicFailureHash', 'graderHash']) assert(digest(task[key]), `Pin ${task.id}.${key}`);
    assert(task.cheapPacketHash === null || digest(task.cheapPacketHash), 'Cheap packet identity is a hash or an explicitly deferred deterministic retrieval');
  }
  if (manifest.continuation !== undefined) {
    const link=manifest.continuation;
    assert(link && Object.keys(link).length===continuationKeys.length && continuationKeys.every(key=>Object.hasOwn(link,key))
      && link.schemaVersion==='whole-plugin-continuation-v1' && text(link.parentStudyId) && link.parentStudyId!==manifest.studyId
      && ['parentManifestHash','parentStateHash','importedSlotsHash','humanApprovalEvidenceHash'].every(key=>digest(link[key]))
      && hash(link.importedSlotIds)===hash([`${TASK_IDS[0]}.plugin-off`,`${TASK_IDS[0]}.cheap`]), 'Continuation requires exact parent joins, first-two slot IDs and explicit human approval evidence');
  }
  return true;
}

export function freezeStudy(manifest) {
  validateManifest(manifest);
  const slots = manifest.tasks.flatMap((task, index) => ORDERS[index].map((oldArm, position) => ({
    id: `${task.id}.${names[oldArm]}`, taskId: task.id, arm: names[oldArm], position, status: 'NOTSTARTED',
    startedAt: null, endedAt: null, codingEndedAt: null, chatId: null, workspaceId: null, identity: null,
    patchHash: null, verdict: null, codingReason: null, retrieval: null, consultations: [], approvals: 0,
    failedPublicCycles: 0, billing: {codingUsd: null, jevUsd: null, complete: false, subscriptionCapacity: null},
  })));
  return freeze({schemaVersion: 'whole-plugin-state-v1', manifest: structuredClone(manifest), manifestHash: hash(manifest), slots, events: [], lastAt: null, halted: null, interim: null});
}

export function validateContinuationParent(parent) {
  assert(parent?.schemaVersion==='whole-plugin-state-v1' && !parent.manifest?.continuation && Array.isArray(parent.events), 'Continue the original retained parent only once, never a replacement or nested cohort');
  let replay=freezeStudy(parent.manifest);
  for (const event of parent.events) replay=reduceEvent(replay,event);
  assert(hash(replay)===hash(parent), 'Retained parent snapshot does not match its immutable event replay');
  assert(parent.halted?.reason==='untracked-native-launch' && parent.slots[0].status==='COMPLETE' && parent.slots[0].verdict==='verified-fix'
    && parent.slots[1].status==='INFRASTRUCTURE_INVALID' && parent.slots[1].verdict==='infrastructure-invalid'
    && parent.slots[1].startedAt===null && parent.slots[1].untrackedLaunch?.prelaunchStartedAt===null
    && hash(parent.slots.slice(2))===hash(freezeStudy(parent.manifest).slots.slice(2)), 'Only the approved valid first result and invalid second launch may be imported; sixteen slots must remain untouched');
  return true;
}

export function continuationManifest(parent, config) {
  validateContinuationParent(parent);
  assert(config && Object.keys(config).length===2 && text(config.studyId) && config.studyId!==parent.manifest.studyId
    && digest(config.humanApprovalEvidenceHash), 'Continuation needs a new study ID and explicit human approval evidence hash');
  const manifest={...structuredClone(parent.manifest),studyId:config.studyId,continuation:{schemaVersion:'whole-plugin-continuation-v1',parentStudyId:parent.manifest.studyId,
    parentManifestHash:parent.manifestHash,parentStateHash:hash(parent),importedSlotsHash:hash(parent.slots.slice(0,2)),
    importedSlotIds:parent.slots.slice(0,2).map(slot=>slot.id),humanApprovalEvidenceHash:config.humanApprovalEvidenceHash}};
  validateManifest(manifest); return freeze(manifest);
}

const fields = {
  start: ['evidenceHash'],
  identity: ['chatId', 'workspaceId', 'model', 'effort', 'baseRevision', 'exposure', 'evidenceHash'],
  retrieval: ['packetHash', 'evidenceHash'],
  retrieval_unavailable: ['reason', 'evidenceHash'],
  consultation: ['consultationId', 'status', 'providerInvoked', 'delivered', 'receiptHash', 'evidenceHash'],
  uptake: ['consultationId', 'value', 'evidenceHash'],
  approval: ['evidenceHash'], public_verification_failed: ['evidenceHash'],
  coding_ended: ['patchHash', 'reason', 'evidenceHash'],
  graded: ['patchHash', 'graderHash', 'verdict', 'healthy', 'evidenceHash'],
  billing: ['codingUsd', 'jevUsd', 'complete', 'subscriptionCapacity', 'evidenceHash'],
  usage: ['inputTokens', 'outputTokens', 'cachedInputTokens', 'evidenceHash'],
  integration_failed: ['reason', 'evidenceHash'], identity_broken: ['reason', 'evidenceHash'], tick: [],
  recovery_untracked_launch: ['chatId', 'createdAt', 'completedAt', 'prelaunchStartedAt', 'evidenceHash'],
  native_launch_prepared: ['preparationHash', 'stateHash', 'evidenceHash'],
  continuation_import: ['parentState','evidenceHash'],
  interim_report: ['reportHash', 'artifactsHash', 'evidenceHash'],
};

export function reduceEvent(previous, event) {
  assert(previous.manifestHash === hash(previous.manifest), 'Frozen whole-plugin manifest changed');
  assert(!previous.halted, 'Scoring stopped; no retry or replacement is allowed');
  assert(Object.hasOwn(fields, event.type), 'Unknown whole-plugin event');
  assert(Object.keys(event).every(key => ['id', 'type', 'slotId', 'at', 'manifestHash', ...fields[event.type]].includes(key)), 'Unknown/private event fields');
  assert(text(event.id) && !previous.events.some(row => row.id === event.id) && event.manifestHash === previous.manifestHash, 'Event ID or frozen manifest join is invalid');
  const now = Date.parse(event.at);
  assert(Number.isFinite(now) && (previous.lastAt === null || now >= Date.parse(previous.lastAt)), 'Observed event times must be monotonic');
  const state = structuredClone(previous);
  if (event.type === 'continuation_import') {
    const link=state.manifest.continuation,parent=event.parentState;
    assert(link && state.events.length===0 && !event.slotId && state.slots.every(slot=>slot.status==='NOTSTARTED') && digest(event.evidenceHash), 'Import consumed parent slots exactly once before any continuation start');
    validateContinuationParent(parent);
    assert(link.parentStudyId===parent.manifest.studyId && link.parentManifestHash===parent.manifestHash && link.parentStateHash===hash(parent)
      && link.importedSlotsHash===hash(parent.slots.slice(0,2)) && hash(link.importedSlotIds)===hash(parent.slots.slice(0,2).map(slot=>slot.id))
      && sameProtocol(state.manifest,parent.manifest) && now>=Date.parse(parent.lastAt), 'Continuation import parent digests, original protocol or observed timing changed');
    state.slots.splice(0,2,...structuredClone(parent.slots.slice(0,2)));
    state.continuationImport={parentManifestHash:link.parentManifestHash,parentStateHash:link.parentStateHash,importedSlotsHash:link.importedSlotsHash,evidenceHash:event.evidenceHash};
  } else if (event.type === 'interim_report') {
    assert(state.slots.slice(0, 3).every(terminal) && state.slots.slice(3).every(slot => slot.status === 'NOTSTARTED') && !state.interim, 'Record one interim chart after the first three attempts');
    assert([event.reportHash, event.artifactsHash, event.evidenceHash].every(digest), 'Retain actual interim report/artifact evidence');
    state.interim = {reportHash: event.reportHash, artifactsHash: event.artifactsHash, evidenceHash: event.evidenceHash};
  } else {
    const slot = state.slots.find(row => row.id === event.slotId);
    assert(slot, 'Unknown slot; extra attempts are forbidden');
    assert(!state.continuationImport || !state.manifest.continuation.importedSlotIds.includes(slot.id), 'Imported consumed slots are immutable; no retry, replacement or later mutation is permitted');
    const task = state.manifest.tasks.find(row => row.id === slot.taskId);
    const halt = reason => { state.halted = {reason, at: event.at, eventId: event.id}; if (!terminal(slot)) { slot.status = 'INFRASTRUCTURE_INVALID'; slot.endedAt = event.at; } };
    if (event.type === 'recovery_untracked_launch') {
      const created = Date.parse(event.createdAt), completed = Date.parse(event.completedAt);
      assert(slot.status === 'NOTSTARTED' && state.slots.find(row => row.status === 'NOTSTARTED')?.id === slot.id
        && !state.slots.some(row => ['CODING', 'GRADING'].includes(row.status)), 'Recover only the next untouched slot with no active attempt');
      assert(event.prelaunchStartedAt === null && text(event.chatId) && digest(event.evidenceHash)
        && Number.isFinite(created) && Number.isFinite(completed) && completed >= created && completed <= now
        && !state.slots.some(row => row.chatId === event.chatId), 'Retain actual unique native identity and observed times; missing pre-launch timing stays null');
      slot.chatId = event.chatId; slot.status = 'INFRASTRUCTURE_INVALID'; slot.verdict = 'infrastructure-invalid'; slot.endedAt = event.completedAt;
      slot.untrackedLaunch = {createdAt:event.createdAt, completedAt:event.completedAt, prelaunchStartedAt:null, evidenceHash:event.evidenceHash};
      slot.integrationFailure = 'untracked-native-launch';
      state.halted = {reason:'untracked-native-launch', at:event.at, eventId:event.id};
    } else if (event.type === 'start') {
      assert(!state.manifest.continuation || state.continuationImport, 'Import the consumed parent slots before starting this linked continuation');
      assert(slot.status === 'NOTSTARTED' && state.slots.find(row => row.status === 'NOTSTARTED')?.id === slot.id, 'Each assigned slot starts once in frozen order');
      assert(!state.slots.some(row => ['CODING', 'GRADING'].includes(row.status)), 'Attempts run serially');
      assert(state.slots.indexOf(slot) < 3 || state.interim, 'Generate and retain the first-three interim charts before attempt four');
      assert(digest(event.evidenceHash), 'Retain the pre-launch start intent');
      slot.status = 'CODING'; slot.startedAt = event.at;
    } else {
      assert(slot.startedAt !== null, 'Start the clock before native chat creation, retrieval or waits');
      const elapsed = now - Date.parse(slot.startedAt);
      if ((slot.status === 'CODING' && elapsed > CODING_MS) || (slot.status === 'GRADING'
        && (elapsed > TOTAL_MS || now - Date.parse(slot.codingEndedAt) > 600000))) halt('clock-limit-breached');
      else if (event.type === 'native_launch_prepared') {
        assert(slot.status === 'CODING' && !slot.launchPreparation && !slot.chatId && !slot.identity
          && event.stateHash === hash(previous) && digest(event.preparationHash) && digest(event.evidenceHash), 'Publish one validated native launch preparation before occupying its identity');
        slot.launchPreparation = {preparationHash:event.preparationHash, evidenceHash:event.evidenceHash};
      }
      else if (event.type === 'identity_broken') { assert(digest(event.evidenceHash) && text(event.reason), 'Retain the identity-break evidence'); halt(event.reason); }
      else if (event.type === 'integration_failed') {
        assert(!terminal(slot) && digest(event.evidenceHash) && text(event.reason), 'Retain the consumed integration failure');
        slot.status = 'INFRASTRUCTURE_INVALID'; slot.endedAt = event.at; slot.verdict = 'infrastructure-invalid'; slot.integrationFailure = event.reason;
      } else if (event.type === 'identity') {
        assert(!terminal(slot) && text(event.chatId) && text(event.workspaceId) && digest(event.evidenceHash), 'Retain actual native chat/workspace/settings evidence');
        const matches = event.model === state.manifest.host.model && event.effort === state.manifest.host.effort && event.baseRevision === task.baseRevision
          && hash(event.exposure) === hash(state.manifest.arms[slot.arm]) && exposureValid(slot.arm, event.exposure)
          && !state.slots.some(other => other.id !== slot.id && other.chatId === event.chatId)
          && (slot.chatId === null || slot.chatId === event.chatId);
        if (!matches) halt('native-profile-source-or-exposure-broke');
        else { slot.chatId = event.chatId; slot.workspaceId = event.workspaceId; slot.identity = {model: event.model, effort: event.effort, evidenceHash: event.evidenceHash}; }
      } else if (event.type === 'retrieval') {
        assert(slot.status === 'CODING' && slot.arm === 'cheap' && !slot.retrieval && digest(event.packetHash) && digest(event.evidenceHash), 'Record one actual timed cheap retrieval');
        if (task.cheapPacketHash !== null && event.packetHash !== task.cheapPacketHash) halt('cheap-packet-identity-broke');
        else slot.retrieval = {packetHash: event.packetHash, evidenceHash: event.evidenceHash};
      } else if (event.type === 'retrieval_unavailable') {
        assert(slot.status === 'CODING' && slot.arm === 'cheap' && !slot.retrieval && ['unavailable', 'error', 'missing'].includes(event.reason)
          && digest(event.evidenceHash), 'Retain the actual cheap packet delivery failure without replacing the attempt');
        slot.retrieval = {packetHash: null, reason: event.reason, evidenceHash: event.evidenceHash};
      } else if (event.type === 'consultation') {
        assert(slot.status === 'CODING' && text(event.consultationId) && ['assessed', 'abstained', 'unavailable', 'error'].includes(event.status)
          && [true, false, null].includes(event.providerInvoked) && typeof event.delivered === 'boolean'
          && (event.receiptHash === null || digest(event.receiptHash)) && digest(event.evidenceHash), 'Keep the observed consultation outcome and coverage');
        assert(!state.slots.some(other => other.consultations.some(row => row.id === event.consultationId)), 'Consultation IDs cannot be duplicated');
        if (slot.arm !== 'plugin-on') halt('jev-exposure-in-disabled-arm');
        else slot.consultations.push({id: event.consultationId, status: event.status, providerInvoked: event.providerInvoked, delivered: event.delivered, receiptHash: event.receiptHash, uptake: null});
      } else if (event.type === 'uptake') {
        const advice = slot.consultations.find(row => row.id === event.consultationId);
        assert(advice?.delivered && advice.uptake === null && ['observed', 'ignored', 'unknown'].includes(event.value) && digest(event.evidenceHash), 'Uptake joins an actually delivered consultation');
        advice.uptake = event.value;
      } else if (event.type === 'approval' || event.type === 'public_verification_failed') {
        assert(slot.status === 'CODING' && digest(event.evidenceHash), 'Retain the observed coding event');
        slot[event.type === 'approval' ? 'approvals' : 'failedPublicCycles'] += 1;
      } else if (event.type === 'coding_ended') {
        assert(slot.status === 'CODING' && digest(event.patchHash) && digest(event.evidenceHash) && ['completed', 'timeout', 'failed', 'outage'].includes(event.reason), 'Retain one terminal patch and coding disposition');
        slot.status = 'GRADING'; slot.codingEndedAt = event.at; slot.patchHash = event.patchHash; slot.codingReason = event.reason;
      } else if (event.type === 'graded') {
        assert(slot.status === 'GRADING' && slot.identity && event.patchHash === slot.patchHash && event.graderHash === task.graderHash
          && ['verified-fix', 'not-fixed', 'infrastructure-invalid'].includes(event.verdict) && digest(event.evidenceHash), 'Grade the retained patch only after actual native identity, using the frozen grader');
        assert(event.verdict === 'infrastructure-invalid' || event.healthy === true, 'An unhealthy grader is unresolved infrastructure');
        assert(slot.arm !== 'cheap' || slot.retrieval || event.verdict === 'infrastructure-invalid', 'Cheap grading requires its timed evidence packet');
        slot.status = event.verdict === 'infrastructure-invalid' ? 'INFRASTRUCTURE_INVALID' : 'COMPLETE'; slot.verdict = event.verdict; slot.endedAt = event.at;
      } else if (event.type === 'usage') {
        assert(!slot.usage && [event.inputTokens, event.outputTokens, event.cachedInputTokens].every(value => value === null || Number.isSafeInteger(value) && value >= 0)
          && (event.inputTokens === null || event.cachedInputTokens === null || event.cachedInputTokens <= event.inputTokens)
          && digest(event.evidenceHash), 'Record one observed per-attempt usage total; unknown token counts stay null');
        slot.usage = {inputTokens: event.inputTokens, outputTokens: event.outputTokens, cachedInputTokens: event.cachedInputTokens};
      } else if (event.type === 'billing') {
        assert([event.codingUsd, event.jevUsd, event.subscriptionCapacity].every(value => value === null || Number.isFinite(value) && value >= 0)
          && typeof event.complete === 'boolean' && (!event.complete || event.codingUsd !== null && event.jevUsd !== null)
          && !slot.billing.complete && digest(event.evidenceHash), 'Keep measured dollars separate from unknown cost and subscription capacity');
        slot.billing = {codingUsd: event.codingUsd, jevUsd: event.jevUsd, complete: event.complete, subscriptionCapacity: event.subscriptionCapacity};
      }
    }
  }
  state.events.push(structuredClone(event)); state.lastAt = event.at;
  return freeze(state);
}

export function deadlines(state) {
  const slot = state.slots.find(row => ['CODING', 'GRADING'].includes(row.status));
  if (!slot) return null;
  const start = Date.parse(slot.startedAt);
  return {slotId: slot.id, codingStopsAt: new Date(start + CODING_MS).toISOString(), gradingStopsAt: new Date(Math.min(start + TOTAL_MS, slot.codingEndedAt ? Date.parse(slot.codingEndedAt) + 600000 : start + TOTAL_MS)).toISOString()};
}
