#!/usr/bin/env node
import {isAbsolute, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

import {verifyFrozenContent} from './freeze.mjs';
import {requireReviewedManifest} from './live-gate.mjs';
import {runAttempt} from './run-attempt.mjs';
import {loadVariantModules} from './source-integrity.mjs';

function parseArgs(argv) {
  const config = {
    out: process.env.JEV_PRIVATE_OUTPUT,
    manifestPath: process.env.JEV_LIVE_MANIFEST,
    reviewedSha256: process.env.JEV_REVIEWED_MANIFEST_SHA256,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!['--out', '--manifest', '--reviewed-manifest-sha'].includes(arg)) throw new Error(`unknown argument: ${arg}`);
    const value = argv[++index];
    if (!value) throw new Error(`${arg} requires a value`);
    if (arg === '--out') config.out = value;
    if (arg === '--manifest') config.manifestPath = value;
    if (arg === '--reviewed-manifest-sha') config.reviewedSha256 = value;
  }
  if (!config.out || !isAbsolute(config.out)) throw new Error('live mode requires an absolute --out or JEV_PRIVATE_OUTPUT');
  if (!config.manifestPath || !isAbsolute(config.manifestPath)) throw new Error('live mode requires an absolute --manifest or JEV_LIVE_MANIFEST');
  return {...config, out: resolve(config.out), manifestPath: resolve(config.manifestPath)};
}

export async function runLiveSlice(config) {
  // The gate runs before the output root or any row reservation is created.
  const verified = await requireReviewedManifest({
    manifestPath: config.manifestPath,
    reviewedSha256: config.reviewedSha256,
  });
  const runtimes = new Map();
  const attempts = [];
  try {
    for (const arm of verified.schedule.arms) runtimes.set(arm, await loadVariantModules(arm));
    for (const row of verified.schedule.attempts) {
      const runtime = runtimes.get(row.arm);
      if (!runtime) throw new Error(`frozen schedule references unknown arm: ${row.arm}`);
      attempts.push(await runAttempt({
        row,
        outputRoot: config.out,
        runDecisionHook: runtime.runDecisionHook,
        configurePolicy: runtime.configurePolicy,
        fetchFn: (...args) => globalThis.fetch(...args),
        transportKind: 'live-provider-fetch',
        environment: process.env,
        manifestSha256: verified.manifestSha256,
        expectedProviderModel: verified.manifest.providerContract.expectedResponseModelVersion,
        beforeReserve: async () => {
          // Recompute every bound source, input, oracle, schedule, runner, and
          // fixture hash immediately before this row can acquire a reservation.
          await verifyFrozenContent(verified.manifest);
        },
        offline: false,
      }));
    }
  } finally {
    await Promise.all([...runtimes.values()].map(runtime => runtime.cleanup()));
  }

  const rows = attempts.map(attempt => ({
    attemptId: attempt.attemptId,
    execution: attempt.execution,
    harnessStatus: attempt.result?.harnessStatus ?? null,
    requestStatus: attempt.result?.stages.request.status ?? null,
    validatedResponseStatus: attempt.result?.stages.validatedResponse.status ?? null,
    deliveryStatus: attempt.result?.stages.delivery.status ?? null,
    actionStatus: attempt.result?.stages.action.status ?? null,
    postconditionStatus: attempt.result?.stages.postcondition.status ?? null,
    providerRequestIdRetainedPrivately: (attempt.result?.providerRequests ?? []).some(request => request.providerRequestId !== null),
  }));
  return {
    schemaVersion: 'plugin-development-live-slice-summary-v1',
    mode: 'live-provider',
    manifestSha256: verified.manifestSha256,
    scheduledRows: verified.schedule.attempts.length,
    rows,
    outputRoot: config.out,
    providerRequestIdsPrinted: false,
    oraclePassedToProvider: false,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const config = parseArgs(process.argv.slice(2));
  const result = await runLiveSlice(config);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
