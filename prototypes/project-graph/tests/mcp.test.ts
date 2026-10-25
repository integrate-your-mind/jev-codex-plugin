import assert from 'node:assert/strict';
import {readFile, rm} from 'node:fs/promises';
import {resolve} from 'node:path';
import {afterEach, describe, it} from 'node:test';
import {Client} from '../../../source/jev-workflows/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import {StdioClientTransport} from '../../../source/jev-workflows/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js';
import {fixture} from './helpers.js';

const owned: string[] = [];
afterEach(async () => { await Promise.all(owned.splice(0).map(path => rm(path, {recursive: true, force: true}))); });

describe('bundled MCP server', () => {
  it('serves the single offline tool and records output only after transport send succeeds', async () => {
    const setup = await fixture(); owned.push(setup.parent);
    const {TYPESAFE_API_KEY: _typesafe, JEV_API_KEY: _jev, JEV_API_KEY_FILE: _jevFile, ...safeEnv} = process.env;
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [resolve('dist/server.mjs')],
      cwd: process.cwd(),
      env: {...safeEnv, PROJECT_GRAPH_ROOT: setup.root, PROJECT_GRAPH_STATE: setup.state, PROJECT_GRAPH_ARM: 'graph', PROJECT_GRAPH_OBJECTIVE: 'repair greeting'},
      stderr: 'inherit',
    });
    const client = new Client({name: 'project-graph-test', version: '0.1.0'}, {capabilities: {}});
    try {
      await client.connect(transport);
      const listed = await client.listTools();
      assert.deepEqual(listed.tools.map(tool => tool.name), ['project_graph']);
      const called = await client.callTool({name: 'project_graph', arguments: {operation: 'search', query: 'greeting format'}});
      const text = (called.content as Array<{type: string; text?: string}>).map(item => item.text ?? '').join('');
      const result = JSON.parse(text);
      assert.equal(result.operation, 'search');
      assert.equal(result.cards.some((card: {name: string}) => card.name === 'greeting'), true);
      for (const forbidden of ['requestedArm', 'appliedArm', 'confidence', 'rationale', 'providerReceiptIds']) assert.equal(text.includes(forbidden), false);
      const trace = (await readFile(resolve(setup.state, 'trace.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
      assert.equal(trace.at(-1).type, 'tool_output');
      assert.equal(trace.at(-1).packetHash, result.packetHash);
      assert.deepEqual(trace.filter(event => event.type === 'rank').at(-1).candidateNodeIds.length > 0, true);
    } finally {
      await client.close();
    }
  });
});
