#!/usr/bin/env node

import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

/**
 * Dependency-free paired binary-outcome analysis.
 *
 * Input is deliberately smaller than a runner receipt:
 * {taskId, controlPassed: boolean|null, treatmentPassed: boolean|null}
 *
 * null means that the arm had no usable task-quality outcome (for example an
 * infrastructure failure). It is retained in the scheduled denominator and
 * excluded from complete-pair inference. No timing, token, or cost fields are
 * accepted or inferred here.
 */

export const STATISTICS_SCHEMA_VERSION = 'jev-paired-statistics-v1';
export const DEFAULT_BOOTSTRAP_SAMPLES = 10_000;
export const DEFAULT_BOOTSTRAP_SEED = 'jev-paired-statistics-v1';
export const EXPLORATORY_SMALL_N_THRESHOLD = 30;

function fail(message) {
  throw new TypeError(message);
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function rate(numerator, denominator) {
  return denominator === 0 ? null : numerator / denominator;
}

function sortedPercentile(values, percentile) {
  if (values.length === 0) return null;
  const position = (values.length - 1) * percentile;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return values[lower];
  return values[lower] + (values[upper] - values[lower]) * (position - lower);
}

// Lanczos log-gamma keeps exact-tail computation useful beyond the range in
// which 2**(-n) can be represented directly. The test statistic remains the
// exact binomial tail definition; this only supplies its floating-point value.
function logGamma(value) {
  const coefficients = [
    676.5203681218851,
    -1259.1392167224028,
    771.32342877765313,
    -176.61502916214059,
    12.507343278686905,
    -0.13857109526572012,
    9.9843695780195716e-6,
    1.5056327351493116e-7,
  ];
  if (value < 0.5) return Math.log(Math.PI) - Math.log(Math.sin(Math.PI * value)) - logGamma(1 - value);
  const adjusted = value - 1;
  let sum = 0.99999999999980993;
  for (let index = 0; index < coefficients.length; index += 1) sum += coefficients[index] / (adjusted + index + 1);
  const t = adjusted + coefficients.length - 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (adjusted + 0.5) * Math.log(t) - t + Math.log(sum);
}

function logBinomialProbability(n, successes) {
  return logGamma(n + 1) - logGamma(successes + 1) - logGamma(n - successes + 1) - n * Math.log(2);
}

function exactTwoSidedMcNemar(controlOnly, treatmentOnly, validPairs) {
  if (validPairs === 0) return null;
  const discordant = controlOnly + treatmentOnly;
  if (discordant === 0) return 1;
  const smallerTail = Math.min(controlOnly, treatmentOnly);
  const logTerms = [];
  for (let successes = 0; successes <= smallerTail; successes += 1) logTerms.push(logBinomialProbability(discordant, successes));
  const maxLog = Math.max(...logTerms);
  const tail = Math.exp(maxLog) * logTerms.reduce((sum, value) => sum + Math.exp(value - maxLog), 0);
  return Math.min(1, Math.max(0, 2 * tail));
}

function seedToUint32(seed) {
  let hash = 2166136261;
  for (const character of seed) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0 || 1;
}

function xorshift32(seed) {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x1_0000_0000;
  };
}

function bootstrapCompletePairs(rows, samples, seed) {
  if (rows.length === 0) return {lower: null, upper: null, values: [], allTies: false, reason: 'no_complete_pairs'};
  const random = xorshift32(seedToUint32(seed));
  const values = [];
  for (let sample = 0; sample < samples; sample += 1) {
    let controlPasses = 0;
    let treatmentPasses = 0;
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[Math.floor(random() * rows.length)];
      if (row.controlPassed) controlPasses += 1;
      if (row.treatmentPassed) treatmentPasses += 1;
    }
    values.push((treatmentPasses - controlPasses) / rows.length);
  }
  values.sort((left, right) => left - right);
  const allTies = values.every((value) => value === values[0]);
  return {
    lower: sortedPercentile(values, 0.025),
    upper: sortedPercentile(values, 0.975),
    values,
    allTies,
    reason: allTies ? 'all_bootstrap_statistics_tied' : null,
  };
}

function validateRows(rows) {
  if (!Array.isArray(rows) || rows.length === 0) fail('pairs must be a non-empty array');
  const seen = new Set();
  return rows.map((row, index) => {
    if (!isObject(row)) fail(`pairs[${index}] must be an object`);
    if (typeof row.taskId !== 'string' || row.taskId.length === 0) fail(`pairs[${index}].taskId must be a non-empty string`);
    if (seen.has(row.taskId)) fail(`duplicate taskId: ${row.taskId}`);
    seen.add(row.taskId);
    for (const field of ['controlPassed', 'treatmentPassed']) {
      if (typeof row[field] !== 'boolean' && row[field] !== null) fail(`pairs[${index}].${field} must be boolean or null`);
    }
    return {taskId: row.taskId, controlPassed: row.controlPassed, treatmentPassed: row.treatmentPassed};
  });
}

function armSummary(rows, field) {
  const passes = rows.filter((row) => row[field] === true).length;
  const missing = rows.filter((row) => row[field] === null).length;
  const known = rows.length - missing;
  return {
    passes,
    scheduled: rows.length,
    known,
    missing,
    passesOverScheduled: rate(passes, rows.length),
    knownPassRate: rate(passes, known),
  };
}

