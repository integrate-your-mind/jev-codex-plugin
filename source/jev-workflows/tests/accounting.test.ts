import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, rm, symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {readEvaluationUsage} from '../src/accounting.js';

const now = new Date('2026-09-18T12:00:00Z');
const key = 'a'.repeat(64);
const otherKey = 'b'.repeat(64);
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'jev-accounting-'));
  await mkdir(join(root, 'receipts'));
  return root;
}
async function receipt(root: string, n: number, fields: Record<string, unknown>) {
  await writeFile(join(root, 'receipts', `${id(n)}.json`), JSON.stringify({receiptId:id(n),timestamp:now.toISOString(),...fields}));
}
function transport(responseStatus: number | null, validatedResponse = false, fingerprint = key) {
  return {requestStartedAt:now.toISOString(), fetchInvoked:true, responseReceivedAt:responseStatus === null ? null : now.toISOString(), responseStatus, validatedResponse, credentialFingerprint:fingerprint, providerRequestId:null};
}
const countFields = [
  'receipts', 'assessed', 'abstained', 'unavailable', 'other',
  'validatedEvaluations', 'legacyEvaluationsWithoutTransport',
  'dispatchAttemptsWithMetadata', 'preDispatchFailures', 'httpResponses', 'httpSuccessResponses',
  'unknownNetworkOutcomes', 'providerRequestIdsPresent',
  'reportedInputTokens', 'reportedOutputTokens',
] as const;
function assertCredentialPartition(result: Awaited<ReturnType<typeof readEvaluationUsage>>) {
  for (const field of countFields) {
    assert.equal(
      result.totals[field],
      result.currentCredential[field] + result.otherCredential[field] + result.unknownCredential[field],
      `${field} must be partitioned by credential attribution`,
    );
  }
}

test('separates reservations, validated and legacy evaluations, HTTP errors, and unknown outcomes', async () => {
  const root = await fixture();
  try {
    await writeFile(join(root, 'budget-2026-09-18.json'), JSON.stringify({calls:13068,bytes:99999}));
    await receipt(root,1,{status:'assessed',usage:{input_tokens:10,output_tokens:2},transport:{...transport(200,true),providerRequestId:'req_1'}});
    await receipt(root,2,{status:'abstained',usage:{input_tokens:20,output_tokens:3},transport:{...transport(200,true),providerRequestId:'req_2'}});
    await receipt(root,3,{status:'unavailable',reasonCode:'rate_limited',transport:transport(429)});
    await receipt(root,4,{status:'unavailable',reasonCode:'timeout',transport:transport(null)});
    await receipt(root,5,{status:'abstained',usage:{input_tokens:30,output_tokens:4}});
    await receipt(root,6,{status:'assessed',usage:{input_tokens:40,output_tokens:5},transport:transport(200,true,otherKey)});
    await receipt(root,7,{status:'assessed',timestamp:'2026-09-17T23:59:59Z',usage:{input_tokens:500,output_tokens:500}});
    const result = await readEvaluationUsage(root,key,now);
    assert.equal(result.totals.receipts,6);
    assert.equal(result.totals.validatedEvaluations,3);
    assert.equal(result.totals.legacyEvaluationsWithoutTransport,1);
    assert.equal(result.totals.httpResponses,4);
    assert.equal(result.totals.httpSuccessResponses,3);
    assert.equal(result.totals.unknownNetworkOutcomes,1);
    assert.equal(result.totals.reportedInputTokens,100);
    assert.equal(result.totals.reportedOutputTokens,14);
    assert.equal(result.currentCredential.receipts,4);
    assert.equal(result.otherCredential.receipts,1);
    assert.equal(result.unknownCredential.receipts,1);
    assertCredentialPartition(result);
    assert.equal(result.uniqueProviderRequestIds,2);
    assert.equal(result.providerBilledRequests,null);
    assert.equal(result.providerBilledTokens,null);
    assert.equal(result.billingReconciled,false);
    assert.equal(result.inventoryReadable,true);
  } finally { await rm(root,{recursive:true,force:true}); }
});

test('counts duplicate provider IDs separately and flags malformed receipts without reading symlinks', async () => {
  const root = await fixture();
  try {
    for (const n of [1,2]) await receipt(root,n,{status:'assessed',transport:{...transport(200,true),providerRequestId:'req_same'}});
    await writeFile(join(root,'receipts',`${id(3)}.json`),'partial-json');
    await writeFile(join(root,'private.json'),JSON.stringify({receiptId:id(4),timestamp:now.toISOString(),status:'assessed'}));
    await symlink(join(root,'private.json'),join(root,'receipts',`${id(4)}.json`));
    const result = await readEvaluationUsage(root,key,now);
    assert.equal(result.totals.receipts,2);
    assert.equal(result.uniqueProviderRequestIds,1);
    assert.equal(result.duplicateProviderRequestIds,1);
    assert.equal(result.malformedOrUnreadable,1);
    assert.equal(result.inventoryReadable,false);
  } finally { await rm(root,{recursive:true,force:true}); }
});

test('a null current fingerprint classifies known fingerprints as other and preserves every partition invariant', async () => {
  const root = await fixture();
  try {
    await receipt(root,1,{status:'assessed',usage:{input_tokens:10,output_tokens:2},transport:{...transport(200,true),providerRequestId:'req_1'}});
    await receipt(root,2,{status:'abstained',usage:{input_tokens:20,output_tokens:3}});
    const result = await readEvaluationUsage(root,null,now);
    assert.equal(result.currentCredential.receipts,0);
    assert.equal(result.otherCredential.receipts,1);
    assert.equal(result.unknownCredential.receipts,1);
    assertCredentialPartition(result);
  } finally { await rm(root,{recursive:true,force:true}); }
});

test('an absent receipt directory is a readable empty inventory without claiming zero provider billing', async () => {
  const root = await mkdtemp(join(tmpdir(),'jev-accounting-empty-'));
  try {
    const result = await readEvaluationUsage(root,null,now);
    assert.equal(result.totals.receipts,0);
    assert.equal(result.inventoryFiles,0);
    assert.equal(result.malformedOrUnreadable,0);
    assert.equal(result.inventoryReadable,true);
    assertCredentialPartition(result);
    assert.equal(result.providerBilledRequests,null);
    assert.equal(result.billingReconciled,false);
  } finally { await rm(root,{recursive:true,force:true}); }
});

test('an unreadable receipt inventory reports unreadable evidence without claiming billing', async () => {
  const root = await mkdtemp(join(tmpdir(),'jev-accounting-unreadable-'));
  try {
    await writeFile(join(root,'receipts'),'not-a-directory');
    const result = await readEvaluationUsage(root,key,now);
    assert.equal(result.totals.receipts,0);
    assert.equal(result.inventoryFiles,0);
    assert.equal(result.malformedOrUnreadable,1);
    assert.equal(result.inventoryReadable,false);
    assertCredentialPartition(result);
    assert.equal(result.providerBilledRequests,null);
    assert.equal(result.billingReconciled,false);
  } finally { await rm(root,{recursive:true,force:true}); }
});
