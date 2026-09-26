#!/usr/bin/env node
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, isAbsolute, join} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

import {runAttempt} from './run-attempt.mjs';
import {EXPECTED_PROVIDER_MODEL, loadVariantModules} from './source-integrity.mjs';
import {deterministicTransport} from './synthetic-transport.mjs';

const dir = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const result = {out: null};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg !== '--out') throw new Error(`unknown argument: ${arg}`);
    const value = argv[++index];
    if (!value || !isAbsolute(value)) throw new Error('--out requires an absolute path');
    result.out = value;
  }
  return result;
}

export async function runOfflineSlice({outputRoot, schedule: suppliedSchedule} = {}) {
  const schedule = suppliedSchedule ?? JSON.parse(await readFile(join(dir, 'schedule.json'), 'utf8'));
  const ownsOutput = outputRoot === undefined;
  const root = outputRoot ?? await mkdtemp(join(tmpdir(), 'jev-plugin-development-offline-'));
  const runtimes = new Map();
  const attempts = [];
  try {
    for (const arm of schedule.arms) runtimes.set(arm, await loadVariantModules(arm));
    for (const row of schedule.attempts) {
      const runtime = runtimes.get(row.arm);
      if (!runtime) throw new Error(`schedule references unknown arm: ${row.arm}`);
      attempts.push(await runAttempt({
        row,
        outputRoot: root,
        runDecisionHook: runtime.runDecisionHook,
        configurePolicy: runtime.configurePolicy,
        fetchFn: deterministicTransport({caseId: row.caseId}),
        transportKind: 'deterministic-local-response',
        expectedProviderModel: EXPECTED_PROVIDER_MODEL,
        offline: true,
      }));
    }
    const rows = attempts.map(attempt => ({
      attemptId: attempt.attemptId,
      execution: attempt.execution,
      arm: attempt.result?.row.arm ?? null,
      caseId: attempt.result?.row.caseId ?? null,
      request: attempt.result?.stages.request ?? null,
      validatedResponse: attempt.result?.stages.validatedResponse.status ?? null,
      delivery: attempt.result?.stages.delivery ?? null,
      action: attempt.result?.stages.action.status ?? null,
      postcondition: attempt.result?.stages.postcondition.status ?? null,
      harnessStatus: attempt.result?.harnessStatus ?? null,
    }));
    const providerIds = attempts.flatMap(attempt => attempt.result?.providerRequests ?? [])
      .map(request => request.providerRequestId)
      .filter(value => value !== null);
    if (providerIds.length !== 0) throw new Error('deterministic transport produced a provider request-ID claim');
    return {
      schemaVersion: 'plugin-development-offline-slice-v2',
      transport: 'deterministic local Response plumbing; no external request',
      externalProviderCalls: false,
      providerIdsClaimed: false,
      scheduledRows: schedule.attempts.length,
      executedRows: attempts.filter(attempt => attempt.execution === 'executed').length,
      rows,
      retainedOutputRoot: ownsOutput ? null : root,
    };
  } finally {
    await Promise.all([...runtimes.values()].map(runtime => runtime.cleanup()));
    if (ownsOutput) await rm(root, {recursive: true, force: true});
  }
}

async function main() {
  const config = parseArgs(process.argv.slice(2));
  const result = await runOfflineSlice({...(config.out ? {outputRoot: config.out} : {})});
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