export function analyzePairs(input, options = {}) {
  const rows = validateRows(input);
  const bootstrapSamples = options.bootstrapSamples ?? DEFAULT_BOOTSTRAP_SAMPLES;
  const bootstrapSeed = options.bootstrapSeed ?? DEFAULT_BOOTSTRAP_SEED;
  if (!Number.isSafeInteger(bootstrapSamples) || bootstrapSamples < 1) fail('bootstrapSamples must be a positive safe integer');
  if (typeof bootstrapSeed !== 'string' || bootstrapSeed.length === 0) fail('bootstrapSeed must be a non-empty string');

  const complete = rows.filter((row) => row.controlPassed !== null && row.treatmentPassed !== null);
  const missing = rows.length - complete.length;
  const bothPass = complete.filter((row) => row.controlPassed && row.treatmentPassed).length;
  const controlOnly = complete.filter((row) => row.controlPassed && !row.treatmentPassed).length;
  const treatmentOnly = complete.filter((row) => !row.controlPassed && row.treatmentPassed).length;
  const neither = complete.filter((row) => !row.controlPassed && !row.treatmentPassed).length;
  const control = armSummary(rows, 'controlPassed');
  const treatment = armSummary(rows, 'treatmentPassed');
  const controlCompleteRate = rate(bothPass + controlOnly, complete.length);
  const treatmentCompleteRate = rate(bothPass + treatmentOnly, complete.length);
  const completeDifference = controlCompleteRate === null || treatmentCompleteRate === null
    ? null
    : treatmentCompleteRate - controlCompleteRate;
  const controlLower = rate(control.passes, rows.length);
  const controlUpper = rate(control.passes + control.missing, rows.length);
  const treatmentLower = rate(treatment.passes, rows.length);
  const treatmentUpper = rate(treatment.passes + treatment.missing, rows.length);
  const bootstrap = bootstrapCompletePairs(complete, bootstrapSamples, bootstrapSeed);
  const smallSample = complete.length <= EXPLORATORY_SMALL_N_THRESHOLD;
  const bootstrapInterpretation = bootstrap.reason === 'no_complete_pairs'
    ? 'No complete pairs; the percentile interval is not estimable.'
    : bootstrap.allTies
      ? 'Degenerate resampling interval; this is not evidence of equivalence or zero uncertainty.'
      : 'Descriptive percentile interval for this frozen task set; exploratory for small valid-pair counts and not a universal confidence claim.';

  return {
    schemaVersion: STATISTICS_SCHEMA_VERSION,
    scheduled: rows.length,
    valid: complete.length,
    missing,
    scheduledPairs: rows.length,
    validPairs: complete.length,
    missingPairs: missing,
    pairCounts: {scheduled: rows.length, valid: complete.length, missing},
    pairOutcomes: {bothPass, controlOnly, treatmentOnly, neither},
    operationalPasses: {control, treatment},
    completePairDifference: {
      statistic: 'treatment pass rate minus control pass rate among valid complete pairs',
      controlPassRate: controlCompleteRate,
      treatmentPassRate: treatmentCompleteRate,
      treatmentMinusControl: completeDifference,
    },
    mcnemarExact: {
      test: 'two-sided exact binomial on discordant complete pairs',
      status: complete.length === 0 ? 'not_testable' : 'tested',
      notTestableReason: complete.length === 0 ? 'no_complete_pairs' : null,
      controlOnly,
      treatmentOnly,
      discordant: controlOnly + treatmentOnly,
      pValue: exactTwoSidedMcNemar(controlOnly, treatmentOnly, complete.length),
    },
    missingnessBounds: {
      interpretation: 'Extreme pass-rate bounds assign every missing arm outcome false or true; scheduled remains the denominator.',
      control: {lower: controlLower, upper: controlUpper},
      treatment: {lower: treatmentLower, upper: treatmentUpper},
      treatmentMinusControl: {
        lower: treatmentLower - controlUpper,
        upper: treatmentUpper - controlLower,
      },
    },
    bootstrap95Percentile: {
      statistic: 'treatment minus control pass-rate among complete pairs',
      samples: bootstrapSamples,
      seed: bootstrapSeed,
      lower: bootstrap.lower,
      upper: bootstrap.upper,
      allTies: bootstrap.allTies,
      degeneracyReason: bootstrap.reason,
      smallNSampleThreshold: EXPLORATORY_SMALL_N_THRESHOLD,
      exploratorySmallN: smallSample,
      interpretation: bootstrapInterpretation,
    },
  };
}

async function main() {
  const [inputPath, outputPath] = process.argv.slice(2);
  if (!inputPath || process.argv.length > 4) {
    throw new Error('Usage: node paired-statistics.mjs <pairs.json> [output.json]');
  }
  const {readFile, writeFile} = await import('node:fs/promises');
  const result = analyzePairs(JSON.parse(await readFile(inputPath, 'utf8')));
  const bytes = `${JSON.stringify(result, null, 2)}\n`;
  if (outputPath) await writeFile(outputPath, bytes, {flag: 'wx'});
  else process.stdout.write(bytes);
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? '')).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
