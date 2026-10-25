# Candidate-delivery live report v1

Status: completed 16 rows: 4 independent authored cases, 2 repeats per arm (8 control, 8 candidate). Repeats are not additional independent tasks.

Frozen manifest: `ecb367cbb191aa076321624c149e9a910997db2902dde433300eaa8e94738cc3`; manifest content: `2b2af6306329c9d0406e4435c64f25243a5c79cb524b66f5be198b6e7e618837`; public Git HEAD before inference: `971343ed7b4026bc6ee6d3234daafc3152612f10`.

## Observed result

All 16 provider calls returned HTTP 200 with validated responses and model `jev-1.13.0`; 16/16 retained provider request identifiers privately. The control arm delivered 0/8 candidates, attempted 0/8 actions, and left 8/8 independent postconditions unknown. The bundled candidate arm delivered 8/8, completed 8/8 sandboxed actions, and passed 8/8 independent postconditions. No row abstained.

Token usage was 13,660 input and 820 output tokens. Operation time was 420.701 ms mean (range 325.113–507.372 ms); provider request time was 209.159 ms mean (range 160.633–328.12 ms).

The candidate used 6,918 input tokens versus 6,742 for control (+2.61%); both used 410 output tokens. Median full operation time was 468.253 ms versus 363.114 ms, while median request time was 192.715 ms versus 204.523 ms. The candidate executed an action and checked its postconditions; control did neither. These operation times therefore do not establish a like-for-like speed improvement. Four cases cannot establish broad task generalization.

## Per-row evidence

Each row records sanitized timing, model, HTTP/validation, usage, delivery/action/postcondition stages, and one-way hashes for request/response, private service/invocation receipts, reservation, result, event journal, completion, and the privately retained provider request identifier. Raw request IDs, credentials, fingerprints, and provider payloads are omitted.

| row | case | repeat | arm | operation ms | request ms | input | output | HTTP | delivery | action | postcondition | result hash | journal hash |
|---:|---|---:|---|---:|---:|---:|---:|---:|---|---|---|---|---|
| 1 | candidate-normal | 1 | control | 484.213 | 328.12 | 889 | 57 | 200 | not_delivered | not_attempted | unknown | `43f0ded9d708a31e…` | `0351b503a0e63f47…` |
| 2 | candidate-normal | 1 | candidate | 439.428 | 170.224 | 911 | 57 | 200 | delivered | completed | passed | `ac008a9d991b157e…` | `c457959bdb58d9eb…` |
| 3 | candidate-conflict | 1 | candidate | 464.918 | 211.961 | 861 | 50 | 200 | delivered | completed | passed | `93d4726485fabebf…` | `c0c327335828c445…` |
| 4 | candidate-conflict | 1 | control | 370.659 | 204.115 | 839 | 50 | 200 | not_delivered | not_attempted | unknown | `145a61b01a298f93…` | `041feae736e55498…` |
| 5 | candidate-stale | 1 | control | 325.113 | 160.633 | 808 | 49 | 200 | not_delivered | not_attempted | unknown | `c62d38040866fb13…` | `a23984e23efcb827…` |
| 6 | candidate-stale | 1 | candidate | 471.588 | 197.057 | 830 | 49 | 200 | delivered | completed | passed | `9f4beaa889e5d2af…` | `8f569e8b45177c13…` |
| 7 | candidate-adversarial | 1 | candidate | 457.987 | 188.366 | 857 | 49 | 200 | delivered | completed | passed | `ea9ed86e032465fa…` | `2516bec75312dfe2…` |
| 8 | candidate-adversarial | 1 | control | 341.071 | 193.707 | 835 | 49 | 200 | not_delivered | not_attempted | unknown | `823af45850dc9e9e…` | `488dead3058fdf64…` |
| 9 | candidate-normal | 2 | candidate | 479.368 | 188.372 | 911 | 57 | 200 | delivered | completed | passed | `4753f8a2312d3d9f…` | `dab11c901e3b856d…` |
| 10 | candidate-normal | 2 | control | 355.568 | 204.931 | 889 | 57 | 200 | not_delivered | not_attempted | unknown | `6355c69ba18402c2…` | `c1360a5e5aa30383…` |
| 11 | candidate-conflict | 2 | control | 422.915 | 271.202 | 839 | 50 | 200 | not_delivered | not_attempted | unknown | `59fafd7bed97f256…` | `299d06f13241690a…` |
| 12 | candidate-conflict | 2 | candidate | 394.055 | 168.851 | 861 | 50 | 200 | delivered | completed | passed | `c718a334e3187df6…` | `97fedd2e8a754f3e…` |
| 13 | candidate-stale | 2 | candidate | 498.501 | 219.732 | 830 | 49 | 200 | delivered | completed | passed | `14a183525247adef…` | `04ddbe6c689de1f9…` |
| 14 | candidate-stale | 2 | control | 343.467 | 194.244 | 808 | 49 | 200 | not_delivered | not_attempted | unknown | `78466a40ab44c6a6…` | `43625f5b4e89463a…` |
| 15 | candidate-adversarial | 2 | control | 374.999 | 217.448 | 835 | 49 | 200 | not_delivered | not_attempted | unknown | `b3d443649165e08f…` | `11683f2d743c5478…` |
| 16 | candidate-adversarial | 2 | candidate | 507.372 | 227.588 | 857 | 49 | 200 | delivered | completed | passed | `5b5caea81b09699a…` | `128f6705b3838111…` |

## Integrity and boundaries

Completion receipts match reservation/result/journal bytes and hashes for all 16 rows; row and manifest identities, result-persisted journal hashes, service-to-result receipt links, invocation-to-service links, and expected event kinds all validate. The initial tar `ENOSPC` occurred before any reservation/provider call and the output directory was verified empty; the run resumed from unchanged frozen source on a dedicated temporary volume. Local 25-test validation passed. Hosted jobs `108508343837` and `108508351940` were not started because of the GitHub account billing lock.

Billing remains unreconciled. This is a bundled repair versus released control hook-component result using a supplied authored catalogue through normalized `PreToolUse`/`runDecisionHook`; it provides zero Codex task-quality inference, no native catalogue/host discovery, and no per-component causal attribution.

## Rechecking retained evidence

The read-only [report verifier](verify-report.mjs) checks the frozen schedule,
every retained attempt artifact, raw service/invocation receipts and their parsed
projections, completion hashes, finite nonnegative measurements, and the published
row and aggregate results. It rejects orphan attempts and duplicate schedule rows.
It does not make provider calls or rerun any attempt. Raw provider evidence remains
private; public hashes permit checking a supplied evidence bundle, but are not
independent provider authentication or billing reconciliation.

```sh
node benchmarks/plugin-development/experiment/results-live-v1/verify-report.mjs --self-test
node benchmarks/plugin-development/experiment/results-live-v1/verify-report.mjs \
  --private-root "$PRIVATE_CANDIDATE_RECEIPTS" \
  --manifest benchmarks/plugin-development/experiment/frozen-live-v2.json \
  --report benchmarks/plugin-development/experiment/results-live-v1/report.json
```

The retained 16-row evidence bundle passed both commands after the run. The
negative checks include a changed completion hash, changed raw receipt projection,
duplicate or wrong scheduled identity, and invalid numeric measurements.
