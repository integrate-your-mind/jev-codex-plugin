import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

test('checks only the local build descriptor', async () => {
  const build = JSON.parse(await readFile(new URL('../config/build.json', import.meta.url), 'utf8'));
  assert.deepEqual(build, {status: 'built', revision: 'local-1'});
});
