import assert from 'node:assert/strict';
import {access, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, utimes, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {test} from 'node:test';
import {BRIDGE_VERSION, batchKey, type DecisionRecord} from '../src/hosts/claude/bridge.js';
import {prepareBatchClaim, pruneClaudeBatchRecords} from '../src/hosts/claude/retention.js';

test('producer write prunes only owned ninety-day metadata and preserves pinned, unknown and linked proof', async () => {
  const parent = join(process.cwd(), '..', '..', '.agent-work'); await mkdir(parent, {recursive: true});
  const root = await mkdtemp(join(parent, 'claude-retention-'));
  const now = Date.now(); const old = now - 91 * 24 * 60 * 60 * 1000;
  try {
    const write = async (id: string, retention: 'metadata' | 'pinned' = 'metadata', touched = old) => {
      const path = join(root, `${batchKey([id])}.json`);
      const record: DecisionRecord = {version: BRIDGE_VERSION, producer: 'trusted-post-tool-batch', sessionId: 's', agentId: 'main', workspace: process.cwd(), toolUseIds: [id], createdAt: old, expiresAt: old + 30_000, hostId: 'claude-code', providerId: 'provider', catalogGeneration: 'catalog', policyGeneration: 'policy', status: 'assessed', selection: 'profile', objectiveDigest: 'a'.repeat(64), evidenceDigest: 'b'.repeat(64), retention};
      await writeFile(path, JSON.stringify(record), {mode: 0o600}); await writeFile(`${path}.claim`, '', {mode: 0o600});
      for (const file of [path, `${path}.claim`]) await utimes(file, touched / 1000, touched / 1000);
      return path;
    };
    const expired = await write('expired'); const pinned = await write('pinned', 'pinned'); const proof = await write('retained-proof'); const fresh = await write('recently-restored', 'metadata', now);
    await writeFile(`${proof}.pinned`, 'retained study proof', {mode: 0o600});
    const unknown = join(root, `${batchKey(['unknown'])}.json`); await writeFile(unknown, 'not an owned record', {mode: 0o600}); await utimes(unknown, old / 1000, old / 1000);
    const external = join(root, 'external-proof'); await writeFile(external, 'preserved');
    const link = join(root, `${batchKey(['linked'])}.json`); await symlink(external, link);
    const orphan = join(root, `${batchKey(['orphan'])}.json.claim`); await writeFile(orphan, '', {mode: 0o600}); await utimes(orphan, old / 1000, old / 1000);
    await prepareBatchClaim(join(root, `${batchKey(['new-batch'])}.json`), now);
    await assert.rejects(access(expired)); await assert.rejects(access(`${expired}.claim`)); await assert.rejects(access(orphan));
    for (const path of [pinned, `${pinned}.claim`, proof, `${proof}.claim`, fresh, `${fresh}.claim`, unknown]) await access(path);
    assert.equal((await lstat(link)).isSymbolicLink(), true); assert.equal(await readFile(external, 'utf8'), 'preserved');
    assert.deepEqual(await pruneClaudeBatchRecords(root, now), []);
    assert.equal((await readdir(root)).some(name => name.includes('.lock')), false);
  } finally { await rm(root, {recursive: true, force: true}); }
});
