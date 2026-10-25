# Candidate-delivery component experiment

This directory contains one executable development slice: four authored
candidate-delivery cases, two repeats, and two counterbalanced arms (16 frozen
rows). The control is the exact released source at
`7dfe432d7463bab7186a8dacf50924af282f9a20`. The candidate is that Git tree with
the exact `repair-source.patch` whose SHA-256 is
`f3b3d35a0fec2e62f3b2c2a025fdafe1d4516ee360a21f67e959d24e2fcfd5f2`.
The patch bundles delivery validation, catalog-aligned questioning, and context
projection, so this experiment cannot assign an individual causal effect to any
one of those changes.

This is a hook-component study. All four rows are normalized into a
`PreToolUse` call to `runDecisionHook` with the authored candidate catalog.
The original `native_hook` and `explicit_mcp` labels and MCP method names are
retained in each private result as provenance. The slice does not invoke an
MCP tool or exercise native candidate-catalog discovery.

`source-integrity.mjs` reconstructs both arms from Git for every review/gate and
compares all 16 source files against the checked-in materializations. Runtime
copies are disposable and link to the existing
`source/jev-workflows/node_modules`; this directory retains no `node_modules`
symlink or duplicate build.

`run-attempt.mjs` is the single state machine used by offline and live modes. A
row makes exactly one real `runDecisionHook` invocation. It records request,
validated response, hook delivery, sandboxed fixture action, and independent
postcondition as separate stages. Only an assessed candidate actually present
in hook output and available in the authored catalog can reach the action
engine. Raw service receipts, rankings, or abstained choices never supply an
action. An undelivered control choice remains no-action/unknown even when an
untouched fixture would happen to satisfy an absence-only oracle.

Each output root is mode `0700`. Reservation, event journal, result, and plugin
receipt files are mode `0600`; reservations, results, and completion receipts
use exclusive creation and file plus parent-directory sync. A completion
receipt binds the exact row and reviewed-manifest identity to SHA-256 and byte
counts for the reservation, result, and fsynced journal. A prior row is treated
as complete only when those identities and hashes validate. Every other
existing reservation remains ambiguous and is never rerun. The private result
retains exact service and invocation receipts, request payload, bounded
response, request duration, full operation duration, and provider request
identifier when one exists. Cleanup failure makes the harness result an error.
The console summary reports only whether an identifier was retained.

Run the deterministic plumbing slice with Node 22 and the shared TypeScript
loader:

```sh
node \
  --import ./source/jev-workflows/node_modules/tsx/dist/loader.mjs \
  benchmarks/plugin-development/experiment/execute-slice.mjs
```

This mode uses local `Response` objects, makes no network request, and claims no
provider request IDs. By default it removes its temporary row state after
returning the summary. An absolute `--out` path retains private test receipts.
Passing proves runner plumbing and authored fixture behavior only; it is not a
native-host or provider-quality result.

Generate the deterministic root-review packet without a provider call:

```sh
node \
  --import ./source/jev-workflows/node_modules/tsx/dist/loader.mjs \
  benchmarks/plugin-development/experiment/run.mjs --dry-run
```

The emitted manifest is intentionally `unreviewed`. A reviewer must save the
exact manifest, change `review` to include `status: "reviewed"`, a non-empty
`reviewedBy`, and an ISO `reviewedAt`, then approve the SHA-256 of those exact
bytes. Live mode also requires Node `v22.23.2`, an existing credential source,
`JEV_RUN_LIVE_EXPERIMENT=1`, the absolute reviewed manifest path, its exact
SHA-256, and an absolute private output root. The gate recomputes every source,
patch, input, oracle, schedule, runner, fixture-engine, fixture-tree, package,
lockfile, and release-metadata hash before reserving the first row and again
immediately before every row reservation. The frozen provider contract expects
endpoint `https://api.typesafe.ai/v1/systemone`, response model version
`jev-1.13.0`, and plugin runtime `0.4.0`. A response-model mismatch is retained
and marked `model_drift`; it cannot reach an action.

The live pathway is implemented in `live-run.mjs` but has not been invoked.
Changed-requirement, restart, context-selection, and outcome-recording strata
remain unsupported by the current real hook API. Shared-state batching remains
the separate existing batch cohort. No installed plugin, default, quota, or
DeepSWE artifact is changed or consulted here.
