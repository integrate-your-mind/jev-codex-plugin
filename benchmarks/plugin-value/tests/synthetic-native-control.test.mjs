import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';

import {
  buildSyntheticInstruction,
  buildVerifierScript,
  parseOptions,
  validateAgentInspection,
  validateControlReceipt,
  validateLocalImageInspection,
  validateVerifierInspection,
} from '../synthetic-native-control.mjs';

const nonce = '0123456789abcdef0123456789abcdef';
const image = 'example.invalid/repository@sha256:' + 'a'.repeat(64);
const workspace = '/private/control/workspace';
const runtimeBundle = '/private/runtime';

function receipt(arm) {
  const events = [
    {method: 'item/completed', item: {
      type: 'commandExecution', status: 'completed', exitCode: 0, cwd: '/app', source: 'unifiedExecStartup',
      commandBytes: 167, commandSha256: 'a'.repeat(64), outputBytes: 49, outputSha256: 'b'.repeat(64),
    }},
    {method: 'item/completed', item: {type: 'fileChange', status: 'completed', changes: [{
      path: '/app/patch-target.txt', kind: {type: 'update', move_path: null}, diffBytes: 72, diffSha256: 'c'.repeat(64),
    }]}},
  ];
  if (arm === 'treatment') {
    events.push(
      {method: 'item/completed', item: {type: 'mcpToolCall', status: 'completed', server: 'jev-workflows', pluginId: 'jev-workflows@personal', tool: 'jev_status', result: {status: 'ok'}}},
      {method: 'item/completed', item: {type: 'mcpToolCall', status: 'completed', server: 'jev-workflows', pluginId: 'jev-workflows@personal', tool: 'classify_decision', result: {
        status: 'abstained', receiptPersisted: true,
        transport: {fetchInvoked: true, responseStatus: 200, validatedResponse: true},
      }}},
      {method: 'hook/completed', hook: {source: 'plugin', eventName: 'preToolUse', status: 'completed'}},
      {method: 'hook/completed', hook: {source: 'plugin', eventName: 'postToolUse', status: 'completed'}},
    );
  }
  return {
    schemaVersion: 'plugin-value-runtime-v1', arm, status: 'passed', preflightOnly: false,
    environment: {status: 'ready', cwd: 'file:///app'},
    modelEnvironmentSelection: [{environmentId: 'deep-swe', cwd: '/app', runtimeWorkspaceRoots: ['/app']}],
    turn: {status: 'completed'}, evidence: {sessions: true, jevState: arm === 'treatment'}, events,
  };
}

function agentInspection(overrides = {}) {
  return {
    Config: {Image: image, WorkingDir: '/app', Env: ['LANG=C.UTF-8']},
    HostConfig: {NetworkMode: 'none', Privileged: false, CapAdd: []},
    Mounts: [
      {Source: workspace, Destination: '/app', RW: true},
      {Source: runtimeBundle, Destination: '/opt/jev-codex-runtime', RW: false},
    ],
    ...overrides,
  };
}

test('synthetic prompt keeps the hidden nonce in the fixture and treatment demands Jev', () => {
  const baseline = buildSyntheticInstruction('baseline');
  const treatment = buildSyntheticInstruction('treatment');
  assert.doesNotMatch(baseline, new RegExp(nonce));
  assert.doesNotMatch(baseline, /classify_decision|jev_status/);
  assert.match(treatment, /classify_decision/);
  assert.match(treatment, /mode="evaluate"/);
  assert.match(treatment, /authorized this bounded Jev provider evaluation/);
  assert.match(treatment, /jev_status/);
  assert.match(treatment, /apply_patch/);
  assert.match(treatment, /shell command/);
});

test('hidden verifier checks exact artifacts and has no task solution', () => {
  const script = buildVerifierScript(nonce);
  assert.match(script, new RegExp(`READ_NONCE=${nonce}`));
  assert.match(script, /command-proof\.txt/);
  assert.match(script, /patch-target\.txt/);
  assert.match(script, /unchanged-control/);
  assert.doesNotMatch(script, /-type f/);
  assert.doesNotMatch(script, /DeepSWE|pytest|solution|git diff/);
});

