import {constants} from 'node:fs';
import {mkdir, open, realpath} from 'node:fs/promises';
import {isAbsolute, basename, dirname, join} from 'node:path';
import {createService, type Assessment} from '../src/service.js';

const credentialPath = process.env.JEV_API_KEY_FILE;

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function sanitizedResult(result: Assessment): Assessment {
  if (!result.transport) return result;
  const {credentialFingerprint: _privateCredentialIdentity, ...transport} = result.transport;
  return {...result, transport: transport as Assessment['transport']};
}

async function writePrivate(path: string, value: unknown): Promise<void> {
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    await handle.writeFile(JSON.stringify(value, null, 2) + '\n', 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function main(): Promise<void> {
  const outputArg = argument('--output');
  if (!process.argv.includes('--live') || process.env.JEV_RUN_LIVE_EVAL !== '1') throw new Error('live_gate_required');
  if (!outputArg || !isAbsolute(outputArg) || outputArg.includes('\0')) throw new Error('absolute_output_required');
  if (!credentialPath || !isAbsolute(credentialPath) || credentialPath.includes('\0')) throw new Error('protected_credential_file_required');
  if (process.env.TYPESAFE_API_KEY) throw new Error('environment_credential_not_allowed');

  // Resolve the parent first, then atomically reserve a new leaf. No provider
  // request can happen if the target already exists or the parent is absent.
  const parent = await realpath(dirname(outputArg));
  const output = join(parent, basename(outputArg));
  if (output !== outputArg) throw new Error('noncanonical_output');
  await mkdir(output, {mode: 0o700});
  await mkdir(join(output, 'state'), {mode: 0o700});

  let providerCalls = 0;
  const fetchOnce: typeof fetch = async (input, init) => {
    providerCalls += 1;
    if (providerCalls > 1) throw new Error('unexpected_retry');
    return fetch(input, init);
  };
  const env = {
    ...process.env,
    TYPESAFE_API_KEY: '',
    JEV_API_KEY_FILE: credentialPath,
    JEV_STATE_DIRECTORY: join(output, 'state'),
    JEV_ENABLED: '1',
  };
  const service = createService({env, enabled: true, fetchFn: fetchOnce});
  const result = await service.evaluateDecisions({
    state: {
      command: 'node --test synthetic.test.js',
      exitCode: 0,
      assertions: {passed: 12, failed: 0},
      summary: 'The synthetic test process completed successfully and every listed assertion passed.',
    },
    questions: {
      outcome: {
        type: 'choice',
        domain: 'result',
        instructions: 'Which listed outcome is directly supported by `exitCode` and `assertions`?',
        candidates: [
          {id: 'success', description: 'The command exited successfully with no failed assertions.'},
          {id: 'failure', description: 'The command failed or at least one assertion failed.'},
          {id: 'unknown', description: 'The state does not establish whether the command succeeded.'},
        ],
      },
      presentation: {
        type: 'choice',
        domain: 'strategy',
        instructions: 'Which output format is supported by an explicit preference in the supplied state?',
        candidates: [
          {id: 'compact', description: 'Use a compact output format.'},
          {id: 'extended', description: 'Use an extended output format.'},
        ],
      },
      successful: {
        type: 'noul',
        domain: 'result',
        instructions: 'Do `exitCode` and `assertions` directly show a successful test run?',
        criteria: {true: 'Exit code is zero and failed assertions are zero.', false: 'The command or assertions failed, or the state is inconclusive.'},
      },
      verification_level: {
        type: 'score',
        domain: 'result',
        instructions: 'How much successful test execution is directly shown by the structured state?',
        criteria: [
          'No successful test execution is shown.',
          'Some successful checks are shown, but failures or missing results remain.',
          'The command exited zero and every listed assertion passed.',
        ],
      },
    },
    origin: {source: 'service', eventId: 'live-batch-smoke-0.4.0'},
    correlation: {requestId: 'live-batch-smoke-2026-09-26'},
    mode: 'evaluate',
  });

  const outcome = result.answers?.outcome;
  const presentation = result.answers?.presentation;
  const successful = result.answers?.successful;
  const verification = result.answers?.verification_level;
  const checks = {
    exactlyOneProviderCall: providerCalls === 1,
    validatedTransport: result.transport?.validatedResponse === true,
    providerRequestIdPresent: Boolean(result.transport?.providerRequestId),
    receiptPersisted: result.receiptPersisted === true,
    knownChoiceMatched: outcome?.type === 'choice' && outcome.bestCandidate === 'success',
    underdeterminedChoiceAbstained: presentation?.type === 'choice' && presentation.providerChoice === 'insufficient_evidence' && presentation.disposition === 'abstained' && presentation.recommendation === undefined,
    knownNoulDirectionMatched: successful?.type === 'noul' && successful.noul > 0.5,
    knownOrdinalDirectionMatched: verification?.type === 'score' && verification.score > 1,
  };
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    fixture: 'synthetic-successful-test-v1',
    providerCalls,
    checks,
    result: sanitizedResult(result),
    limitations: [
      'This is one synthetic transport and schema probe, not evidence of general calibration or task accuracy.',
      'Known-answer checks verify direction on this toy state only.',
      'No retry was attempted.',
    ],
  };
  await writePrivate(join(output, 'report.json'), report);
  process.stdout.write(JSON.stringify({output, status: result.status, checks, providerRequestId: result.transport?.providerRequestId ?? null}) + '\n');
  if (!Object.values(checks).every(Boolean)) throw new Error('live_smoke_failed');
}

await main();
