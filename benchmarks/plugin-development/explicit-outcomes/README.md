# Explicit outcome storage contract experiment

This bounded offline experiment connects the four authored `outcome-*` cases to
the real `recordDecisionOutcome` TypeScript API. It calls the function directly;
it does not invoke MCP transport, a provider, a model, an installed plugin, or a
grading service.

The runner verifies that the current `outcomes.ts` and `store.ts` bytes match
the source at frozen commit `7dfe432d7463bab7186a8dacf50924af282f9a20`.
`freeze.json` also binds the four fixture trees, shared fixture engine, experiment
configuration, runner, regression tests, package metadata, and installed `tsx`
and `zod` versions used by the offline check.

Each case gets a persisted UUID receipt in a newly created private temporary
state directory. These receipts are labeled synthetic, say that no provider was
contacted, contain no provider request ID, and make no action-success claim. The
runner supplies exactly one action-ID alias, one evidence-reference array, one
caller observation, `callerReported: true`, and `observedAt`. The fixture fields
`status`, `claim`, `revision`, `exitCode`, and `stdoutDigest` are harness inputs;
they are never sent as API fields.

All four fixture caller reports say `verified`, so the faithful API translation
is the caller observation `supported`, including reports later shown to be
false or insufficient. The runner reads back each saved plugin record and
requires `provenance.independentlyVerified` to remain `false`. It separately
runs the existing fixture's canonical action and artifact oracle. The resulting
independent assessments are:

| Case | Plugin stores caller observation | Independent harness assessment |
| --- | --- | --- |
| `outcome-normal` | `supported` | `supported` |
| `outcome-conflict` | `supported` | `unknown` because remote readback is missing |
| `outcome-stale` | `supported` | `unsupported` for the current revision |
| `outcome-adversarial` | `supported` | `contradicted` by the failed action receipt |

The regressions exercise the exported strict schema, a missing receipt, an
invalid persisted receipt, false-claim separation, and two identical
observations. The duplicate calls append two distinct records. That is reported
as absence of deduplication and does not establish action-effect idempotency.

Use Node 22.23.2 and run the full offline check from this directory:

```sh
node check.mjs
```

The check runs under macOS `sandbox-exec` with network denied. It creates only
owned temporary state and removes it. To retain a compact experiment receipt,
run from this directory with a new absolute path in the private evidence area:

```sh
/usr/bin/sandbox-exec -p '(version 1) (allow default) (deny network*)' \
  node \
  --import ../../../source/jev-workflows/node_modules/tsx/dist/loader.mjs \
  run.ts --receipt /absolute/private/evidence/explicit-outcomes-new.json
```

The runner refuses to overwrite a receipt. It removes the exact temporary
storage directory before writing the retained receipt. The semantic outcomes
and denominators are deterministic; API-generated outcome IDs and record times
vary on each run. A pass establishes this local storage and authored-fixture
contract only. Jev does not make the action happen, independently verify it,
deduplicate observations, or prove provider delivery, billing, deployment,
acceptance, or realistic coding quality.