test('hidden verifier rejects extra entries and a wrong nonce', async t => {
  const root = await mkdtemp(join(tmpdir(), 'plugin-value-verifier-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const submission = join(root, 'submission');
  const output = join(root, 'output');
  await mkdir(submission);
  await mkdir(output);
  await writeFile(join(submission, 'READ_ME.txt'), `READ_NONCE=${nonce}\n`);
  await writeFile(join(submission, 'command-proof.txt'), `read_nonce=${nonce}\ncwd=/app\n`);
  await writeFile(join(submission, 'patch-target.txt'), `state=after:${nonce}\n`);
  await writeFile(join(submission, 'unchanged.txt'), 'unchanged-control\n');
  const script = join(root, 'verify.sh');
  await writeFile(script, buildVerifierScript(nonce, {submission, output}));

  assert.equal(spawnSync('/bin/sh', [script]).status, 0);
  assert.equal(JSON.parse(await readFile(join(output, 'verification.json'), 'utf8')).passed, true);

  const extra = join(submission, 'extra-directory');
  await mkdir(extra);
  assert.equal(spawnSync('/bin/sh', [script]).status, 1);
  assert.equal(JSON.parse(await readFile(join(output, 'verification.json'), 'utf8')).passed, false);
  await rm(extra, {recursive: true});

  await writeFile(join(submission, 'READ_ME.txt'), 'READ_NONCE=wrong\n');
  assert.equal(spawnSync('/bin/sh', [script]).status, 1);
  assert.equal(JSON.parse(await readFile(join(output, 'verification.json'), 'utf8')).passed, false);
});

test('control receipt requires remote command, patch, Jev provider proof, and hooks', () => {
  assert.deepEqual(validateControlReceipt(receipt('baseline'), 'baseline'), {
    commands: 1, fileChanges: 1, mcpCalls: 0, hookRuns: 0,
  });
  assert.deepEqual(validateControlReceipt(receipt('treatment'), 'treatment'), {
    commands: 1, fileChanges: 1, mcpCalls: 2, hookRuns: 2,
  });
  const noPatch = receipt('baseline');
  noPatch.events = noPatch.events.filter(event => event.item?.type !== 'fileChange');
  assert.throws(() => validateControlReceipt(noPatch, 'baseline'), /apply_patch/);
  const local = receipt('baseline');
  local.environment.cwd = 'file:///private/host';
  assert.throws(() => validateControlReceipt(local, 'baseline'), /cwd drifted/);
  const localSelection = receipt('baseline');
  localSelection.modelEnvironmentSelection.push({
    environmentId: 'local', cwd: '/private/host', runtimeWorkspaceRoots: ['/private/host'],
  });
  assert.throws(() => validateControlReceipt(localSelection, 'baseline'), /environment selection drifted/);
  const noProvider = receipt('treatment');
  noProvider.events.find(event => event.item?.tool === 'classify_decision').item.result.transport.fetchInvoked = false;
  assert.throws(() => validateControlReceipt(noProvider, 'treatment'), /did not call/);
});

test('control receipt accepts only pinned model-triggered command sources', () => {
  const interaction = receipt('baseline');
  interaction.events.find(event => event.item?.type === 'commandExecution').item.source = 'unifiedExecInteraction';
  assert.equal(validateControlReceipt(interaction, 'baseline').commands, 1);
  for (const source of ['userShell', 'agent', 'unknownSource']) {
    const invalid = receipt('baseline');
    invalid.events.find(event => event.item?.type === 'commandExecution').item.source = source;
    assert.throws(() => validateControlReceipt(invalid, 'baseline'), /user-shell or unknown source/);
  }
});

test('agent inspection enforces offline secretless container and exact mounts', () => {
  assert.deepEqual(validateAgentInspection(agentInspection(), {image, workspace, runtimeBundle}), {
    networkMode: 'none', workspaceReadWrite: true, runtimeReadOnly: true, credentialsPresent: false,
  });
  assert.throws(
    () => validateAgentInspection(agentInspection({HostConfig: {NetworkMode: 'bridge', Privileged: false, CapAdd: []}}), {image, workspace, runtimeBundle}),
    /network is enabled/,
  );
  const credentials = agentInspection();
  credentials.Config.Env.push('OPENAI_API_KEY=secret');
  assert.throws(() => validateAgentInspection(credentials, {image, workspace, runtimeBundle}), /OPENAI_API_KEY/);
  const writableRuntime = agentInspection();
  writableRuntime.Mounts[1].RW = true;
  assert.throws(() => validateAgentInspection(writableRuntime, {image, workspace, runtimeBundle}), /read-only/);
});

test('verifier inspection excludes runtime and keeps oracle and submission read-only', () => {
  const oracle = '/private/control/oracle';
  const output = '/private/control/verifier';
  const inspection = {
    Config: {Image: image},
    HostConfig: {NetworkMode: 'none', Privileged: false, CapAdd: []},
    Mounts: [
      {Source: workspace, Destination: '/submission', RW: false},
      {Source: oracle, Destination: '/tests', RW: false},
      {Source: output, Destination: '/logs/verifier', RW: true},
    ],
  };
  assert.deepEqual(validateVerifierInspection(inspection, {image, workspace, oracle, output}), {
    networkMode: 'none', runtimePresent: false, workspaceReadOnly: true,
  });
  inspection.Mounts.push({Source: runtimeBundle, Destination: '/opt/jev-codex-runtime', RW: false});
  assert.throws(() => validateVerifierInspection(inspection, {image, workspace, oracle, output}), /agent runtime/);
});

test('base image must already exist under the frozen linux/amd64 digest', () => {
  assert.deepEqual(validateLocalImageInspection({
    Id: 'sha256:' + 'b'.repeat(64), Os: 'linux', Architecture: 'amd64', RepoDigests: [image],
  }, image), {
    id: 'sha256:' + 'b'.repeat(64), os: 'linux', architecture: 'amd64', digest: image,
  });
  assert.throws(() => validateLocalImageInspection({
    Id: 'sha256:' + 'b'.repeat(64), Os: 'linux', Architecture: 'arm64', RepoDigests: [image],
  }, image), /architecture/);
  assert.throws(() => validateLocalImageInspection({
    Id: 'sha256:' + 'b'.repeat(64), Os: 'linux', Architecture: 'amd64', RepoDigests: [],
  }, image), /not present locally/);
});

test('CLI parser rejects missing, duplicate, and scored-arm options', () => {
  assert.throws(() => parseOptions([]), /--arm/);
  assert.throws(() => parseOptions(['--arm', 'score']), /baseline or treatment/);
  assert.throws(() => parseOptions(['--arm', 'baseline', '--arm', 'treatment']), /duplicate/);
});
