import {constants} from 'node:fs';
import {open, readdir, link, unlink} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';

const receiptName = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.json$/i;
type Counts = ReturnType<typeof emptyCounts>;
function emptyCounts() {
  return {
    receipts: 0, assessed: 0, abstained: 0, unavailable: 0, other: 0,
    validatedEvaluations: 0, legacyEvaluationsWithoutTransport: 0,
    dispatchAttemptsWithMetadata: 0, preDispatchFailures: 0, httpResponses: 0, httpSuccessResponses: 0,
    unknownNetworkOutcomes: 0, providerRequestIdsPresent: 0, cacheReuses: 0,
    retryLikeResponses: 0, billedUsageKnown: 0,
    reportedInputTokens: 0, reportedOutputTokens: 0,
  };
}
function add(target: Counts, receipt: Record<string, any>) {
  target.receipts++;
  if (receipt.status === 'assessed') target.assessed++;
  else if (receipt.status === 'abstained') target.abstained++;
  else if (receipt.status === 'unavailable') target.unavailable++;
  else target.other++;
  const evaluated = receipt.status === 'assessed' || receipt.status === 'abstained';
  const transport = receipt.transport;
  if (transport && typeof transport === 'object') {
    if (transport.fetchInvoked === true) target.dispatchAttemptsWithMetadata++;
    else if (transport.fetchInvoked === false) target.preDispatchFailures++;
    if (Number.isInteger(transport.responseStatus) && transport.responseStatus >= 100 && transport.responseStatus <= 599) {
      target.httpResponses++;
      if (transport.responseStatus >= 200 && transport.responseStatus < 300) target.httpSuccessResponses++;
    } else if (transport.fetchInvoked === true) target.unknownNetworkOutcomes++;
    if (evaluated && transport.validatedResponse === true) target.validatedEvaluations++;
    if (typeof transport.providerRequestId === 'string' && transport.providerRequestId.length > 0) target.providerRequestIdsPresent++;
  } else if (evaluated) target.legacyEvaluationsWithoutTransport++;
  if (receipt.cached === true || transport?.cacheHit === true) target.cacheReuses++;
  // Billing is intentionally unknown. A caller field or provider token count
  // cannot turn this local inventory into an independently verified ledger.
  // These are provider-reported fields retained locally, not billing totals.
  if (evaluated && Number.isSafeInteger(receipt.usage?.input_tokens) && receipt.usage.input_tokens >= 0 &&
      Number.isSafeInteger(receipt.usage?.output_tokens) && receipt.usage.output_tokens >= 0) {
    target.reportedInputTokens += receipt.usage.input_tokens;
    target.reportedOutputTokens += receipt.usage.output_tokens;
  }
}

type ReceiptIndex = {version: 1; date: string; receiptIds: string[]};
type IndexState = {
  status: 'used' | 'missing' | 'corrupt';
  indexedFiles: number;
  unindexedFiles: number;
  missingIndexedFiles: number;
  indexDateMismatches: number;
  duplicateIndexedIds: number;
  fallbackUsed: boolean;
  fallbackReason: 'missing_index' | 'corrupt_index' | 'index_gap' | 'index_date_mismatch' | null;
};

type InventoryCompleteness = {
  complete: boolean;
  reasons: string[];
};

const validReceiptId = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const MAX_INDEX_BYTES = 1024 * 1024;

async function loadIndex(directory: string, date: string): Promise<{index: ReceiptIndex | null; state: IndexState}> {
  const state: IndexState = {status: 'missing', indexedFiles: 0, unindexedFiles: 0, missingIndexedFiles: 0, indexDateMismatches: 0, duplicateIndexedIds: 0, fallbackUsed: false, fallbackReason: null};
  const path = join(directory, `receipt-index-${date}.json`);
  let handle;
  try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {index: null, state};
    state.status = 'corrupt'; state.fallbackUsed = true; state.fallbackReason = 'corrupt_index'; return {index: null, state};
  }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_INDEX_BYTES) throw new Error('invalid_receipt_index');
    const value = JSON.parse(await handle.readFile('utf8')) as Partial<ReceiptIndex>;
    if (value.version !== 1 || value.date !== date || !Array.isArray(value.receiptIds) ||
        value.receiptIds.some(id => typeof id !== 'string' || !validReceiptId.test(id))) throw new Error('invalid_receipt_index');
    const ids = value.receiptIds as string[];
    state.duplicateIndexedIds = ids.length - new Set(ids).size;
    if (state.duplicateIndexedIds > 0) throw new Error('duplicate_receipt_index');
    state.status = 'used'; state.indexedFiles = ids.length;
    return {index: {version: 1, date, receiptIds: ids}, state};
  } catch {
    state.status = 'corrupt'; state.fallbackUsed = true; state.fallbackReason = 'corrupt_index';
    return {index: null, state};
  } finally { await handle.close(); }
}

