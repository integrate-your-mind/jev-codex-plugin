import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { configurePolicy, DEFAULT_POLICY, readPolicy, automationPolicySchema, workspaceAllowed } from '../src/policy.js';

let root: string;

before(async () => {
  await mkdir(join(process.cwd(), 'work'), {recursive: true});
  root = await mkdtemp(join(process.cwd(), 'work', 'decision-policy-'));
});

after(async () => {
  await rm(root, {recursive: true, force: true});
});

function env(data = join(root, 'data')): NodeJS.ProcessEnv {
  return {PLUGIN_DATA: data};
}

describe('automation policy', () => {
  it('defaults to disabled and writes a bounded private policy on first use', async () => {
    const data = join(root, 'first-run');
    assert.deepEqual(await readPolicy(env(data)), DEFAULT_POLICY);
    const configured = await configurePolicy({enabled: true, scope: 'workspaces', workspaces: [process.cwd()]}, env(data));
    assert.equal(configured.enabled, true);
    assert.equal(configured.maxHookCallsPerSession, null);
    assert.equal(configured.maxCallsPerDay, null);
    assert.equal(configured.maxBytesPerDay, null);
    assert.deepEqual(await readPolicy(env(data)), configured);
  });

  it('accepts unlimited or user-selected caps without a plugin usage ceiling', () => {
    assert.equal(automationPolicySchema.safeParse({enabled: true, scope: 'all-workspaces', workspaces: [], maxHookCallsPerSession: 500}).success, true);
    assert.equal(automationPolicySchema.safeParse({enabled: false, maxHookCallsPerSession: null, maxCallsPerDay: null, maxBytesPerDay: null}).success, true);
    assert.equal(automationPolicySchema.safeParse({enabled: false, maxCallsPerDay: 0, maxBytesPerDay: 0}).success, true);
    assert.equal(automationPolicySchema.safeParse({enabled: false, maxCallsPerDay: 1_000, maxBytesPerDay: 10_000_000}).success, true);
    assert.equal(automationPolicySchema.safeParse({enabled: true, scope: 'workspaces', workspaces: ['relative'], maxHookCallsPerSession: 50}).success, false);
    assert.equal(automationPolicySchema.safeParse({enabled: true, scope: 'all-workspaces', workspaces: [], maxHookCallsPerSession: 501}).success, true);
    assert.equal(automationPolicySchema.safeParse({enabled: false, maxCallsPerDay: 1_001}).success, true);
    assert.equal(automationPolicySchema.safeParse({enabled: false, maxBytesPerDay: 10_000_001}).success, true);
    assert.equal(automationPolicySchema.safeParse({enabled: false, maxCallsPerDay: Number.MAX_SAFE_INTEGER}).success, true);
    assert.equal(automationPolicySchema.safeParse({enabled: false, maxCallsPerDay: Number.MAX_SAFE_INTEGER + 1}).success, false);
    assert.equal(automationPolicySchema.safeParse({enabled: false, maxCallsPerDay: -1}).success, false);
    assert.equal(automationPolicySchema.safeParse({enabled: false, maxCallsPerDay: 1.5}).success, false);
  });

  it('adds safe defaults when reading an older policy without daily budgets', async () => {
    const data = join(root, 'legacy');
    await mkdir(data, {recursive: true});
    await writeFile(join(data, 'policy.json'), JSON.stringify({enabled: false, scope: 'workspaces', workspaces: [], maxHookCallsPerSession: 50}), {mode: 0o600});
    const policy = await readPolicy(env(data));
    assert.equal(policy.maxHookCallsPerSession, 50);
    assert.equal(policy.maxCallsPerDay, null);
    assert.equal(policy.maxBytesPerDay, null);
  });

  it('rejects a policy path symlink instead of following it', async () => {
    const data = join(root, 'symlinked');
    const target = join(root, 'target');
    await mkdir(data, {recursive: true});
    await symlink(target, join(data, 'policy.json'));
    await assert.rejects(() => configurePolicy({enabled: true, scope: 'all-workspaces', workspaces: []}, env(data)));
  });

  it('canonicalizes roots and fails closed when a configured root is retargeted', async () => {
    const data = join(root, 'root-retarget');
    const allowed = join(data, 'allowed');
    const other = join(data, 'other');
    await mkdir(allowed, {recursive: true});
    await mkdir(other, {recursive: true});
    const policy = await configurePolicy({enabled: true, scope: 'workspaces', workspaces: [allowed]}, env(data));
    assert.equal(policy.workspaces[0], allowed);
    assert.equal(await workspaceAllowed(policy, allowed), true);
    await rm(allowed, {recursive: true});
    await symlink(other, allowed);
    assert.equal(await workspaceAllowed(policy, other), false);
  });
});
