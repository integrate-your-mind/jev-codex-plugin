#!/usr/bin/env node
import {execFile as execFileCallback} from 'node:child_process';
import {dirname, join, resolve} from 'node:path';
import {promisify} from 'node:util';
import {fileURLToPath, pathToFileURL} from 'node:url';

import {buildFreezeManifest} from './freeze.mjs';

const execFile = promisify(execFileCallback);
const dir = dirname(fileURLToPath(import.meta.url));
const casesDir = resolve(dir, '../cases');

export async function buildReviewPacket() {
  const {stdout, stderr} = await execFile(process.execPath, [join(casesDir, 'check.mjs')], {cwd: casesDir});
  const manifest = await buildFreezeManifest();
  return {
    schemaVersion: 'plugin-development-review-packet-v2',
    status: 'ready-for-root-review',
    fixtureCheck: {status: 'passed', stdout: stdout.trim(), stderr: stderr.trim()},
    externalProviderCalls: false,
    nativeHostAttempts: false,
    liveRunInvoked: false,
    executableOfflineSlice: 'execute-slice.mjs',
    liveRunner: 'live-run.mjs',
    manifest,
    reviewRequired: 'Set review.status=reviewed with reviewedBy/reviewedAt in a saved manifest, compute its SHA-256, and supply that exact digest to the live gate.',
  };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== '--dry-run')) throw new Error('usage: run.mjs [--dry-run]');
  process.stdout.write(`${JSON.stringify(await buildReviewPacket(), null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