async function publishMissingIndex(directory: string, date: string, receiptIds: Iterable<string>): Promise<void> {
  const path = join(directory, `receipt-index-${date}.json`);
  const temporary = join(directory, `.receipt-index-${randomUUID()}.tmp`);
  const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    await handle.writeFile(JSON.stringify({version: 1, date, receiptIds: [...receiptIds]}) + '\n');
    await handle.sync();
  } finally { await handle.close(); }
  try { await link(temporary, path); }
  finally { await unlink(temporary).catch(() => {}); }
}

/** Summarize a frozen filename inventory without altering historical records. */
export async function readEvaluationUsage(directory: string, credentialFingerprint: string | null, now = new Date()) {
  const date = now.toISOString().slice(0, 10);
  let totals = emptyCounts();
  let currentCredential = emptyCounts();
  let otherCredential = emptyCounts();
  let unknownCredential = emptyCounts();
  let requestIds = new Set<string>();
  let localIds = new Set<string>();
  let malformedOrUnreadable = 0;
  let duplicateLocalReceiptIds = 0;
  let duplicateProviderRequestIds = 0;
  let files: string[];
  try { files = (await readdir(join(directory, 'receipts'), {withFileTypes: true})).filter(f => f.isFile() && receiptName.test(f.name)).map(f => f.name).sort(); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') malformedOrUnreadable++;
    files = [];
  }
  const loadedIndex = await loadIndex(directory, date);
  const fileSet = new Set(files);
  const indexedReceiptIds = new Set(loadedIndex.index?.receiptIds ?? []);
  let candidateFiles: string[];
  let fullInventoryScanned = loadedIndex.index === null;
  if (loadedIndex.index) {
    candidateFiles = [];
    for (const receiptId of loadedIndex.index.receiptIds) {
      const name = `${receiptId}.json`;
      if (fileSet.has(name)) candidateFiles.push(name);
      else loadedIndex.state.missingIndexedFiles++;
    }
    // The flat receipts directory can contain legacy same-day receipts that
    // predate daily indexing, as well as receipts from other days. If the
    // index does not cover every filename, scan the full inventory so today's
    // totals are correct; the timestamp filter below excludes other days.
    loadedIndex.state.unindexedFiles = files.length - candidateFiles.length;
    if (loadedIndex.state.unindexedFiles > 0 || loadedIndex.state.missingIndexedFiles > 0) {
      candidateFiles = files;
      fullInventoryScanned = true;
      loadedIndex.state.fallbackUsed = true;
      loadedIndex.state.fallbackReason = 'index_gap';
    }
  } else {
    candidateFiles = files;
    loadedIndex.state.fallbackUsed = loadedIndex.state.status !== 'missing' || files.length > 0;
    if (loadedIndex.state.fallbackReason === null && loadedIndex.state.fallbackUsed) loadedIndex.state.fallbackReason = loadedIndex.state.status === 'missing' ? 'missing_index' : 'corrupt_index';
  }
  const scan = async (names: string[]): Promise<void> => {
    let index = 0;
    await Promise.all(Array.from({length: 8}, async () => {
      while (index < names.length) {
        const name = names[index++]!;
        let handle;
        try {
          handle = await open(join(directory, 'receipts', name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
          const stat = await handle.stat();
          if (!stat.isFile() || stat.size > 65536) throw new Error('invalid_receipt_file');
          const receipt = JSON.parse(await handle.readFile('utf8'));
          if (!receipt || typeof receipt !== 'object' || receipt.receiptId !== name.slice(0, -5) || typeof receipt.timestamp !== 'string' || !Number.isFinite(Date.parse(receipt.timestamp))) throw new Error('invalid_receipt');
          if (new Date(receipt.timestamp).toISOString().slice(0, 10) !== date) {
            if (loadedIndex.index && indexedReceiptIds.has(receipt.receiptId)) loadedIndex.state.indexDateMismatches++;
            continue;
          }
          if (localIds.has(receipt.receiptId)) { duplicateLocalReceiptIds++; continue; }
          localIds.add(receipt.receiptId);
          add(totals, receipt);
          const fingerprint = receipt.transport?.credentialFingerprint;
          if (typeof fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(fingerprint)) add(unknownCredential, receipt);
          else if (credentialFingerprint && fingerprint === credentialFingerprint) add(currentCredential, receipt);
          else add(otherCredential, receipt);
          const providerId = receipt.transport?.providerRequestId;
          if (typeof providerId === 'string' && /^[A-Za-z0-9._:-]{1,256}$/.test(providerId)) {
            const key = `${fingerprint ?? 'unknown'}:${providerId}`;
            if (requestIds.has(key)) duplicateProviderRequestIds++;
            requestIds.add(key);
          }
        } catch { malformedOrUnreadable++; }
        finally { await handle?.close(); }
      }
    }));
  };
  await scan(candidateFiles);
  // A date mismatch is only discoverable by opening an indexed receipt. Once
  // found, rescan the full inventory to recover any valid same-day evidence
  // that the stale index omitted.
  if (loadedIndex.index && !fullInventoryScanned && loadedIndex.state.indexDateMismatches > 0) {
    totals = emptyCounts();
    currentCredential = emptyCounts();
    otherCredential = emptyCounts();
    unknownCredential = emptyCounts();
    requestIds = new Set<string>();
    localIds = new Set<string>();
    malformedOrUnreadable = 0;
    duplicateLocalReceiptIds = 0;
    duplicateProviderRequestIds = 0;
    loadedIndex.state.indexDateMismatches = 0;
    fullInventoryScanned = true;
    loadedIndex.state.fallbackUsed = true;
    loadedIndex.state.fallbackReason = 'index_date_mismatch';
    await scan(files);
  }
  if (loadedIndex.index && fullInventoryScanned) {
    // Report the number of current-day receipts outside the index after the
    // full scan. Historical receipts are intentionally excluded from this
    // diagnostic.
    loadedIndex.state.unindexedFiles = [...localIds].filter(id => !indexedReceiptIds.has(id)).length;
  }
  if (loadedIndex.state.status === 'missing' && localIds.size > 0) {
    // Persist only a new daily index. A corrupt or existing index is never
    // replaced, and receipt files remain append-only historical evidence.
    await publishMissingIndex(directory, date, localIds).catch(() => {});
  }
  totals.retryLikeResponses = duplicateProviderRequestIds;
  // `inventoryReadable` answers whether the files we attempted to read were
  // readable. It does not mean that the returned totals cover every receipt:
  // a valid daily index can omit a receipt published while index maintenance
  // was interrupted. Keep that distinction explicit for callers that need
  // exact accounting.
  const incompleteReasons: string[] = [];
  if (malformedOrUnreadable > 0) incompleteReasons.push('malformed_or_unreadable_receipts');
  if (!fullInventoryScanned && loadedIndex.state.missingIndexedFiles > 0) incompleteReasons.push('missing_indexed_receipts');
  if (!fullInventoryScanned && loadedIndex.state.unindexedFiles > 0) incompleteReasons.push('unindexed_receipts');
  if (!fullInventoryScanned && loadedIndex.state.indexDateMismatches > 0) incompleteReasons.push('indexed_receipt_date_mismatch');
  const completeness: InventoryCompleteness = {
    complete: incompleteReasons.length === 0,
    reasons: incompleteReasons,
  };
  return {
    date, timeZone: 'UTC', inventoryAt: now.toISOString(), completedAt: new Date().toISOString(),
    scope: 'Retained local receipts in this state directory; all workspaces and credential histories.',
    inventoryFiles: files.length, totals, currentCredential, otherCredential, unknownCredential,
    uniqueProviderRequestIds: requestIds.size, duplicateProviderRequestIds, duplicateLocalReceiptIds,
    malformedOrUnreadable, inventoryReadable: malformedOrUnreadable === 0 && loadedIndex.state.status !== 'corrupt' && loadedIndex.state.indexDateMismatches === 0,
    index: loadedIndex.state,
    indexStatus: loadedIndex.state.status,
    indexFallbackUsed: loadedIndex.state.fallbackUsed,
    indexFallbackReason: loadedIndex.state.fallbackReason,
    unindexedReceiptFiles: loadedIndex.state.unindexedFiles,
    missingIndexedReceiptFiles: loadedIndex.state.missingIndexedFiles,
    indexDateMismatches: loadedIndex.state.indexDateMismatches,
    inventoryComplete: completeness.complete,
    countsIncomplete: !completeness.complete,
    countsIncompleteReason: completeness.reasons.length > 0 ? completeness.reasons.join(',') : null,
    providerBilledRequests: null, providerBilledTokens: null, billingReconciled: false,
    note: 'Reservations are separate from these receipt counts. Legacy evaluations lack transport/key attribution. Cached returns reuse a receipt and are not new requests. Missing responses are unknown outcomes. Receipts never published or no longer present cannot be detected by this inventory. Locally retained token usage is not a provider billing ledger. A valid daily index avoids parsing historical receipts; unindexed or missing entries are reported. New receipts created after the inventory are excluded.',
  };
}
