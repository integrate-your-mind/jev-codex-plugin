import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = process.cwd();
const buildRoot = join(root, 'work', 'jev-build');
const serverPath = join(root, 'dist', 'server.mjs');

function textOf(result: unknown): string {
  const content = (result as {content?: Array<{type?: string; text?: string}>}).content ?? [];
  return content.filter(item => item.type === 'text').map(item => item.text ?? '').join('\n');
}

describe('bundled MCP server', () => {
  it('lists the v0.2 tools and serves failure/decision preview without secret fields', async () => {
    await mkdir(buildRoot, {recursive: true});
    const dataRoot = await mkdtemp(join(buildRoot, 'test-'));
    const {
      TYPESAFE_API_KEY: _removed,
      JEV_API_KEY_FILE: _credentialFile,
      JEV_STATE_DIRECTORY: _stateDirectory,
      JEV_STATE_MODE: _stateMode,
      XDG_STATE_HOME: _stateHome,
      ...inheritedEnv
    } = process.env;
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [serverPath],
      cwd: root,
      env: {...inheritedEnv, PLUGIN_DATA: dataRoot},
      stderr: 'pipe',
    });
    const client = new Client({name: 'jev-test-client', version: '0.2.0'}, {capabilities: {}});
    try {
      await client.connect(transport);
      const listed = await client.listTools();
      const names = listed.tools.map(tool => tool.name);
      assert.deepEqual(names, ['jev_status', 'classify_failure', 'check_completion', 'classify_decision', 'configure_automation']);
      const configureTool = listed.tools.find(tool => tool.name === 'configure_automation');
      assert.deepEqual(configureTool?.annotations, {readOnlyHint: false, destructiveHint: true, openWorldHint: false});
      assert.match(configureTool?.description ?? '', /prior policy is not retained/);

      const status = await client.callTool({name: 'jev_status', arguments: {}});
      const statusText = textOf(status);
      assert.equal(statusText.includes('credentialConfigured":false'), true);
      assert.equal(statusText.includes('apiKey'), false);
      assert.equal(statusText.includes('TYPESAFE_API_KEY'), false);
      const statusData = JSON.parse(statusText);
      assert.equal(statusData.budget.countingBasis, 'local_pre_dispatch_reservations');
      assert.equal(statusData.budget.reservedAttempts, 0);
      assert.equal(statusData.evaluations.providerBilledRequests, null);
      assert.equal(statusData.evaluations.billingReconciled, false);

      const previewInput = {
        task: 'preview', command: 'echo', exitCode: 1,
        output: 'Authorization: Bearer mcp-secret-value',
        evidence: [{id: 'mcp:1', text: 'Authorization: Bearer mcp-secret-value'}], mode: 'preview',
      };
      const preview = await client.callTool({name: 'classify_failure', arguments: previewInput});
      const previewText = textOf(preview);
      assert.equal(previewText.includes('mcp-secret-value'), false);
      assert.equal(previewText.includes('REDACTED'), true);
      assert.equal(previewText.includes('apiKey'), false);

      const missing = await client.callTool({name: 'classify_failure', arguments: {...previewInput, mode: 'evaluate'}});
      const missingText = textOf(missing);
      assert.equal(missingText.includes('missing_api_key'), true);
      assert.equal(missingText.includes('mcp-secret-value'), false);

      const decision = await client.callTool({name: 'classify_decision', arguments: {
        domain: 'tool',
        question: 'Choose the safest tool for this request',
        context: 'Authorization: Bearer mcp-secret-value',
        candidates: [
          {id: 'local-tool', description: 'Local tool with bounded access'},
          {id: 'remote-tool', description: 'Remote tool requiring the secret'},
        ],
        evidence: [{id: 'decision:1', text: 'Authorization: Bearer mcp-secret-value'}],
        mode: 'preview',
      }});
      const decisionText = textOf(decision);
      assert.equal(decisionText.includes('"status":"preview"'), true);
      assert.equal(decisionText.includes('mcp-secret-value'), false);
      assert.equal(decisionText.includes('REDACTED'), true);
      assert.equal(decisionText.includes('apiKey'), false);
      const afterPreview = JSON.parse(textOf(await client.callTool({name: 'jev_status', arguments: {}})));
      assert.equal(afterPreview.budget.reservedAttempts, 0);
      assert.equal(afterPreview.evaluations.totals.receipts, 0);
    } finally {
      await client.close().catch(() => {});
      await rm(dataRoot, {recursive: true, force: true});
    }
  });

  it('observes protected key rotation in one long-running MCP process', async () => {
    await mkdir(buildRoot, {recursive: true});
    const dataRoot = await mkdtemp(join(buildRoot, 'rotation-'));
    const keyPath = join(dataRoot, 'credential.env');
    const replaceKey = async (key: string) => {
      const next = join(dataRoot, 'next.env');
      await writeFile(next, `export TYPESAFE_API_KEY='${key}'\n`, {mode: 0o600});
      await rename(next, keyPath);
    };
    await replaceKey('synthetic-key-one');
    const {TYPESAFE_API_KEY: _old, JEV_API_KEY_FILE: _priorFile, ...inheritedEnv} = process.env;
    const transport = new StdioClientTransport({
      command: process.execPath, args: [serverPath], cwd: root,
      env: {...inheritedEnv, JEV_API_KEY_FILE: keyPath, PLUGIN_DATA: dataRoot}, stderr: 'pipe',
    });
    const client = new Client({name: 'jev-rotation-test', version: '0.3.0'}, {capabilities: {}});
    const status = async () => JSON.parse(textOf(await client.callTool({name: 'jev_status', arguments: {}})));
    try {
      await client.connect(transport);
      const first = await status();
      assert.equal(first.credentialFingerprint, createHash('sha256').update('synthetic-key-one').digest('hex'));
      await replaceKey('synthetic-key-two');
      const second = await status();
      assert.equal(second.credentialFingerprint, createHash('sha256').update('synthetic-key-two').digest('hex'));
      assert.notEqual(first.credentialFingerprint, second.credentialFingerprint);
      await writeFile(keyPath, 'malformed assignment');
      const malformed = await status();
      assert.equal(malformed.credentialConfigured, false);
      assert.equal(malformed.credentialFingerprint, null);
      const result = textOf(await client.callTool({name: 'classify_failure', arguments: {
        task: 'test', command: 'node test.js', exitCode: 1, output: 'assertion failed',
        evidence: [{id: 'log:1', text: 'assertion failed'}], mode: 'evaluate',
      }}));
      assert.equal(JSON.parse(result).reasonCode, 'credential_source_unavailable');
      assert.equal(JSON.stringify({first, second, malformed, result}).includes('synthetic-key-'), false);
    } finally {
      await client.close().catch(() => {});
      await rm(dataRoot, {recursive: true, force: true});
    }
  });
});
