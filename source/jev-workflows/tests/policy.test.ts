import { mkdir, mkdtemp, rm, symlink, writeFile, readFile } from 'node:fs/promises';
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
    assert.equal(DEFAULT_POLICY.consultationMode, 'changed_state');
    const configured = await configurePolicy({enabled: true, scope: 'workspaces', workspaces: [process.cwd()]}, env(data));
    assert.equal(configured.enabled, true);
    assert.equal(configured.maxHookCallsPerSession, null);
    assert.equal(configured.maxCallsPerDay, null);
    assert.equal(configured.maxBytesPerDay, null);
    assert.deepEqual(await readPolicy(env(data)), configured);
  });

  it('keeps the V1 policy readable by the legacy strict schema', async () => {
    const environment = env(join(root, 'legacy-reader'));
    const configured = await configurePolicy({enabled: true, consultationMode: 'changed_state', scope: 'all-workspaces', workspaces: [], maxHookCallsPerSession: null, maxCallsPerDay: null, maxBytesPerDay: null}, environment);
    const saved = JSON.parse(await readFile(join(environment.PLUGIN_DATA!, 'policy.json'), 'utf8'));
    const legacySchema = automationPolicySchema.omit({consultationMode: true});
    const legacy = legacySchema.safeParse(saved);
    assert.equal(legacy.success, true);
    assert.equal(legacy.success && legacy.data.enabled, true);
    assert.equal(Object.hasOwn(saved, 'consultationMode'), false);
    assert.equal((await readPolicy(environment)).consultationMode, configured.consultationMode);
  });

  it('defaults first enable to changed_state and preserves the resolved mode when omitted later', async () => {
    const environment = env(join(root, 'fresh-mode'));
    const input = {enabled: true, scope: 'all-workspaces', workspaces: []};
    assert.equal((await configurePolicy(input, environment)).consultationMode, 'changed_state');
    await configurePolicy({...input, consultationMode: 'always'}, environment);
    assert.equal((await configurePolicy(input, environment)).consultationMode, 'always');
    await configurePolicy({...input, consultationMode: 'changed_state'}, environment);
    assert.equal((await configurePolicy(input, environment)).consultationMode, 'changed_state');
  });

  it('preserves legacy always mode on configure calls that omit mode', async () => {
    const environment = env(join(root, 'legacy-omitted-mode'));
    await mkdir(environment.PLUGIN_DATA!, {recursive: true});
    const legacy = {enabled: true, scope: 'all-workspaces', workspaces: [], maxHookCallsPerSession: null, maxCallsPerDay: null, maxBytesPerDay: null};
    await writeFile(join(environment.PLUGIN_DATA!, 'policy.json'), JSON.stringify(legacy));
    assert.equal((await configurePolicy(legacy, environment)).consultationMode, 'always');
  });

  it('ignores mismatched or partial mode publication without changing V1 authority', async () => {
    const environment = env(join(root, 'mode-recovery'));
    await configurePolicy({enabled: true, consultationMode: 'changed_state', scope: 'all-workspaces', workspaces: [], maxCallsPerDay: 9}, environment);
    const path = join(environment.PLUGIN_DATA!, 'policy.json');
    const sidecar = join(environment.PLUGIN_DATA!, 'policy-mode-v1.json');
    const changed = JSON.parse(await readFile(path, 'utf8'));
    changed.enabled = false;
    changed.maxCallsPerDay = 4;
    await writeFile(path, JSON.stringify(changed));
    const recovered = await readPolicy(environment);
    assert.equal(recovered.enabled, false);
    assert.equal(recovered.maxCallsPerDay, 4);
    assert.equal(recovered.consultationMode, 'always');
    await writeFile(sidecar, '{');
    assert.deepEqual(await readPolicy(environment), recovered);
    await writeFile(join(environment.PLUGIN_DATA!, '.policy-mode-interrupted.tmp'), JSON.stringify({consultationMode: 'changed_state', enabled: true}));
    assert.deepEqual(await readPolicy(environment), recovered);
  });

  it('rejects a substituted mode path before changing the authoritative policy', async () => {
    const environment = env(join(root, 'mode-symlink'));
    await configurePolicy({enabled: true, consultationMode: 'changed_state', scope: 'all-workspaces', workspaces: []}, environment);
    const path = join(environment.PLUGIN_DATA!, 'policy.json');
    const before = await readFile(path, 'utf8');
    const sidecar = join(environment.PLUGIN_DATA!, 'policy-mode-v1.json');
    await rm(sidecar, {force: true});
    await symlink(join(root, 'unowned-mode-target'), sidecar);
    await assert.rejects(configurePolicy({enabled: false, consultationMode: 'always'}, environment));
    assert.equal(await readFile(path, 'utf8'), before);
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
    assert.equal(policy.consultationMode, 'always');
    assert.equal(policy.maxHookCallsPerSession, 50);
    assert.equal(policy.maxCallsPerDay, null);
    assert.equal(policy.maxBytesPerDay, null);
  });

  it('changes only consultation mode on explicit migration and preserves existing opt-ins', async () => {
    const environment = env(join(root, 'migration'));
    const legacy = await configurePolicy({enabled: true, consultationMode: 'always', scope: 'all-workspaces', workspaces: [], maxHookCallsPerSession: null, maxCallsPerDay: null, maxBytesPerDay: null}, environment);
    assert.equal(legacy.consultationMode, 'always');
    const migrated = await configurePolicy({...legacy, consultationMode: 'changed_state'}, environment);
    assert.deepEqual(migrated, {...legacy, consultationMode: 'changed_state'});
    assert.deepEqual(await readPolicy(environment), migrated);
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
