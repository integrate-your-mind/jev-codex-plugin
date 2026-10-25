import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { bugs } from './bugs.mjs';

test('historical graph bugs have frozen organic prompts and exact provenance', () => {
  assert.equal(bugs.length, 3);
  const ids = new Set();
  for (const bug of bugs) {
    assert.match(bug.id, /^[a-z0-9-]+$/);
    assert.ok(!ids.has(bug.id)); ids.add(bug.id);
    assert.match(bug.prefixSha, /^[0-9a-f]{40}$/);
    assert.match(bug.fixSha, /^[0-9a-f]{40}$/);
    assert.ok(bug.prompt.length > 100);
    assert.equal(bug.prompt.includes(bug.prefixSha), false);
    assert.equal(bug.prompt.includes(bug.fixSha), false);
    assert.equal(bug.prompt.includes('grader'), false);
  }
});

test('every historical prefix fails and corresponding fix passes before provider execution', async () => {
  for (const bug of bugs) {
    const prefix = await mkdtemp(path.join(os.tmpdir(), `jev-graph-${bug.id}-prefix-`));
    const fix = await mkdtemp(path.join(os.tmpdir(), `jev-graph-${bug.id}-fix-`));
    try {
      await bug.materialize(prefix, {revision:'prefix'});
      await bug.materialize(fix, {revision:'fix'});
      const red = await bug.grade(prefix);
      const green = await bug.grade(fix);
      assert.equal(red.passed, false, `${bug.id} prefix unexpectedly passed: ${JSON.stringify(red)}`);
      assert.equal(green.passed, true, `${bug.id} fix failed: ${JSON.stringify(green)}`);
    } finally {
      await rm(prefix, {recursive:true, force:true});
      await rm(fix, {recursive:true, force:true});
    }
  }
});
