#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';

export const JEV_INPUT_RATE_USD_PER_MILLION = 0.042;
export const JEV_COST_SOURCE = 'https://docs.typesafe.ai/models';
export const JEV_COST_VERIFIED_ON = '2026-10-16';

const finite = value => typeof value === 'number' && Number.isFinite(value);
const numberOrNull = value => finite(value) ? value : null;
const median = values => {
  const xs = values.filter(finite).sort((a, b) => a - b);
  if (!xs.length) return null;
  const middle = Math.floor(xs.length / 2);
  return xs.length % 2 ? xs[middle] : (xs[middle - 1] + xs[middle]) / 2;
};
const range = values => {
  const xs = values.filter(finite);
  return xs.length ? { min: Math.min(...xs), max: Math.max(...xs) } : { min: null, max: null };
};
const unique = values => [...new Set(values.filter(value => value !== null && value !== undefined && value !== ''))];
const idOf = value => typeof value === 'string' ? value : value && typeof value.id === 'string' ? value.id : null;
const idArray = value => Array.isArray(value) ? unique(value.map(idOf)) : [];

function readUsage(result) {
  const usage = result?.receipt?.usage ?? result?.usage ?? {};
  return {
    inputTokens: numberOrNull(usage.inputTokens ?? usage.input_tokens),
    cachedInputTokens: numberOrNull(usage.cachedInputTokens ?? usage.cacheReadInputTokens ?? usage.cache_read_input_tokens),
    cacheCreationTokens: numberOrNull(usage.cacheCreationTokens ?? usage.cache_creation_input_tokens),
    outputTokens: numberOrNull(usage.outputTokens ?? usage.output_tokens),
    reasoningTokens: numberOrNull(usage.reasoningTokens ?? usage.reasoning_tokens),
  };
}

function readCost(result) {
  const cost = result?.receipt?.cost ?? result?.cost ?? {};
  return {
    reportedUsd: numberOrNull(cost.reportedUsd ?? cost.reported_usd ?? cost.totalCostUsd ?? cost.total_cost_usd),
    estimatedUsd: numberOrNull(cost.estimatedUsd ?? cost.estimated_usd),
    billedUsd: numberOrNull(cost.billedUsd ?? cost.billed_usd),
  };
}

function readJev(result) {
  const jev = result?.receipt?.jev ?? result?.jev ?? {};
  const requestIds = idArray(jev.requestIds ?? jev.request_ids);
  // Claude reports deliveryReceipts as a numeric count; it is not an ID list.
  // Only arrays contribute to unique delivery identity accounting.
  const deliveryIds = idArray(jev.deliveryReceiptIds ?? jev.deliveryIds ?? jev.delivery_ids);
  const usage = jev.usage ?? {};
  const inputTokens = numberOrNull(usage.inputTokens ?? usage.input_tokens ?? jev.inputTokens ?? jev.input_tokens);
  const abstentions = numberOrNull(jev.abstentions);
  return {
    requestIds,
    deliveryIds,
    inputTokens,
    abstentions,
    attempts: numberOrNull(jev.attempts),
    responses: numberOrNull(jev.responses),
    deliveryReceipts: numberOrNull(jev.deliveryReceipts),
    adviceDeliveries: numberOrNull(jev.adviceDeliveries ?? jev.advice_deliveries),
  };
}

function resultFacts(result) {
  const receipt = result?.receipt ?? {};
  const hostCompleted = typeof result?.hostCompleted === 'boolean'
    ? result.hostCompleted
    : typeof result?.completed === 'boolean' ? result.completed
      : receipt.completion === true || receipt.completed === true;
  const artifactCorrect = typeof result?.artifactCorrect === 'boolean'
    ? result.artifactCorrect
    : result?.grade?.passed === true;
  const invalid = result?.validity?.valid === false || result?.validity?.status === 'invalid';
  const timeout = result?.timeout === true || result?.timedOut === true || receipt.timeout === true || receipt.timedOut === true || result?.error?.kind === 'timeout' || result?.error?.code === 'TIMEOUT';
  const aborted = result?.aborted === true || receipt.aborted === true || result?.interrupted === true || receipt.interrupted === true;
  const wallMs = numberOrNull(result?.totalWallMs ?? result?.wallMs ?? receipt.wallMs);
  return { hostCompleted, artifactCorrect, invalid, timeout, aborted, wallMs, usage: readUsage(result), cost: readCost(result), jev: readJev(result) };
}

