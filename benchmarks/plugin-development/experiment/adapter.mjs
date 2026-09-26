import {createHash} from 'node:crypto';

const truthKeys = new Set([
  'acceptablechoices',
  'correctchoice',
  'expectedchoice',
  'negativecontrols',
  'oracle',
  'passingaction',
  'postconditions',
  'prohibitedactions',
]);
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function rejectTruth(value, path = '$') {
  if (Array.isArray(value)) {
    value.forEach((child, index) => rejectTruth(child, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (truthKeys.has(key.toLowerCase())) throw new Error(`truth field leaked: ${path}.${key}`);
    rejectTruth(child, `${path}.${key}`);
  }
}

export function providerInput(caseInput) {
  rejectTruth(caseInput);
  const out = {
    id: caseInput.id,
    task: caseInput.task,
    state: structuredClone(caseInput.state),
    candidates: structuredClone(caseInput.candidates),
    question: caseInput.question,
  };
  rejectTruth(out);
  return out;
}
export function attemptRecord({caseInput, arm, repeat, variantHash, status = 'blocked-before-request'}) {
  const input = providerInput(caseInput);
  return {attemptId:`${caseInput.id}.r${repeat}.${arm}`, caseId:caseInput.id, repeat, arm, status, providerInputSha256:hash(input), variantHash, requestIdPresent:false, receiptIdPresent:false, actionAttempted:false, postcondition:'unmeasured', callerReportStored:false};
}
