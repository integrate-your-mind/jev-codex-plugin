import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {test} from 'node:test';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';

async function fixture(preload?: string) {
  const base = join(process.cwd(), 'work', 'status-mcp');
  await mkdir(base, {recursive: true});
  const root = await mkdtemp(join(base, 'test-'));
  await mkdir(join(root, 'receipts'));
  const args = [];
  if (preload) {
    const path = join(root, 'preload.mjs');
    await writeFile(path, preload);
    args.push('--import', path);
  }
  args.push(join(process.cwd(), 'dist/server.mjs'));
  const {TYPESAFE_API_KEY: _key, JEV_API_KEY_FILE: _keyFile, JEV_STATE_DIRECTORY: _state, JEV_STATE_MODE: _mode, XDG_STATE_HOME: _xdg, ...env} = process.env;
  const transport = new StdioClientTransport({command: process.execPath, args, cwd: process.cwd(),
    env: {...env, PLUGIN_DATA: root, JEV_TEST_ACCOUNTING_ROOT: root}, stderr: 'pipe'});
  const client = new Client({name: 'status-mcp-test', version: '1'}, {capabilities: {}});
  await client.connect(transport);
  return {root, client, close: async () => {await client.close().catch(() => {}); await rm(root, {recursive: true, force: true});}};
}

function text(result: unknown) {
  return JSON.parse((result as {content: Array<{text: string}>}).content[0]!.text);
}

async function receipt(root: string) {
  const id = randomUUID();
  await writeFile(join(root, 'receipts', `${id}.json`), JSON.stringify({receiptId: id, timestamp: new Date().toISOString(), status: 'assessed'}));
  return id;
}

test('bundled status defaults to indexed evidence, validates opt-in audit arguments and never repairs an index', async () => {
  const f = await fixture();
  try {
    const first = await receipt(f.root);
    await receipt(f.root);
    const day = new Date().toISOString().slice(0, 10);
    const index = join(f.root, `receipt-index-${day}.json`);
    await writeFile(index, JSON.stringify({version: 1, date: day, receiptIds: [first]}));
    const status = async (args = {}) => text(await f.client.callTool({name: 'jev_status', arguments: args}));
    const indexed = await status();
    assert.equal(indexed.evaluations.scanMode, 'daily-index');
    assert.equal(indexed.evaluations.totals.receipts, 1);
    assert.equal(indexed.evaluations.inventoryFiles, null);
    assert.equal(indexed.evaluations.countsIncomplete, true);
    const full = await status({fullReceiptScan: true});
    assert.equal(full.evaluations.scanMode, 'full');
    assert.equal(full.evaluations.totals.receipts, 2);
    assert.equal(full.evaluations.inventoryComplete, true);
    assert.equal(full.evaluations.providerBilledRequests, null);
    await rm(index);
    const missing = await status({fullReceiptScan: true});
    assert.equal(missing.evaluations.totals.receipts, 2);
    await assert.rejects(readFile(index), {code: 'ENOENT'});
    await assert.rejects(status({fullReceiptScan: 'yes'}));
    await assert.rejects(status({unexpected: true}));
  } finally {await f.close();}
});

test('MCP cancellation reaches a full audit and closes active reads without dispatching the queued inventory', async () => {
  const f = await fixture(`
import fs from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import {join} from 'node:path';
const root = process.env.JEV_TEST_ACCOUNTING_ROOT;
const log = join(root, 'audit-events.jsonl');
const record = event => fs.appendFile(log, JSON.stringify({event}) + '\\n');
const original = fs.open;
fs.open = async (...args) => {
  const handle = await original(...args);
  if (String(args[0]).startsWith(join(root, 'receipts') + '/')) {
    await record('opened');
    const close = handle.close.bind(handle);
    handle.close = async () => {await close(); await record('closed');};
    handle.readFile = async options => {
      const signal = options?.signal;
      if (!signal) throw new Error('audit_cancellation_signal_missing');
      await record('read-started');
      return new Promise((_resolve, reject) => {
        const abort = () => {void record('aborted').then(() => reject(signal.reason));};
        if (signal.aborted) abort(); else signal.addEventListener('abort', abort, {once: true});
      });
    };
  }
  return handle;
};
syncBuiltinESMExports();
`);
  const controller = new AbortController();
  const events = async () => (await readFile(join(f.root, 'audit-events.jsonl'), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line).event as string);
  const waitFor = async (condition: (rows: string[]) => boolean) => {
    for (let attempt = 0; attempt < 250; attempt++) {const rows = await events(); if (condition(rows)) return rows; await delay(20);}
    throw new Error('audit_event_timeout');
  };
  try {
    for (let i = 0; i < 20; i++) await receipt(f.root);
    const pending = f.client.callTool({name: 'jev_status', arguments: {fullReceiptScan: true}}, undefined, {signal: controller.signal}).then(() => false, () => true);
    await waitFor(rows => rows.includes('read-started'));
    controller.abort(new Error('stop_audit'));
    assert.equal(await pending, true);
    const rows = await waitFor(values => values.includes('aborted') && values.filter(v => v === 'closed').length === values.filter(v => v === 'opened').length);
    const opened = rows.filter(v => v === 'opened').length;
    assert.ok(opened > 0 && opened <= 8);
    await delay(50);
    assert.equal((await events()).filter(v => v === 'opened').length, opened);
  } finally {controller.abort(); await f.close();}
});