function validatePlan(plan, source) {
  if (!plan || !Array.isArray(plan.schedule)) throw new Error(`${source}: plan.json has no schedule`);
  const ids = new Set();
  const coords = new Set();
  for (const row of plan.schedule) {
    if (!row?.id) throw new Error(`${source}: scheduled row is missing id`);
    if (ids.has(row.id)) throw new Error(`${source}: duplicate scheduled id ${row.id}`);
    ids.add(row.id);
    const coordinate = [row.host, row.taskId, row.repetition, row.arm].join('\u0000');
    if (coords.has(coordinate)) throw new Error(`${source}: duplicate scheduled coordinate ${coordinate}`);
    coords.add(coordinate);
  }
}

async function loadCohort(outputDir) {
  const source = path.resolve(outputDir);
  const plan = JSON.parse(await fs.readFile(path.join(source, 'plan.json'), 'utf8'));
  validatePlan(plan, source);
  const rows = [];
  const seen = new Set();
  const seenRunIds = new Set();
  for (const scheduled of plan.schedule) {
    const resultPath = path.join(source, 'trials', scheduled.id, 'result.json');
    let result = null;
    try { result = JSON.parse(await fs.readFile(resultPath, 'utf8')); } catch (error) {
      if (error.code !== 'ENOENT') throw new Error(`${source}: cannot read ${resultPath}: ${error.message}`);
    }
    if (result) {
      const resultId = result.id ?? result.runId ?? scheduled.id;
      if (seen.has(resultId)) throw new Error(`${source}: duplicate result id ${resultId}`);
      seen.add(resultId);
      if (result.runId) {
        if (seenRunIds.has(result.runId)) throw new Error(`${source}: duplicate result id ${result.runId}`);
        seenRunIds.add(result.runId);
      }
      if (result.id && result.id !== scheduled.id && result.runId !== scheduled.id) throw new Error(`${source}: result identity mismatch for ${scheduled.id}`);
    }
    rows.push({ cohort: source, scheduled, result, facts: result ? resultFacts(result) : null });
  }
  return { source, plan, rows };
}

function hostTokenSemantics(host) {
  if (host === 'codex') return { cachedInput: 'inclusive_subset_of_input', cacheCreation: 'not_reported' };
  if (host === 'claude') return { cachedInput: 'disjoint_cache_read', cacheCreation: 'disjoint_cache_creation' };
  return { cachedInput: 'provider_declared_do_not_add', cacheCreation: 'provider_declared' };
}

function aggregateUsage(entries, host) {
  const metrics = ['inputTokens', 'cachedInputTokens', 'cacheCreationTokens', 'outputTokens', 'reasoningTokens'];
  const usage = { semantics: hostTokenSemantics(host), coverage: {}, totals: {} };
  for (const metric of metrics) {
    const values = entries.map(entry => entry.facts?.usage?.[metric]);
    const known = values.filter(finite);
    usage.coverage[metric] = { known: known.length, total: entries.length };
    usage.totals[metric] = known.length ? known.reduce((a, b) => a + b, 0) : null;
  }
  if (host === 'claude') {
    // Anthropic's inputTokens is the uncached category; cache read and cache
    // creation are reported separately and must be added to derive total input.
    const uncached = entries.map(entry => entry.facts?.usage?.inputTokens);
    const known = uncached.filter(finite);
    usage.coverage.uncachedInputTokens = { known: known.length, total: entries.length };
    usage.totals.uncachedInputTokens = known.length ? known.reduce((a, b) => a + b, 0) : null;
    const totalInput = entries.map(entry => {
      const u = entry.facts?.usage;
      if (!u || !finite(u.inputTokens) || !finite(u.cachedInputTokens) || !finite(u.cacheCreationTokens)) return null;
      return u.inputTokens + u.cachedInputTokens + u.cacheCreationTokens;
    }).filter(finite);
    usage.coverage.totalInputTokens = { known: totalInput.length, total: entries.length };
    usage.totals.totalInputTokens = totalInput.length ? totalInput.reduce((a, b) => a + b, 0) : null;
  }
  return usage;
}

