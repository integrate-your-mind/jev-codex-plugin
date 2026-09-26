import assert from 'node:assert/strict';
import {lstat} from 'node:fs/promises';
import test from 'node:test';

import {BASE_COMMIT, PATCH_SHA256, verifyMaterializedVariants} from './source-integrity.mjs';

test('both complete source trees reproduce from the exact Git base and patch', async () => {
  const identity = await verifyMaterializedVariants();
  assert.equal(identity.baseCommit, BASE_COMMIT);
  assert.equal(identity.patch.sha256, PATCH_SHA256);
  assert.equal(identity.trees['control-released'].files.length, 16);
  assert.equal(identity.trees['candidate-bundled-repair'].files.length, 16);
  assert.notEqual(identity.trees['control-released'].sha256, identity.trees['candidate-bundled-repair'].sha256);
  const changed = identity.trees['candidate-bundled-repair'].files.filter(file => {
    const baseline = identity.trees['control-released'].files.find(item => item.path === file.path);
    return baseline?.sha256 !== file.sha256;
  });
  assert.deepEqual(changed.map(file => file.path), ['decision-hook.ts']);
  for (const tree of Object.values(identity.trees)) {
    assert.equal((await lstat(tree.path.startsWith('/') ? tree.path : new URL(`../../../${tree.path}`, import.meta.url))).isSymbolicLink(), false);
  }
});

