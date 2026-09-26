import {createHash} from 'node:crypto';
import {lstat, readFile} from 'node:fs/promises';
import {isAbsolute, resolve} from 'node:path';

import {verifyFrozenContent} from './freeze.mjs';

const SHA256 = /^[a-f0-9]{64}$/;

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function verifyCredentialBoundary(env) {
  if (env.JEV_API_KEY_FILE) {
    if (!isAbsolute(env.JEV_API_KEY_FILE)) throw new Error('JEV_API_KEY_FILE must be absolute');
    const info = await lstat(env.JEV_API_KEY_FILE);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('credential file must be a regular file');
    if ((info.mode & 0o077) !== 0) throw new Error('credential file must not be group/world accessible');
    return;
  }
  if (!env.TYPESAFE_API_KEY) throw new Error('live run requires an existing credential source');
}

/** Verify review authorization and every frozen byte before any output is reserved. */
export async function requireReviewedManifest({
  manifestPath = process.env.JEV_LIVE_MANIFEST,
  reviewedSha256 = process.env.JEV_REVIEWED_MANIFEST_SHA256,
  env = process.env,
  processVersion = process.version,
} = {}) {
  if (env.JEV_RUN_LIVE_EXPERIMENT !== '1') {
    throw new Error('live mode disabled; set JEV_RUN_LIVE_EXPERIMENT=1 only after review');
  }
  if (processVersion !== 'v22.23.2') throw new Error(`live mode requires Node v22.23.2; found ${processVersion}`);
  if (!manifestPath || !isAbsolute(manifestPath)) throw new Error('live mode requires an absolute JEV_LIVE_MANIFEST path');
  if (!SHA256.test(reviewedSha256 ?? '')) throw new Error('live mode requires JEV_REVIEWED_MANIFEST_SHA256');
  const absolute = resolve(manifestPath);
  const info = await lstat(absolute);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024) throw new Error('live manifest must be a bounded regular file');
  const bytes = await readFile(absolute);
  const actualSha256 = digest(bytes);
  if (actualSha256 !== reviewedSha256) throw new Error('reviewed live manifest SHA-256 mismatch');
  const manifest = JSON.parse(bytes.toString('utf8'));
  if (manifest.review?.status !== 'reviewed' || typeof manifest.review?.reviewedBy !== 'string' || !manifest.review.reviewedBy.trim()) {
    throw new Error('live manifest has not been reviewed');
  }
  if (typeof manifest.review?.reviewedAt !== 'string' || !Number.isFinite(Date.parse(manifest.review.reviewedAt))) {
    throw new Error('live manifest review timestamp is invalid');
  }
  if (manifest.experiment?.providerCalls !== true || manifest.experiment?.oraclePassedToProvider !== false) {
    throw new Error('live manifest has an unsafe provider boundary');
  }
  const verified = await verifyFrozenContent(manifest);
  await verifyCredentialBoundary(env);
  return {...verified, manifestPath: absolute, manifestSha256: actualSha256};
}

