# Bounded status and explicit receipt audits

## User journey and acceptance

`jev_status {}` reports plugin readiness and the receipts referenced by today's
local index. A large receipt history must not cause this routine health check to
enumerate or parse historical files. A caller that needs reconciliation can use
`jev_status {"fullReceiptScan": true}` to request the existing full local audit.
Neither operation contacts TypeSafe or proves provider billing.

Acceptance requires a deterministic regression that rejects any receipt-directory
enumeration in indexed mode. It also covers missing, corrupt and incomplete
indexes, missing or wrong-date indexed receipts, symlink protection, explicit
full-audit results and cancellation. Existing credential partitions, nullable
billing fields and the reservation-counting basis remain intact.

## Interface and data ownership

The accounting reader gains an explicit `indexed` or `full` scan mode and an
optional abort signal. Its existing internal default remains `full` for callers
that already request an audit. The MCP boundary selects `indexed` unless the
strict boolean `fullReceiptScan` argument is true.

Indexed mode opens the bounded daily index and only its referenced receipts. It
does not enumerate the flat receipt directory, fall back to history or repair
an index. `scanMode` and `scannedFiles` describe the evidence actually read.
`inventoryFiles` and the number of unindexed files are null because this mode
does not observe that inventory. A valid index is best-effort and can omit a
receipt after an interrupted write or once the writer's index bound is reached.
Indexed mode therefore always returns `inventoryComplete: false` and
`countsIncomplete: true`, with a reason that full inventory was not scanned.
Missing or invalid indexes and unreadable or wrong-date entries add diagnostics.
Zero selected receipts never establishes zero actual provider requests.

Full mode retains the historical audit and its current completeness rules.
The MCP boundary disables derived-index publication so both status modes remain
read-only. Other internal callers retain their existing missing-index publication
behavior. The abort signal stops queued reads, closes active handles and is not
converted into an unreadable-receipt count.

## Preservation, privacy and recovery

There is no receipt migration, directory restructuring, credential change,
authentication change or new authority. Existing append-only receipt JSON and
daily indexes remain readable. Receipt and index reads retain no-follow,
regular-file and size checks. Cancellation closes opened file handles. Existing
atomic index publication and concurrent writer behavior remain unchanged.

No daily, byte or session usage cap is added. The host's coding model, selected
Jev model and approval behavior are unchanged. The patch version becomes 0.5.3
so native plugin caches can discover the updated runtime. Both host packages
are generated from the same source and verified for parity. Recovery is the
prior retained package with the same state directory.

## Alternatives and deliberate omissions

Keeping an automatic full fallback preserves a misleading status cost that
grows with all retained history. Date-bucket storage or a transactional catalog
could improve full audits, but would require a separate storage design and
mixed-version migration. This repair instead separates a readiness query from
an explicitly requested audit. It does not certify model quality or reconcile
provider-side billing.
