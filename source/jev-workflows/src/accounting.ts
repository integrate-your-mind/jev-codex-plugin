import {constants} from 'node:fs';
import {open, readdir} from 'node:fs/promises';
import {join} from 'node:path';

const receiptName = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.json$/i;
type Counts = ReturnType<typeof emptyCounts>;
function emptyCounts() {
  return {
    receipts: 0, assessed: 0, abstained: 0, unavailable: 0, other: 0,
    validatedEvaluations: 0, legacyEvaluationsWithoutTransport: 0,
    dispatchAttemptsWithMetadata: 0, preDispatchFailures: 0, httpResponses: 0, httpSuccessResponses: 0,
    unknownNetworkOutcomes: 0, providerRequestIdsPresent: 0,
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
  // These are provider-reported fields retained locally, not billing totals.
  if (evaluated && Number.isSafeInteger(receipt.usage?.input_tokens) && receipt.usage.input_tokens >= 0 &&
      Number.isSafeInteger(receipt.usage?.output_tokens) && receipt.usage.output_tokens >= 0) {
    target.reportedInputTokens += receipt.usage.input_tokens;
    target.reportedOutputTokens += receipt.usage.output_tokens;
  }
}

/** Summarize a frozen filename inventory without altering historical records. */
export async function readEvaluationUsage(directory: string, credentialFingerprint: string | null, now = new Date()) {
  const date = now.toISOString().slice(0, 10);
  const totals = emptyCounts();
  const currentCredential = emptyCounts();
  const otherCredential = emptyCounts();
  const unknownCredential = emptyCounts();
  const requestIds = new Set<string>();
  const localIds = new Set<string>();
  let malformedOrUnreadable = 0;
  let duplicateLocalReceiptIds = 0;
  let duplicateProviderRequestIds = 0;
  let files: string[];
  try { files = (await readdir(join(directory, 'receipts'), {withFileTypes: true})).filter(f => f.isFile() && receiptName.test(f.name)).map(f => f.name).sort(); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') malformedOrUnreadable++;
    files = [];
  }
  let index = 0;
  await Promise.all(Array.from({length: 8}, async () => {
    while (index < files.length) {
      const name = files[index++]!;
      let handle;
      try {
        handle = await open(join(directory, 'receipts', name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > 65536) throw new Error('invalid_receipt_file');
        const receipt = JSON.parse(await handle.readFile('utf8'));
        if (!receipt || typeof receipt !== 'object' || receipt.receiptId !== name.slice(0, -5) || typeof receipt.timestamp !== 'string' || !Number.isFinite(Date.parse(receipt.timestamp))) throw new Error('invalid_receipt');
        if (new Date(receipt.timestamp).toISOString().slice(0, 10) !== date) continue;
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
  return {
    date, timeZone: 'UTC', inventoryAt: now.toISOString(), completedAt: new Date().toISOString(),
    scope: 'Retained local receipts in this state directory; all workspaces and credential histories.',
    inventoryFiles: files.length, totals, currentCredential, otherCredential, unknownCredential,
    uniqueProviderRequestIds: requestIds.size, duplicateProviderRequestIds, duplicateLocalReceiptIds,
    malformedOrUnreadable, inventoryReadable: malformedOrUnreadable === 0,
    providerBilledRequests: null, providerBilledTokens: null, billingReconciled: false,
    note: 'Reservations are separate from these receipt counts. Legacy evaluations lack transport/key attribution. Cached returns reuse a receipt and are not new requests. Missing responses are unknown outcomes. Receipts never published or no longer present cannot be detected by this inventory. Locally retained token usage is not a provider billing ledger. New receipts created after the inventory are excluded.',
  };
}
