# Restart recovery benchmark note

This focused synthetic benchmark exercises the decision hook's event-claim
recovery boundary against base `7dfe432d7463bab7186a8dacf50924af282f9a20`.
The restart suite injects its decision service; the accompanying decision-hook
suite uses injected services or fetch responses. These checks make no live
provider or model calls and do not measure decision quality.

New claims use schema version 2. Each pending generation remains immutable;
one exclusive resolution file holds either its terminal assessment or its
successor claim. The two outcomes compete for the same path. Resolution
filenames derive from the root event and attempt UUID, so repeated recovery
does not grow the filename. Recovery does not delete, rename, or reclaim a
canonical lock path. A live PID remains protected even after its lease expires.

Terminal records include the bounded assessment and a versioned semantic
digest of the native event, decision input, and current task context. A matching
duplicate reads back stored advice without calling the service or reapplying
an old prompt. It emits `replayed=true; delivery=unknown`. The digest ignores
only plugin-owned task timestamps; changed requirements, raw event facts,
candidate catalogs, or other semantic evidence reject replay with
`stored_assessment_mismatch`. Malformed records and unavailable stored choices
never become replayed advice. SessionStart has only its fixed local guidance.

Finite admission happens after owner election. Immutable capacity slots are
keyed by root event identity and reused by successors. Legacy roots and roots
created under unlimited policy are imported into those same exclusive slots
before a new finite admission. An importer that loses publication re-reads the
same slot before advancing. Unlimited policy bypasses the slot ledger and
does not serialize distinct events through a session lock.

The regressions cover:

- Matching assessment readback, changed facts and requirements, timestamp-only
  refresh, unchanged context on replay, and malformed terminal records.
- A duplicate paused behind its owner's ticket publication, and two new events
  racing to import one legacy root under a finite cap.
- Finite ticket reuse after a child process exits during the injected service;
  six successive process crashes followed by recovery with fixed filenames.
- Delayed terminal publication after the hook's return deadline, and a
  successor winning the same resolution slot before the delayed terminal.
- Active-owner protection, legacy zero-byte suppression, retained uncertain
  attempt receipts, concurrent owner election, and concurrent recovery.

Publication races use a controlled barrier around the real filesystem hard-link
operation. Some owner-loss races explicitly replace the test claim's PID as
fault injection; those do not simulate an operating-system crash. The separate
child-process cases exit with code 91 during the injected service and recover
the resulting files in another process.

Run from `source/jev-workflows`, supplying a Node 22 executable and an owned
temporary directory:

```sh
TMPDIR=/path/to/owned/tmp "$NODE22_BIN" --import tsx --test --test-concurrency=2 \
  tests/restart-recovery.test.ts tests/decision-hook.test.ts
"$NODE22_BIN" node_modules/typescript/bin/tsc --noEmit
```

The 2026-09-26 focused run used Node 22.23.2 and RAM-backed temporary state:
42 tests passed, zero failed; TypeScript checking and `git diff --check` passed.
This includes 16 restart regressions and 26 existing decision-hook checks, with
two completed-duplicate assertions updated for stored-advice readback.

Remaining boundaries:

- A terminal assessment records local processing with delivery unknown. It
  does not establish stdout delivery, provider-side exactly-once execution,
  independently verified downstream actions, or customer acceptance. A retry
  of an uncertain attempt can make another provider request.
- An already-started filesystem operation can finish after the return deadline.
  The tests bound `runDecisionHook`'s return; they do not establish process-exit
  latency under indefinitely stalled kernel I/O. A late terminal winner remains
  readable, while a late loser cannot replace an elected successor.
- File and directory fsync are used for publication, but these tests do not
  simulate machine power loss or establish durability on every filesystem.
- Legacy empty or malformed roots remain conservatively suppressive and cannot
  yield stored advice. Migration assumes prior-version writers are quiescent;
  concurrent old writers can create unaccounted legacy claims after the scan.
- PID reuse can conservatively suppress recovery. A pending owner in a still
  running process is not reclaimed, including after a timeout. Traversal has a
  64-iteration corruption bound; the tests exercise six recoveries, not that
  boundary. Claims and consumed capacity slots are retained for the session.

## Reconstructing this experimental candidate

This source-only patch is independent of the completed payload-repair study. Apply restart-source.patch to baseline 7dfe432d7463bab7186a8dacf50924af282f9a20, then rebuild from source/jev-workflows. It has not been installed or selected as the improved benchmark treatment. The original frozen control and treatment remain unchanged.

Root independently reviewed the immutable claim protocol and the three corrected failure cases, then rebuilt the source with an owned dependency copy inside the checkout. All 179 plugin tests passed under Node 22.23.2. See validation.json for exact source and patch identities. These are injected-service regressions, not a live provider or task-completion result.
