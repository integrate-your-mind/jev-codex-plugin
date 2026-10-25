import {ProjectGraphRuntime} from './runtime.js';

function parseArguments(argv: string[]): Record<string, unknown> {
  const [operation, ...rest] = argv;
  const values = new Map<string, string>();
  for (let index = 0; index < rest.length; index += 1) {
    const key = rest[index];
    const value = rest[index + 1];
    if (!key?.startsWith('--') || value === undefined || value.startsWith('--')) throw new Error(`invalid argument ${key ?? ''}`.trim());
    values.set(key.slice(2), value);
    index += 1;
  }
  if (operation === 'search') return {operation, query: values.get('query')};
  if (operation === 'expand') return {operation, nodeId: values.get('node'), ...(values.has('query') ? {query: values.get('query')} : {}), ...(values.has('cursor') ? {cursor: values.get('cursor')} : {})};
  if (operation === 'read') return {operation, nodeId: values.get('node')};
  throw new Error('usage: project-graph <search --query TEXT | expand --node ID [--query TEXT] [--cursor CURSOR] | read --node ID>');
}

try {
  const runtime = await ProjectGraphRuntime.fromEnvironment();
  const result = await runtime.execute(parseArguments(process.argv.slice(2)));
  await new Promise<void>((resolve, reject) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`, error => error ? reject(error) : resolve()));
  await runtime.recordToolOutput(result);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : 'unknown error'}\n`);
  process.exitCode = 1;
}
