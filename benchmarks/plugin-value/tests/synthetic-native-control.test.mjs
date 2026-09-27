import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';

import {
  buildSyntheticInstruction,
  buildRecoveryImageCheckArgs,
  buildRestoredFilesVerificationScript,
  buildRestoredFilesVerificationPayload,
  buildVerifierScript,
  parseOptions,
  validateAgentInspection,
  validateControlReceipt,
  validateLocalImageInspection,
  validateRecoveryManifest,
  validateRestoredFilesArtifact,
  validateVerifierInspection,
  syntheticControlLabels,
} from '../synthetic-native-control.mjs';

const nonce = '0123456789abcdef0123456789abcdef';
const image = 'example.invalid/repository@sha256:' + 'a'.repeat(64);
const workspace = '/private/control/workspace';
const runtimeBundle = '/private/runtime';
const selectedCwdAlias = '/private/control/host-control/workspace';

function receipt(arm) {
  const events = [
    {method: 'item/completed', item: {
      type: 'commandExecution', status: 'completed', exitCode: 0, cwd: selectedCwdAlias, source: 'unifiedExecStartup',
      commandBytes: 167, commandSha256: 'a'.repeat(64), outputBytes: 49, outputSha256: 'b'.repeat(64),
    }},
    {method: 'item/completed', item: {type: 'fileChange', status: 'completed', changes: [{
      path: `${selectedCwdAlias}/patch-target.txt`, kind: {type: 'update', move_path: null}, diffBytes: 72, diffSha256: 'c'.repeat(64),
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
    environment: {status: 'ready', cwd: 'file:///app', selectedCwdAlias, canonicalCwd: '/app'},
    workspaceAlias: {
      selectedCwdAlias,
      canonicalTarget: '/app',
      taskUserAccess: {selectedCwdAlias, canonicalCwd: '/app', accessible: true},
      cleanup: {removed: true},
    },
    modelEnvironmentSelection: [{environmentId: 'deep-swe', cwd: selectedCwdAlias, runtimeWorkspaceRoots: [selectedCwdAlias]}],
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
  assert.match(treatment, /without changing directories/);
  assert.match(treatment, /pwd -P/);
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
  assert.deepEqual(validateControlReceipt(receipt('baseline'), 'baseline', selectedCwdAlias), {
    commands: 1, fileChanges: 1, mcpCalls: 0, hookRuns: 0,
  });
  assert.deepEqual(validateControlReceipt(receipt('treatment'), 'treatment', selectedCwdAlias), {
    commands: 1, fileChanges: 1, mcpCalls: 2, hookRuns: 2,
  });
  const noPatch = receipt('baseline');
  noPatch.events = noPatch.events.filter(event => event.item?.type !== 'fileChange');
  assert.throws(() => validateControlReceipt(noPatch, 'baseline', selectedCwdAlias), /apply_patch/);
  const local = receipt('baseline');
  local.environment.cwd = 'file:///private/host';
  assert.throws(() => validateControlReceipt(local, 'baseline', selectedCwdAlias), /cwd drifted/);
  const localSelection = receipt('baseline');
  localSelection.modelEnvironmentSelection.push({
    environmentId: 'local', cwd: '/private/host', runtimeWorkspaceRoots: ['/private/host'],
  });
  assert.throws(() => validateControlReceipt(localSelection, 'baseline', selectedCwdAlias), /environment selection drifted/);
  const canonicalOnlyCommand = receipt('baseline');
  canonicalOnlyCommand.events.find(event => event.item?.type === 'commandExecution').item.cwd = '/app';
  assert.throws(() => validateControlReceipt(canonicalOnlyCommand, 'baseline', selectedCwdAlias), /selected alias/);
  const noProvider = receipt('treatment');
  noProvider.events.find(event => event.item?.tool === 'classify_decision').item.result.transport.fetchInvoked = false;
  assert.throws(() => validateControlReceipt(noProvider, 'treatment', selectedCwdAlias), /did not call/);
});

test('control receipt accepts only pinned model-triggered command sources', () => {
  const interaction = receipt('baseline');
  interaction.events.find(event => event.item?.type === 'commandExecution').item.source = 'unifiedExecInteraction';
  assert.equal(validateControlReceipt(interaction, 'baseline', selectedCwdAlias).commands, 1);
  for (const source of ['userShell', 'agent', 'unknownSource']) {
    const invalid = receipt('baseline');
    invalid.events.find(event => event.item?.type === 'commandExecution').item.source = source;
    assert.throws(() => validateControlReceipt(invalid, 'baseline', selectedCwdAlias), /user-shell or unknown source/);
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
  const effectiveId = 'sha256:' + 'c'.repeat(64);
  const recovered = agentInspection({Image: effectiveId});
  assert.doesNotThrow(() => validateAgentInspection(recovered, {image, imageId: effectiveId, workspace, runtimeBundle}));
  assert.throws(() => validateAgentInspection(recovered, {image, imageId: 'sha256:' + 'd'.repeat(64), workspace, runtimeBundle}), /effective image id/);
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
  inspection.Config.Env = ['JEV_API_KEY=redacted'];
  assert.throws(() => validateVerifierInspection(inspection, {image, workspace, oracle, output}), /JEV_API_KEY/);
  delete inspection.Config.Env;
  inspection.HostConfig.Privileged = true;
  assert.throws(() => validateVerifierInspection(inspection, {image, workspace, oracle, output}), /privileged/);
  delete inspection.HostConfig.Privileged;
  inspection.Mounts.push({Source: '/private/unexpected', Destination: '/unexpected', RW: false});
  assert.throws(() => validateVerifierInspection(inspection, {image, workspace, oracle, output}), /unexpected mount/);
  inspection.Mounts.pop();
  inspection.Mounts[0].RW = true;
  assert.throws(() => validateVerifierInspection(inspection, {image, workspace, oracle, output}), /mode/);
  inspection.Mounts[0].RW = false;
  inspection.Mounts[0].Source = '/private/wrong-source';
  assert.throws(() => validateVerifierInspection(inspection, {image, workspace, oracle, output}), /source/);
  inspection.Mounts[0].Source = workspace;
  inspection.Mounts.push({Source: runtimeBundle, Destination: '/opt/jev-codex-runtime', RW: false});
  assert.throws(() => validateVerifierInspection(inspection, {image, workspace, oracle, output}), /agent runtime/);
  inspection.Mounts.pop();
  inspection.Image = 'sha256:' + 'c'.repeat(64);
  assert.doesNotThrow(() => validateVerifierInspection(inspection, {image, imageId: inspection.Image, workspace, oracle, output}));
  assert.throws(() => validateVerifierInspection(inspection, {image, imageId: 'sha256:' + 'd'.repeat(64), workspace, oracle, output}), /effective image id/);
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

test('recovery image inspection requires the exact effective id and rootfs', () => {
  const effectiveImage = 'jev-plugin-value-recovery/ipython-session-bundle-replay:fixture-v1';
  const effectiveId = 'sha256:' + 'c'.repeat(64);
  const rootfs = ['sha256:' + 'd'.repeat(64), 'sha256:' + 'e'.repeat(64)];
  const inspection = {
    Id: effectiveId, Os: 'linux', Architecture: 'amd64', RepoTags: [effectiveImage], RootFS: {Layers: rootfs},
  };
  assert.deepEqual(validateLocalImageInspection(inspection, effectiveImage, {id: effectiveId, rootfs}), {
    id: effectiveId, os: 'linux', architecture: 'amd64', digest: effectiveImage,
  });
  assert.throws(() => validateLocalImageInspection({...inspection, Id: 'sha256:' + 'f'.repeat(64)}, effectiveImage, {id: effectiveId, rootfs}), /effective recovery image id/);
  assert.throws(() => validateLocalImageInspection({...inspection, RootFS: {Layers: rootfs.slice(0, 1)}}, effectiveImage, {id: effectiveId, rootfs}), /effective recovery rootfs/);
});

test('recovery manifest binds reviewed image identity, artifact shape, and restored metadata', () => {
  const restored = {
    schemaVersion: 'jev-plugin-value-restored-files-v1',
    root: '/usr/local/lib/python3.12/site-packages',
    packages: ['Pygments'],
    files: [{
      path: '/usr/local/lib/python3.12/site-packages/pygments/__init__.py',
      mode: '0644', uid: 0, gid: 0, size: 3, sha256: 'a'.repeat(64),
    }],
  };
  const entry = {
    taskId: 'ipython-session-bundle-replay',
    sourceLayerArtifact: 'artifacts/source.json',
    sourceLayerArtifactSha256: 'b'.repeat(64),
    restoredFilesArtifact: 'artifacts/restored.json',
    restoredFilesArtifactSha256: 'c'.repeat(64),
    buildReceiptArtifact: 'artifacts/build.json',
    buildReceiptArtifactSha256: 'd'.repeat(64),
    effectiveImageRef: 'jev-plugin-value-recovery/ipython-session-bundle-replay:fixture-v1',
    effectiveImageId: 'sha256:' + 'e'.repeat(64),
    effectiveRootfsDiffIds: ['sha256:' + 'f'.repeat(64)],
  };
  assert.equal(validateRecoveryManifest({schemaVersion: 'jev-plugin-value-image-recovery-v1', executionReady: true, recoveries: [entry]}, undefined, restored), entry);
  assert.equal(validateRestoredFilesArtifact(restored), restored);
  const script = buildRestoredFilesVerificationScript();
  assert.match(script, /json\.load\(sys\.stdin\)/);
  assert.match(script, /os\.lstat/);
  assert.match(script, /hashlib\.sha256/);
  assert.match(script, /restored-files-verified/);
  assert.equal(validateRecoveryManifest({schemaVersion: 'jev-plugin-value-image-recovery-v1', executionReady: false, recoveries: [entry]}, undefined, restored), entry);
  assert.throws(() => validateRecoveryManifest({schemaVersion: 'jev-plugin-value-image-recovery-v1', recoveries: [entry]}, undefined, restored), /executionReady/);
  assert.throws(() => validateRestoredFilesArtifact({...restored, files: [{...restored.files[0], mode: '0666'}]}), /writable/);
});

test('recovery verifier uses bounded stdin for 706 files and cleanup labels', async t => {
  const root = await mkdtemp(join(tmpdir(), 'plugin-value-recovery-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const uid = process.getuid?.() ?? 0;
  const gid = process.getgid?.() ?? 0;
  const files = Array.from({length: 706}, (_, index) => {
    const bytes = Buffer.from(`restored-${index}\n`);
    return {path: join(root, `file-${String(index).padStart(3, '0')}.py`), mode: '0644', uid, gid, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), bytes};
  });
  await Promise.all(files.map(file => writeFile(file.path, file.bytes, {mode: 0o644})));
  const payload = buildRestoredFilesVerificationPayload(files.map(({bytes, ...file}) => file));
  assert.equal(JSON.parse(payload).length, 706);
  const verified = spawnSync('python3', ['-B', '-c', buildRestoredFilesVerificationScript()], {input: payload, encoding: 'utf8'});
  assert.equal(verified.status, 0, verified.stderr);
  assert.equal(verified.stdout.trim(), 'restored-files-verified');

  const labels = syntheticControlLabels(join(root, 'control-run'));
  assert.deepEqual(labels, {
    control: 'com.openai.jev.synthetic-control=control-run',
    verifier: 'com.openai.jev.synthetic-verifier=control-run',
  });
  const imageCheck = buildRecoveryImageCheckArgs('jev-plugin-value-recovery/example:fixture', labels.verifier);
  assert.equal(imageCheck.includes('--rm'), true);
  assert.equal(imageCheck.includes('-i'), true);
  assert.equal(imageCheck.includes('--network') && imageCheck[imageCheck.indexOf('--network') + 1], 'none');
  assert.equal(imageCheck.includes('--label') && imageCheck[imageCheck.indexOf('--label') + 1], labels.verifier);
  assert.equal(imageCheck.at(-2), '-c');
});

test('CLI parser rejects missing, duplicate, and scored-arm options', () => {
  assert.throws(() => parseOptions([]), /--arm/);
  assert.throws(() => parseOptions(['--arm', 'score']), /baseline or treatment/);
  assert.throws(() => parseOptions(['--arm', 'baseline', '--arm', 'treatment']), /duplicate/);
});
