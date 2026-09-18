# Accounting and request traceability

Local reservations, completed evaluations, and provider billing are different measurements.

- `budget.reservedAttempts` increments before network dispatch. It includes calls later cancelled, rejected, timed out, or otherwise unavailable. `reservedPayloadBytes` counts serialized request bytes reserved locally, not tokens or money. The older `callsUsed` and `bytesUsed` fields remain compatibility aliases with explicit reservation semantics.
- `evaluations.totals` summarizes a frozen filename inventory of retained local receipts for the UTC day. It separates HTTP responses, successful HTTP statuses, validated evaluations, and unknown network outcomes. A malformed HTTP 200 response is not a validated evaluation. A timeout does not prove the provider did not receive or charge for a request.
- Both assessed and abstained evaluations can include token usage returned by TypeSafe. Abstention is an interpretation of the result, not evidence that no request occurred.
- `currentCredential` uses the current key's SHA-256 fingerprint. Receipts with a different valid fingerprint are counted in `otherCredential`, including when no current fingerprint is available. Receipts without a valid fingerprint stay in `unknownCredential`; every retained evaluation is therefore partitioned into exactly one of these three buckets.
- New receipts retain `transport.fetchInvoked`, request/response timestamps, HTTP status, validation state, and the provider's `x-typesafe-request-id` when present. Alternative observed `x-request-id` or `request-id` headers are supported. Missing IDs remain null. The local `receiptId` is distinct from the provider ID.
- Cached MCP results reuse the original local receipt and provider metadata, have `cached: true`, and do not make a new request or reservation. Previews and missing-key requests do not reserve.
- `providerBilledRequests` and `providerBilledTokens` remain null. No local counter is represented as provider billing. Request IDs and fingerprints aid investigation; they are not independent billing proof.

Receipts publish atomically without replacing an existing ID. `inventoryReadable` is false when the selected receipt directory or a selected UUID-named receipt cannot be read or parsed; it is true for a readable empty inventory, including an absent receipt directory. This flag cannot detect a receipt that was never published or is no longer present, so it is not a completeness or billing claim. Malformed or unreadable entries are counted and are not rewritten. Inventory can lag concurrent work: new files created after listing are excluded, and the sample timestamps are included. Provider billing remains unknown in every case unless it is reconciled against provider-side evidence.

## Reconciliation procedure

Compare the same account/key, workspace scope, UTC window, and dashboard filters. Retain the provider request ID, response UTC timestamp, HTTP status and usage from a controlled synthetic probe. Compare after the provider's stated dashboard delay, ideally against a provider export or support trace. Do not reset local counters, infer billing from status alone, or fabricate IDs for older receipts.

During development, a substantial gap was found between retained local response usage and the dashboard. The old adapter also discarded a provider request-ID header that a direct probe confirmed exists. This release fixes the adapter's missing traceability and misleading counter semantics. It does not claim a root cause for a provider-dashboard discrepancy without provider-side corroboration.

[TypeSafe API reference](https://docs.typesafe.ai/api)
