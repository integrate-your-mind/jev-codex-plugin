import {isAbsolute, normalize} from 'node:path';
import {hash, validateManifest} from './controller.mjs';

const assert = (value, message) => { if (!value) throw new Error(message); };
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).every(key => keys.includes(key)) && keys.every(key => Object.hasOwn(value, key));
const projectId = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{7,127}$/.test(value);
const workspace = value => typeof value === 'string' && isAbsolute(value) && normalize(value) === value;
const requirements = ['prompt-preparation', 'workspace-validation', 'prior-outcomes'];

export function validateLaunchContract(state, contract) {
  validateManifest(state.manifest);
  assert(state.manifestHash === hash(state.manifest), 'Launch subject manifest changed');
  assert(exact(contract, ['schemaVersion','manifestHash','commonPromptHash','slots'])
    && contract.schemaVersion === 'whole-plugin-launch-contract-v1' && contract.manifestHash === state.manifestHash
    && digest(contract.commonPromptHash) && Array.isArray(contract.slots) && contract.slots.length === 18, 'Pin an eighteen-slot launch contract to the frozen study');
  assert(new Set(contract.slots.map(row => row.projectId)).size === 18 && new Set(contract.slots.map(row => row.workspace)).size === 18,
    'Launch projects and workspaces must be independent');
  for (const [index, pin] of contract.slots.entries()) {
    const slot = state.slots[index], task = state.manifest.tasks.find(row => row.id === slot.taskId);
    assert(exact(pin, ['slotId','projectId','workspace','baseRevision','configurationHash','promptHash'])
      && pin.slotId === slot.id && projectId(pin.projectId) && workspace(pin.workspace) && pin.baseRevision === task.baseRevision
      && pin.configurationHash === state.manifest.arms[slot.arm].configurationHash && digest(pin.promptHash), 'Launch contract slot, project, workspace or source/configuration pin is invalid');
  }
  return true;
}

export function validatePriorGrades(state, grades, slotId) {
  const before = state.slots.slice(0, state.slots.findIndex(slot => slot.id === slotId)).filter(slot => slot.status === 'COMPLETE');
  assert(Array.isArray(grades) && grades.length === before.length && new Set(grades.map(row => row.slotId)).size === grades.length,
    'Retain exactly the preceding independently graded outcomes');
  for (const slot of before) {
    const receipt = grades.find(row => row.slotId === slot.id), task = state.manifest.tasks.find(row => row.id === slot.taskId);
    const expected = slot.verdict === 'verified-fix' ? 'pass' : 'fail';
    assert(receipt?.schemaVersion === 'whole-plugin-independent-grade-v1' && receipt.patchHash === slot.patchHash
      && receipt.graderHash === task.graderHash && receipt.studyVerdict === slot.verdict
      && receipt.terminal?.verdict === expected && receipt.terminal.healthy === true
      && receipt.exitCode === (expected === 'pass' ? 0 : 1), 'Prior grade must use studyVerdict and healthy terminal, with exact patch/grader joins');
  }
  return true;
}

export function prepareNativeLaunch(state, contract, request) {
  validateLaunchContract(state, contract);
  assert(!state.halted, 'A halted study cannot prepare another native launch');
  assert(exact(request, ['schemaVersion','manifestHash','slotId','at','selected','commonPrompt','prompt','prerequisites'])
    && request.schemaVersion === 'whole-plugin-launch-preparation-v1' && request.manifestHash === state.manifestHash, 'Use structured launch preparation, never command output');
  const slot = state.slots.find(row => row.id === request.slotId);
  assert(slot?.status === 'CODING' && slot.startedAt !== null && !slot.chatId && !slot.identity && !slot.launchPreparation
    && state.slots.filter(row => ['CODING','GRADING'].includes(row.status)).length === 1
    && state.slots.find(row => !['COMPLETE','INFRASTRUCTURE_INVALID'].includes(row.status))?.id === slot.id,
    'Native launch requires the persisted next-slot start and an unoccupied native identity');
  const at = Date.parse(request.at);
  assert(Number.isFinite(at) && at >= Date.parse(state.lastAt) && at - Date.parse(slot.startedAt) <= state.manifest.policy.codingMs,
    'Launch preparation time must be observed within the existing coding clock');
  const pin = contract.slots.find(row => row.slotId === slot.id), selected = request.selected;
  assert(exact(selected, ['projectId','workspace','model','effort','baseRevision','configurationHash'])
    && selected.projectId === pin.projectId && selected.workspace === pin.workspace && selected.baseRevision === pin.baseRevision
    && selected.configurationHash === pin.configurationHash && selected.model === state.manifest.host.model && selected.effort === state.manifest.host.effort,
    'Observed native project, workspace, source, configuration and model/effort must match frozen pins');
  assert(typeof request.commonPrompt === 'string' && request.commonPrompt.trim().length >= 80
    && hash(request.commonPrompt) === contract.commonPromptHash, 'Missing or mismatched expected common coding prompt');
  assert(typeof request.prompt === 'string' && hash(request.prompt) === pin.promptHash
    && (request.prompt === request.commonPrompt || request.prompt.startsWith(`${request.commonPrompt}\n\n`))
    && !/^(?:cat:|Traceback \(|KeyError:|Error:|Command failed:)/.test(request.prompt.trimStart()), 'Native prompt must be the expected coding content, never stderr');
  assert(Array.isArray(request.prerequisites) && request.prerequisites.length === requirements.length
    && new Set(request.prerequisites.map(row => row.id)).size === requirements.length, 'Require every launch prerequisite exactly once');
  const receipts = {};
  for (const id of requirements) {
    const receipt = request.prerequisites.find(row => row.id === id);
    assert(exact(receipt, ['id','exitCode','signal','artifactHash','artifact']) && receipt.exitCode === 0 && receipt.signal === null
      && digest(receipt.artifactHash) && hash(receipt.artifact) === receipt.artifactHash, `Prerequisite ${id} must explicitly succeed with a decoded artifact`);
    receipts[id] = receipt.artifact;
  }
  const prompt = receipts['prompt-preparation'];
  assert(prompt?.schemaVersion === 'whole-plugin-prompt-ready-v1' && prompt.manifestHash === state.manifestHash && prompt.slotId === slot.id
    && prompt.commonPromptHash === contract.commonPromptHash && prompt.promptHash === pin.promptHash, 'Prompt preparation artifact does not bind expected coding content');
  const observed = receipts['workspace-validation'];
  assert(observed?.schemaVersion === 'whole-plugin-workspace-ready-v1' && observed.slotId === slot.id
    && hash(observed.selected) === hash(selected), 'Workspace prerequisite does not bind the selected native project and settings');
  const outcomes = receipts['prior-outcomes'];
  assert(outcomes?.schemaVersion === 'whole-plugin-prior-outcomes-v1', 'Prior outcome artifact schema is invalid');
  validatePriorGrades(state, outcomes.grades, slot.id);
  return {
    schemaVersion:'whole-plugin-prepared-native-launch-v1', manifestHash:state.manifestHash, stateHash:hash(state), slotId:slot.id,
    contractHash:hash(contract), at:request.at, commonPromptHash:contract.commonPromptHash, promptHash:pin.promptHash,
    prerequisiteHashes:Object.fromEntries(request.prerequisites.map(row=>[row.id,row.artifactHash])),
    nativeArgs:{target:{type:'project',projectId:pin.projectId,environment:{type:'local'}}, model:selected.model, thinking:selected.effort,
      prompt:request.prompt,title:`Jev pilot ${slot.id}`},
  };
}