function aggregateJev(entries, scheduledCount) {
  const requestIds = unique(entries.flatMap(entry => entry.facts?.jev?.requestIds ?? []));
  const deliveryIds = unique(entries.flatMap(entry => entry.facts?.jev?.deliveryIds ?? []));
  const usageValues = entries.map(entry => entry.facts?.jev?.inputTokens);
  const knownUsage = usageValues.filter(finite);
  const reportedAbstentions = entries.map(entry => entry.facts?.jev?.abstentions).filter(finite);
  return {
    uniqueProviderRequests: requestIds.length,
    providerRequestIdCoverage: { rowsWithIds: entries.filter(entry => entry.facts?.jev?.requestIds?.length).length, rows: entries.length },
    uniqueDeliveries: deliveryIds.length,
    deliveryIdCoverage: { rowsWithIds: entries.filter(entry => entry.facts?.jev?.deliveryIds?.length).length, rows: entries.length },
    reportedDeliveryReceipts: entries.map(entry => entry.facts?.jev?.deliveryReceipts).filter(finite).length
      ? entries.map(entry => entry.facts?.jev?.deliveryReceipts).filter(finite).reduce((a, b) => a + b, 0) : null,
    reportedAdviceDeliveries: entries.map(entry => entry.facts?.jev?.adviceDeliveries).filter(finite).length
      ? entries.map(entry => entry.facts?.jev?.adviceDeliveries).filter(finite).reduce((a, b) => a + b, 0) : null,
    abstentions: reportedAbstentions.length ? reportedAbstentions.reduce((a, b) => a + b, 0) : null,
    abstentionCoverage: { rowsWithValue: reportedAbstentions.length, rows: entries.length },
    usage: { inputTokens: knownUsage.length ? knownUsage.reduce((a, b) => a + b, 0) : null, coverage: { known: knownUsage.length, rows: entries.length } },
    estimatedInputCost: knownUsage.length === scheduledCount && scheduledCount > 0 ? {
      kind: 'estimated_not_billed',
      inputRateUsdPerMillion: JEV_INPUT_RATE_USD_PER_MILLION,
      inputUsd: knownUsage.reduce((a, b) => a + b, 0) * JEV_INPUT_RATE_USD_PER_MILLION / 1_000_000,
      outputUsd: 0,
      source: JEV_COST_SOURCE,
      verifiedOn: JEV_COST_VERIFIED_ON,
    } : null,
  };
}

function aggregateCost(entries, scheduledCount) {
  const result = {};
  for (const metric of ['reportedUsd', 'estimatedUsd', 'billedUsd']) {
    const values = entries.map(entry => entry.facts?.cost?.[metric]);
    const known = values.filter(finite);
    result[metric] = { value: known.length === scheduledCount && scheduledCount > 0 ? known.reduce((a, b) => a + b, 0) : null, knownSubtotal: known.length ? known.reduce((a, b) => a + b, 0) : null, known: known.length, rows: entries.length, scheduled: scheduledCount };
  }
  return result;
}

function summarizeGroup(entries, scheduledCount, host) {
  const facts = entries.map(entry => entry.facts);
  const times = facts.map(f => f?.wallMs).filter(finite);
  return {
    scheduled: scheduledCount,
    resultRows: entries.length,
    completed: facts.filter(f => f?.hostCompleted).length,
    correct: facts.filter(f => f?.artifactCorrect).length,
    invalid: facts.filter(f => f?.invalid).length,
    missing: scheduledCount - entries.length,
    timeout: facts.filter(f => f?.timeout).length,
    aborted: facts.filter(f => f?.aborted && !f?.timeout).length,
    wallMs: { median: median(times), ...range(times), known: times.length, rows: entries.length },
    usage: aggregateUsage(entries, host),
    jev: aggregateJev(entries, scheduledCount),
    cost: aggregateCost(entries, scheduledCount),
  };
}

function pairedTimes(rows) {
  const byCoordinate = new Map();
  for (const row of rows) {
    const key = [row.cohort, row.scheduled.host, row.scheduled.taskId, row.scheduled.repetition].join('\u0000');
    const bucket = byCoordinate.get(key) ?? {};
    bucket[row.scheduled.arm] = row;
    byCoordinate.set(key, bucket);
  }
  const deltas = [];
  for (const bucket of byCoordinate.values()) {
    const off = bucket.off?.facts?.wallMs;
    const on = bucket.on?.facts?.wallMs;
    if (finite(off) && finite(on)) deltas.push(on - off);
  }
  return { count: deltas.length, median: median(deltas), ...range(deltas), deltas };
}

