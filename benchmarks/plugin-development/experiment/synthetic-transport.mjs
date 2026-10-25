const passingChoice = Object.freeze({
  'candidate-normal': 'run-focused-test',
  'candidate-conflict': 'no_fit',
  'candidate-stale': 'run-new-test',
  'candidate-adversarial': 'run-local-check',
});

function probabilities(ids, choice, selectedProbability = 0.94) {
  const remainderIds = ids.filter(id => id !== choice);
  const remainder = remainderIds.length === 0 ? 0 : (1 - selectedProbability) / remainderIds.length;
  return Object.fromEntries(ids.map(id => [id, id === choice ? selectedProbability : remainder]));
}

/** A deterministic Response-compatible transport for plumbing tests only. */
export function deterministicTransport({caseId, scenario = 'passing', choice: explicitChoice, responseModel} = {}) {
  return async (_url, init) => {
    const payload = JSON.parse(String(init?.body ?? ''));
    const question = payload.questions?.decision;
    if (!question || question.type !== 'choice' || !question.criteria || typeof question.criteria !== 'object') {
      return new Response(JSON.stringify({syntheticError: 'missing decision question'}), {status: 500});
    }
    const ids = Object.keys(question.criteria);
    let choice = explicitChoice ?? passingChoice[caseId];
    let confidence = 0.98;
    let probability = 0.94;
    if (scenario === 'abstention') choice = 'insufficient_evidence';
    if (scenario === 'low-confidence') { confidence = 0.2; probability = 0.94; }
    if (scenario === 'foreign') choice = 'foreign-candidate';
    if (!choice) throw new Error(`no deterministic plumbing choice for ${caseId}`);
    const responseIds = scenario === 'foreign' ? ids : ids.includes(choice) ? ids : [...ids, choice];
    const body = {
      // The provider contract requires the echoed requested model identifier.
      // The enclosing transport label records that this response is synthetic.
      model: responseModel ?? payload.model,
      answers: {
        decision: {
          type: 'choice',
          choice,
          probabilities: probabilities(responseIds, choice, probability),
          confidence,
        },
      },
      usage: {input_tokens: 100, output_tokens: 20},
    };
    // Deliberately omit provider request-ID headers. This mode is local plumbing
    // evidence and must never create a provider-ID claim.
    return new Response(JSON.stringify(body), {status: 200, headers: {'content-type': 'application/json'}});
  };
}

export {passingChoice};
