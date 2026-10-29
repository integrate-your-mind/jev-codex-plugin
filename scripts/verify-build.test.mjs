import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {mkdtemp, mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {promisify} from 'node:util';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {entryPoints, standaloneSkills} from '../source/jev-workflows/scripts/build-outputs.mjs';

const exec = promisify(execFile);
const verifier = fileURLToPath(new URL('./verify-build.mjs', import.meta.url));
test('build verification rejects source and standalone bundles that a build silently repairs', async () => {
  const owned = fileURLToPath(new URL('../.agent-work/', import.meta.url));
  await mkdir(owned, {recursive: true});
  const fixture = await mkdtemp(join(owned, 'jev-build-drift-'));
  const paths = [...Object.keys(entryPoints).map(name => `dist/${name}.mjs`), ...standaloneSkills.map(skill => `skills/${skill}/scripts/jev.mjs`)];
  try {
    for (const path of [...paths, 'scripts/build.mjs']) await mkdir(join(fixture, path, '..'), {recursive: true});
    await writeFile(join(fixture, 'scripts/build.mjs'), `import {writeFileSync} from 'node:fs';\nfor (const path of ${JSON.stringify(paths)}) writeFileSync(path, 'generated runtime\\n');\n`);
    for (const path of paths) await writeFile(join(fixture, path), 'generated runtime\n');
    await exec(process.execPath, [verifier, '--source', fixture]);
    for (const path of ['dist/server.mjs', 'skills/classify-decision/scripts/jev.mjs']) {
      await writeFile(join(fixture, path), 'stale release runtime\n');
      await assert.rejects(exec(process.execPath, [verifier, '--source', fixture]), /Build changed retained release outputs/);
      assert.equal(await readFile(join(fixture, path), 'utf8'), 'generated runtime\n');
    }
    const obsolete = join(fixture, 'dist/old-entry.mjs');
    await writeFile(obsolete, 'obsolete runtime\n');
    await assert.rejects(exec(process.execPath, [verifier, '--source', fixture]), /Unexpected retained dist files/);
    await rm(obsolete);
    await writeFile(join(fixture, 'scripts/build.mjs'), 'process.exit(7);\n');
    await assert.rejects(exec(process.execPath, [verifier, '--source', fixture]), error => error.code === 7);
  } finally {
    await rm(fixture, {recursive: true, force: true});
  }
});
