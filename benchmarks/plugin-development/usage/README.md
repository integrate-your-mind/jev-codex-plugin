# Retain reported usage when a response is rejected

This reviewed experimental repair addresses a measurement gap found by the frozen
[typed-batch study](../../results/2026-09-26-typed-batch-v1/README.md). One HTTP 200
response reported 449 input tokens and 19 output tokens, but its Score answer
failed the plugin's semantic validation. The original service discarded those
usage fields, so its serial-arm token total remains unknown in the published study.

The patch preserves usage only after the strict response envelope has validated.
It carries that usage through the provider error and both service error paths into
the returned result and persisted receipt. Local accounting includes these
provider-reported tokens for observed, dispatched HTTP 2xx semantic rejections.
The answer remains unavailable and uncached; no choice or recommendation is
returned. Assessment, validated-evaluation, and billing counters are unchanged.
An HTTP success still describes transport, not a valid decision or a billed request.

The source patch applies to revision
`7dfe432d7463bab7186a8dacf50924af282f9a20`. It is separate from the payload and
restart candidates and has not been installed, combined, or selected for held-out
evaluation. It does not alter the frozen 72-call or 32-call studies or their
exporters. Malformed envelopes, invalid JSON, non-2xx responses, and transport
failures retain their existing unknown-usage behavior.

Validation on Node 22.23.2: 169/169 full plugin tests, typechecking, build, manifest
validation, and independent review passed. Six focused regression tests cover
the observed Score discrepancy, invalid usage, safe/fallback/credential-like
request IDs, single and batch service paths, persistence, caching, and counters.
These are deterministic transport fixtures; no live provider requests or native
task-completion experiments were run for this repair. See `validation.json` for
source and patch hashes.

Apply from a clean checkout of the pinned base:

```sh
git apply --check /path/to/usage-accounting.patch
git apply /path/to/usage-accounting.patch
cd source/jev-workflows
npm ci
npm run build
npm run typecheck
npm test
npm run validate
```

Use the pinned Node version and lockfile. Build outputs used during local checking
are experimental verification artifacts, not a new released plugin distribution.
