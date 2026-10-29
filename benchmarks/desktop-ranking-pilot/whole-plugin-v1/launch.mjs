import {isAbsolute, normalize} from 'node:path';
import {ARMS, TASK_IDS, hash, validateManifest} from './controller.mjs';

const assert = (value, message) => { if (!value) throw new Error(message); };
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).every(key => keys.includes(key)) && keys.every(key => Object.hasOwn(value, key));
const projectId = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{7,127}$/.test(value);
const workspace = value => typeof value === 'string' && isAbsolute(value) && normalize(value) === value;
const requirements = ['prompt-preparation', 'workspace-validation', 'prior-outcomes'];
const timeTokens = ['{{ATTEMPT_STARTED_AT}}','{{CODING_STOPS_AT}}'];

export function renderPromptTemplate(template, startedAt, codingMs) {
  assert(typeof template === 'string' && timeTokens.every(token=>template.split(token).length===2)
    && !template.replaceAll(timeTokens[0],'').replaceAll(timeTokens[1],'').match(/\{\{[^}]+\}\}/), 'Freeze one start token and one deadline token in the coding prompt template');
  const start=Date.parse(startedAt);
  assert(Number.isFinite(start) && codingMs===2100000, 'Render prompt timing only from the persisted 35-minute attempt start');
  return template.replace(timeTokens[0],startedAt).replace(timeTokens[1],new Date(start+codingMs).toISOString());
}

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
    assert(exact(pin, ['slotId','projectId','workspace','baseRevision','configurationHash','promptTemplateHash'])
      && pin.slotId === slot.id && projectId(pin.projectId) && workspace(pin.workspace) && pin.baseRevision === task.baseRevision
      && pin.configurationHash === state.manifest.arms[slot.arm].configurationHash && digest(pin.promptTemplateHash), 'Launch contract slot, project, workspace or source/configuration pin is invalid');
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
  assert(exact(request, ['schemaVersion','manifestHash','slotId','at','selected','commonPrompt','promptTemplate','prerequisites'])
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
  assert(typeof request.promptTemplate === 'string' && hash(request.promptTemplate) === pin.promptTemplateHash
    && request.promptTemplate.startsWith(request.commonPrompt)
    && !/^(?:cat:|Traceback \(|KeyError:|Error:|Command failed:)/.test(request.promptTemplate.trimStart()), 'Native prompt template must preserve the expected common coding content, never stderr');
  const renderedPrompt=renderPromptTemplate(request.promptTemplate,slot.startedAt,state.manifest.policy.codingMs);
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
    && prompt.commonPromptHash === contract.commonPromptHash && prompt.promptTemplateHash === pin.promptTemplateHash, 'Prompt preparation artifact does not bind expected coding content');
  const observed = receipts['workspace-validation'];
  assert(observed?.schemaVersion === 'whole-plugin-workspace-ready-v1' && observed.slotId === slot.id
    && hash(observed.selected) === hash(selected), 'Workspace prerequisite does not bind the selected native project and settings');
  const outcomes = receipts['prior-outcomes'];
  assert(outcomes?.schemaVersion === 'whole-plugin-prior-outcomes-v1', 'Prior outcome artifact schema is invalid');
  validatePriorGrades(state, outcomes.grades, slot.id);
  return {
    schemaVersion:'whole-plugin-prepared-native-launch-v1', manifestHash:state.manifestHash, stateHash:hash(state), slotId:slot.id,
    contractHash:hash(contract), at:request.at, commonPromptHash:contract.commonPromptHash, promptTemplateHash:pin.promptTemplateHash, promptHash:hash(renderedPrompt),
    prerequisiteHashes:Object.fromEntries(request.prerequisites.map(row=>[row.id,row.artifactHash])),
    nativeArgs:{target:{type:'project',projectId:pin.projectId,environment:{type:'local'}}, model:selected.model, thinking:selected.effort,
      prompt:renderedPrompt,title:`Jev pilot ${slot.id}`},
  };
}

export async function dispatchPreparedNativeLaunch(commandResult, createThread) {
  assert(commandResult?.exit_code===0 && !commandResult.session_id && typeof commandResult.output==='string', 'Native dispatch requires an explicitly successful completed preparation command');
  let payload;
  try { payload=JSON.parse(commandResult.output); } catch { throw new Error('Native preparation output must be one structured JSON result, never stdout/stderr prompt text'); }
  assert(exact(payload,['schemaVersion','manifestHash','stateHash','slotId','contractHash','at','commonPromptHash','promptTemplateHash','promptHash','prerequisiteHashes','nativeArgs','artifact','preparationHash'])
    && payload.schemaVersion==='whole-plugin-prepared-native-launch-v1'
    && ['manifestHash','stateHash','contractHash','commonPromptHash','promptTemplateHash','promptHash','preparationHash'].every(key=>digest(payload[key]))
    && TASK_IDS.some(task=>ARMS.some(arm=>payload.slotId===`${task}.${arm}`)) && Number.isFinite(Date.parse(payload.at))
    && workspace(payload.artifact) && exact(payload.prerequisiteHashes,requirements) && Object.values(payload.prerequisiteHashes).every(digest), 'Native dispatch requires the expected prepared launch schema and hashes');
  const {artifact,preparationHash,...prepared}=payload;
  assert(hash(prepared)===preparationHash, 'Prepared native launch content changed');
  const args=payload.nativeArgs;
  assert(exact(args,['target','model','thinking','prompt','title']) && exact(args.target,['type','projectId','environment'])
    && args.target.type==='project' && projectId(args.target.projectId) && exact(args.target.environment,['type']) && args.target.environment.type==='local'
    && args.model==='gpt-6.1-sol' && args.thinking==='ultra' && typeof args.prompt==='string' && args.prompt.trim().length>=80
    && hash(args.prompt)===payload.promptHash && args.title===`Jev pilot ${payload.slotId}` && typeof createThread==='function', 'Native dispatch arguments must match the prepared local fixed-model launch');
  return await createThread(structuredClone(args));
}
