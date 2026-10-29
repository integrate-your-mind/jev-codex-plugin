import {sameProfile, sameScope, type ApplyResult, type DecisionProposal, type HostCapabilities, type ModelEffortProfile, type TaskRevision} from './contracts.js';

export type ProfileDecision = Readonly<{action: 'preserve' | 'apply'; reason: string; profile?: ModelEffortProfile}>;

export function evaluateProfileProposal(input: {task: TaskRevision; proposal: DecisionProposal; capabilities: HostCapabilities; previous?: ApplyResult; now?: Date}): ProfileDecision {
  const {task, proposal, capabilities, previous} = input;
  const preserve = (reason: string): ProfileDecision => ({action: 'preserve', reason, ...(task.currentProfile ? {profile: task.currentProfile} : {})});
  if (![proposal, capabilities].every(record => sameScope(record.scope, task.scope))) return preserve('scope_mismatch');
  const now = (input.now ?? new Date()).getTime();
  if ([task, proposal, capabilities].some(record => !Number.isFinite(Date.parse(record.createdAt)) || record.retention !== 'pinned' && Math.min(record.expiresAt ? Date.parse(record.expiresAt) : Infinity, Date.parse(record.createdAt) + 7 * 24 * 60 * 60 * 1000) <= now)) return preserve('expired_facts');
  if (proposal.taskRevision !== task.revision || proposal.factsRevision !== task.factsRevision || proposal.catalogId !== task.catalogId || proposal.capabilityRevision !== capabilities.sourceRevision) return preserve('stale_proposal');
  if (capabilities.status !== 'known' || capabilities.profileSwitch !== 'supported' || !capabilities.orderedPreDispatch) return preserve('unsupported_capability');
  const recommended = task.pin ?? proposal.recommendedProfile;
  if (!recommended || (!task.pin && proposal.disposition !== 'selected')) return preserve('uncertain_selection');
  if (!capabilities.eligibleProfiles.some(profile => sameProfile(profile, recommended))) return preserve('ineligible_profile');
  if (sameProfile(task.currentProfile, recommended)) return preserve('current_profile');
  if (previous && sameScope(previous.scope, task.scope) && previous.status === 'applied' && previous.factsRevision === task.factsRevision) return preserve('unchanged_facts');
  if (!task.pin && proposal.transition === 'downshift' && (!task.completedSubtask || task.pendingToolCycle)) return preserve('subtask_in_progress');
  if (task.pendingToolCycle) return preserve('pending_tool_cycle');
  return {action: 'apply', reason: task.pin ? 'explicit_pin' : 'eligible_proposal', profile: recommended};
}
