import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {freezeStudy, reduceEvent, hash} from '../benchmarks/desktop-ranking-pilot/whole-plugin-v1/controller.mjs';
import {prepareNativeLaunch, dispatchPreparedNativeLaunch} from '../benchmarks/desktop-ranking-pilot/whole-plugin-v1/launch.mjs';

const [manifestPath, startPath, commonPath, originalPromptPath] = process.argv.slice(2);
assert.ok(manifestPath && startPath && commonPath && originalPromptPath, 'Supply existing private manifest, start, common prompt and original prompt paths');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const startEvent = JSON.parse(await readFile(startPath, 'utf8'));
const commonPrompt = await readFile(commonPath, 'utf8');
const originalPrompt = await readFile(originalPromptPath, 'utf8');
const template = `${commonPrompt}\nRecorded launch time: {{ATTEMPT_STARTED_AT}}\nCoding deadline: {{CODING_STOPS_AT}}\n`;
const frozen = freezeStudy(manifest);
const contract = {
  schemaVersion: 'whole-plugin-launch-contract-v1', manifestHash: frozen.manifestHash, commonPromptHash: hash(commonPrompt),
  slots: frozen.slots.map((slot, index) => ({
    slotId: slot.id, projectId: `synthetic-project-${index}`, workspace: `/synthetic/benchmark-${index}`,
    baseRevision: manifest.tasks.find(task => task.id === slot.taskId).baseRevision,
    configurationHash: manifest.arms[slot.arm].configurationHash, promptTemplateHash: hash(template),
  })),
};
const frozenContractHash = hash(contract);
const outputs = [];
for (const offset of [0, 86400000]) {
  const at = offset ? new Date(Date.parse(startEvent.at) + offset).toISOString() : startEvent.at;
  const state = reduceEvent(frozen, {...startEvent, at});
  const slot = state.slots[0], pin = contract.slots[0];
  const selected = {projectId: pin.projectId, workspace: pin.workspace, model: manifest.host.model, effort: manifest.host.effort,
    baseRevision: pin.baseRevision, configurationHash: pin.configurationHash};
  const artifacts = {
    'prompt-preparation': {schemaVersion: 'whole-plugin-prompt-ready-v1', manifestHash: state.manifestHash, slotId: slot.id,
      commonPromptHash: contract.commonPromptHash, promptTemplateHash: pin.promptTemplateHash},
    'workspace-validation': {schemaVersion: 'whole-plugin-workspace-ready-v1', slotId: slot.id, selected},
    'prior-outcomes': {schemaVersion: 'whole-plugin-prior-outcomes-v1', grades: []},
  };
  const prepared = prepareNativeLaunch(state, contract, {
    schemaVersion: 'whole-plugin-launch-preparation-v1', manifestHash: state.manifestHash, slotId: slot.id,
    at: new Date(Date.parse(at) + 1).toISOString(), selected, commonPrompt, promptTemplate: template,
    prerequisites: Object.entries(artifacts).map(([id, artifact]) => ({id, exitCode: 0, signal: null, artifactHash: hash(artifact), artifact})),
  });
  assert.ok(prepared.nativeArgs.prompt.startsWith(`${commonPrompt}\nRecorded launch time: `));
  const deadline = prepared.nativeArgs.prompt.match(/Coding deadline: ([^\n]+)\n$/)[1];
  assert.equal(Date.parse(deadline) - Date.parse(at), 2100000);
  if (!offset) assert.equal(Date.parse(deadline), Date.parse(originalPrompt.match(/Coding deadline: ([^\n]+)\n$/)[1]));
  assert.equal(hash(contract), frozenContractHash);
  let calls = 0;
  await assert.rejects(dispatchPreparedNativeLaunch({exit_code: 1, output: 'cat: missing-prompt.txt: No such file or directory'}, async () => {calls++;}));
  assert.equal(calls, 0);
  const payload = {...prepared, artifact: '/synthetic/prepared.json', preparationHash: hash(prepared)};
  await dispatchPreparedNativeLaunch({exit_code: 0, output: JSON.stringify(payload)}, async args => {calls++; assert.deepEqual(args, prepared.nativeArgs);});
  assert.equal(calls, 1);
  outputs.push(prepared.nativeArgs.prompt);
}
assert.notEqual(outputs[0], outputs[1]);
console.log(JSON.stringify({scope: 'pure validation and stub dispatch only; no native coding call',
  preservedRealCommonPrompt: true, preservedTrailingNewline: commonPrompt.endsWith('\n'),
  distinctStartsSameFrozenContract: true, deadlineMinutes: 35, originalDeadlineInstantPreserved: true,
  failedCommandStubDispatches: 0, validCommandStubDispatchesPerCase: 1}, null, 2));
