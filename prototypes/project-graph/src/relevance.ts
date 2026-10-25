import {RELEVANCE_LEVELS, type RelevanceAssessment} from './types.js';

export function expectedRelevance(answer: RelevanceAssessment): number {
  if (!answer || !RELEVANCE_LEVELS.includes(answer.providerChoice) || !answer.probabilities ||
    Object.keys(answer.probabilities).length !== RELEVANCE_LEVELS.length) throw new Error('invalid_relevance_answer');
  let expected = 0;
  let sum = 0;
  let maximum = 0;
  for (let level = 0; level < RELEVANCE_LEVELS.length; level += 1) {
    const probability = answer.probabilities[RELEVANCE_LEVELS[level]!];
    if (!Number.isFinite(probability) || probability < 0 || probability > 1) throw new Error('invalid_relevance_answer');
    sum += probability;
    maximum = Math.max(maximum, probability);
    expected += level * probability;
  }
  if (Math.abs(sum - 1) > 0.001 || answer.probabilities[answer.providerChoice] + 0.000001 < maximum) throw new Error('invalid_relevance_answer');
  return expected;
}

