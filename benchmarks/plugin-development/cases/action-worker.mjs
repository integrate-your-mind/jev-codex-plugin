import {createInterface} from 'node:readline';

const pending = new Map();
let nextRequestId = 1;
const lines = createInterface({input: process.stdin, crlfDelay: Infinity});

lines.on('line', line => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  const request = pending.get(message.id);
  if (!request) return;
  pending.delete(message.id);
  if (message.ok) request.resolve(message.value);
  else request.reject(new Error(message.error ?? 'capability request failed'));
});

function request(method, args) {
  const id = nextRequestId++;
  process.stdout.write(`${JSON.stringify({kind: 'capability_request', id, method, args})}\n`);
  return new Promise((resolve, reject) => pending.set(id, {resolve, reject}));
}

const capabilities = Object.freeze({
  appendText: (path, value) => request('appendText', [path, value]),
  exists: path => request('exists', [path]),
  listFiles: path => request('listFiles', [path]),
  readJson: path => request('readJson', [path]),
  readText: path => request('readText', [path]),
  removeFile: path => request('removeFile', [path]),
  runNodeTest: (testPath, receiptPath) => request('runNodeTest', [testPath, receiptPath]),
  sha256: path => request('sha256', [path]),
  writeJson: (path, value) => request('writeJson', [path, value]),
  writeText: (path, value) => request('writeText', [path, value]),
});

try {
  const source = await import(new URL('./source.mjs', import.meta.url));
  const actionIds = Object.keys(source.actions ?? {}).sort();
  if (process.argv[2] === '--list') {
    process.stdout.write(`${JSON.stringify({kind: 'action_list', actionIds})}\n`);
    lines.close();
  } else {
    const action = source.actions?.[process.argv[2]];
    if (typeof action !== 'function') throw new Error(`unmapped action: ${process.argv[2]}`);
    await action(capabilities);
    process.stdout.write(`${JSON.stringify({kind: 'action_done', actionId: process.argv[2]})}\n`);
    lines.close();
  }
} catch (error) {
  process.stdout.write(`${JSON.stringify({kind: 'action_error', error: error instanceof Error ? error.message : String(error)})}\n`);
  lines.close();
  process.exitCode = 1;
}