function modelSummary(rows) {
  const receipt = row => row.result?.receipt ?? {};
  const requested = unique(rows.map(row => row.result?.requestedModel ?? receipt(row).requestedModel ?? row.scheduled.requestedModel ?? row.scheduled.settings?.model));
  const resolved = unique(rows.map(row => row.result?.resolvedModel ?? receipt(row).resolvedModel ?? row.scheduled.resolvedModel ?? row.scheduled.settings?.resolvedModel));
  const requestedEffort = unique(rows.map(row => row.result?.requestedEffort ?? receipt(row).requestedEffort ?? row.scheduled.requestedEffort ?? row.scheduled.settings?.effort));
  const resolvedEffort = unique(rows.map(row => row.result?.resolvedEffort ?? receipt(row).resolvedEffort ?? row.scheduled.resolvedEffort ?? row.scheduled.settings?.resolvedEffort));
  return { requested, resolved, requestedEffort, resolvedEffort, resolvedMatch: resolved.length <= 1 };
}

export function analyzeCohorts(cohorts) {
  const rows = cohorts.flatMap(cohort => cohort.rows).map(row => ({
    ...row,
    facts: row.result ? (row.facts ?? resultFacts(row.result)) : null,
  }));
  const hosts = unique(rows.map(row => row.scheduled.host));
  const arms = ['off', 'on'];
  const byHost = {};
  for (const host of hosts) {
    byHost[host] = {};
    for (const arm of arms) {
      const scheduled = rows.filter(row => row.scheduled.host === host && row.scheduled.arm === arm);
      const observed = scheduled.filter(row => row.result);
      byHost[host][arm] = summarizeGroup(observed, scheduled.length, host);
    }
    byHost[host].pairedTimeMs = pairedTimes(rows.filter(row => row.scheduled.host === host));
    byHost[host].models = modelSummary(rows.filter(row => row.scheduled.host === host));
    byHost[host].tasks = {};
    for (const taskId of unique(rows.filter(row => row.scheduled.host === host).map(row => row.scheduled.taskId))) {
      byHost[host].tasks[taskId] = {};
      for (const arm of arms) {
        const scheduled = rows.filter(row => row.scheduled.host === host && row.scheduled.taskId === taskId && row.scheduled.arm === arm);
        byHost[host].tasks[taskId][arm] = summarizeGroup(scheduled.filter(row => row.result), scheduled.length, host);
      }
      byHost[host].tasks[taskId].pairedTimeMs = pairedTimes(rows.filter(row => row.scheduled.host === host && row.scheduled.taskId === taskId));
    }
  }
  return {
    schema: 'jev-agent-quality-analysis-v1',
    generatedAt: new Date().toISOString(),
    policy: { schedulePreserved: true, repeatedTaskLabelsAreClusters: true, outcomeTuning: 'none' },
    costNotes: { unknownIsNull: true, jevEstimate: 'input tokens only; output free; estimated, not billed' },
    cohorts: cohorts.map(cohort => ({ source: cohort.source, phase: cohort.plan.phase ?? null, identity: cohort.plan.identity ?? null, scheduled: cohort.rows.length })),
    hosts: byHost,
  };
}

export async function analyzeOutputDirs(outputDirs) {
  if (!Array.isArray(outputDirs) || !outputDirs.length) throw new Error('at least one frozen output directory is required');
  const cohorts = [];
  for (const outputDir of outputDirs) cohorts.push(await loadCohort(outputDir));
  const compatibility = new Map();
  for (const cohort of cohorts) {
    for (const host of unique(cohort.rows.map(row => row.scheduled.host))) {
      const config = cohort.plan.hostConfigurations?.[host] ?? null;
      const fingerprint = JSON.stringify({ phase: cohort.plan.phase ?? null, config, pluginIdentity: cohort.plan.pluginIdentity ?? null });
      const previous = compatibility.get(host);
      if (previous && previous !== fingerprint) throw new Error(`incompatible cohort configuration for ${host}; analyze phases, models, and plugin identities separately`);
      compatibility.set(host, fingerprint);
    }
  }
  return analyzeCohorts(cohorts);
}

function parseArgs(argv) {
  const dirs = [];
  let output = null;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--output') output = argv[++i];
    else if (argv[i].startsWith('--')) throw new Error(`unknown option ${argv[i]}`);
    else dirs.push(argv[i]);
  }
  if (!output) throw new Error('--output /absolute/report.json is required');
  if (!path.isAbsolute(output)) throw new Error('--output must be an absolute path');
  return { dirs, output };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const { dirs, output } = parseArgs(process.argv.slice(2));
    const report = await analyzeOutputDirs(dirs);
    await fs.writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write(`${output}\n`);
  } catch (error) {
    process.stderr.write(`${error.stack ?? error}\n`);
    process.exitCode = 1;
  }
}
