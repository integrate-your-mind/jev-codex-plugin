import { pathToFileURL } from 'node:url';
import { realpath } from 'node:fs/promises';
import { createService, type Assessment } from './service.js';
import { readPolicy, type HookPolicy } from './policy.js';

/** Maximum bytes accepted from stdin, checked before JSON parsing. */
export const MAX_STDIN_BYTES = 128 * 1024;

export type Command = 'status' | 'classify-decision' | 'classify-failure' | 'check-completion';
export type ParsedArgs = {command: Command; evaluate: boolean; help: boolean};

export interface CliService {
  status(policy?: HookPolicy): Record<string, unknown>;
  classifyDecision(input: unknown): Promise<Assessment>;
  classifyFailure(input: unknown): Promise<Assessment>;
  checkCompletion(input: unknown): Promise<Assessment>;
}

export type CliResult = {exitCode: number; value: unknown};

class CliError extends Error {
  constructor(readonly code: string) { super(code); }
}

const commands = new Set<Command>(['status', 'classify-decision', 'classify-failure', 'check-completion']);

export function parseArgs(argv: readonly string[]): ParsedArgs {
  let command: Command | undefined;
  let evaluate = false;
  let help = false;
  for (const arg of argv) {
    if (arg === '--evaluate') { evaluate = true; continue; }
    if (arg === '--help' || arg === '-h') { help = true; continue; }
    if (arg.startsWith('-')) throw new CliError('invalid_argument');
    if (command !== undefined || !commands.has(arg as Command)) throw new CliError('invalid_argument');
    command = arg as Command;
  }
  if (help && evaluate) throw new CliError('invalid_argument');
  if (help) return {command: command ?? 'status', evaluate, help};
  if (!command) throw new CliError('missing_command');
  if (evaluate && command === 'status') throw new CliError('invalid_argument');
  return {command, evaluate, help};
}

type InputSource = AsyncIterable<Uint8Array | string> | Iterable<Uint8Array | string>;

export async function readBoundedStdin(source: InputSource): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of source) {
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk);
    total += bytes.byteLength;
    if (total > MAX_STDIN_BYTES) throw new CliError('input_too_large');
    chunks.push(bytes);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function parseInput(text: string): unknown {
  try {
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CliError('invalid_input');
    return value;
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError('malformed_json');
  }
}

function publicStatus(raw: Record<string, unknown>): Record<string, unknown> {
  return {
    version: raw.version,
    provider: raw.provider,
    model: raw.model,
    credentialConfigured: raw.credentialConfigured === true,
    enabled: raw.enabled === true,
    quotas: {
      maxCallsPerDay: raw.maxCallsPerDay ?? null,
      maxBytesPerDay: raw.maxBytesPerDay ?? null,
    },
  };
}

function assessmentExitCode(value: Assessment): number {
  // A valid service result is machine-readable success, including unavailable
  // and abstained outcomes. Callers inspect `status`; only CLI/input errors
  // use a nonzero process exit.
  void value;
  return 0;
}

function invalidInput(): CliResult {
  return {exitCode: 0, value: {status: 'skipped', reasonCode: 'invalid_input'}};
}

export async function dispatch(
  args: ParsedArgs,
  input: unknown,
  service: CliService | undefined = undefined,
  env: NodeJS.ProcessEnv = process.env,
): Promise<CliResult> {
  if (args.help) return {exitCode: 0, value: {usage: 'jev <status|classify-decision|classify-failure|check-completion> [--evaluate]'}};
  service ??= createService({env});
  if (args.command === 'status') return {exitCode: 0, value: publicStatus(service.status(await readPolicy(env)))};
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new CliError('invalid_input');

  const payload = {...input as Record<string, unknown>};
  const requestedMode = payload.mode;
  if (requestedMode === 'evaluate' && !args.evaluate) throw new CliError('evaluation_requires_flag');
  if (requestedMode === 'preview' && args.evaluate) throw new CliError('conflicting_mode');
  if (requestedMode !== undefined && requestedMode !== 'preview' && requestedMode !== 'evaluate') return invalidInput();
  // Never turn an explicit preview request into a provider request.
  payload.mode = args.evaluate ? 'evaluate' : requestedMode ?? 'preview';
  let result: Assessment;
  try {
    result = args.command === 'classify-decision'
      ? await service.classifyDecision(payload)
      : args.command === 'classify-failure'
        ? await service.classifyFailure(payload)
        : await service.checkCompletion(payload);
  } catch {
    // Keep transport/provider implementation details and exception bodies out
    // of the standalone protocol. The service is fail-open by contract.
    result = {status: 'unavailable', reasonCode: 'internal_error'};
  }
  return {exitCode: assessmentExitCode(result), value: result};
}

export type MainOptions = {
  argv?: readonly string[];
  stdin?: InputSource;
  stdout?: {write(text: string): unknown};
  stderr?: {write(text: string): unknown};
  service?: CliService;
  env?: NodeJS.ProcessEnv;
};

function errorResult(error: unknown): CliResult {
  return {exitCode: 2, value: {error: error instanceof CliError ? error.code : 'internal_error'}};
}

export async function main(options: MainOptions = {}): Promise<number> {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  try {
    const args = parseArgs(options.argv ?? process.argv.slice(2));
    const input = args.command === 'status' || args.help ? {} : parseInput(await readBoundedStdin(options.stdin ?? process.stdin));
    const result = await dispatch(args, input, options.service, options.env);
    stdout.write(JSON.stringify(result.value) + '\n');
    return result.exitCode;
  } catch (error) {
    const result = errorResult(error);
    stdout.write(JSON.stringify(result.value) + '\n');
    if (!(error instanceof CliError)) stderr.write('jev: internal error\n');
    return result.exitCode;
  }
}

const invokedPath = process.argv[1];
const invokedRealPath = invokedPath ? await realpath(invokedPath).catch(() => undefined) : undefined;
if (invokedRealPath && import.meta.url === pathToFileURL(invokedRealPath).href) {
  const code = await main();
  process.exitCode = code;
}
