# Review note

The replaced draft had the same 20 case IDs, but each `source.mjs` exported only
its ID and each `test.mjs` asserted that string. Its checker proved file presence
and schema shape, not candidate delivery, action execution, restart recovery,
secret handling, or a postcondition. The old passing hashes therefore are not
retained as validity evidence.

This revision keeps the authored topics and five-by-four layout, replaces
ambiguous acceptable-choice lists with one canonical artifact-producing action,
and adds a shared bounded execution/verification engine. The completed batching
cohort remains separate and unchanged.

The current runner is macOS-specific (`sandbox-exec` plus Node permissions).
Outcome inputs are harness projections rather than executable MCP request
bodies, and caller-report storage is kept separate from harness verification.

No live provider or native-host request has been made from these fixtures. Root
review is still required before any freeze or live experiment.

The previously reviewed tree hash
`35f78a316a0ceea56ea6f3ca5e7083e21f226de0a9a1fac50d231fcde8e65834`
passed under Node 24.13.0 but failed the pinned Node 22.23.2 gate because the
nested runner used the newer `--test-isolation=none` option. The current runner
executes each authored `node:test` module directly inside the same sandbox. The
failure was a CLI compatibility defect; its output contained no `ENOSPC` error.
