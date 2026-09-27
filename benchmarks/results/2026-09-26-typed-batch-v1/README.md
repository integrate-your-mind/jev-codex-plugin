# Typed batch component study, 26 September 2026

The frozen comparison completed once: four authored cases, two repeats and two arms. Three independent typed questions (Choice, Noul, Score) used the same state and policy, either in three serial requests or one batch request. These are four case clusters, not eight independent tasks.

| Measurement | Serial | Batch |
| --- | ---: | ---: |
| Completed operations / planned | 8 / 8 | 8 / 8 |
| Provider requests / planned | 24 / 24 | 8 / 8 |
| HTTP 200 responses | 24 | 8 |
| Validated responses | 23 | 8 |
| All authored classifier criteria matched | 7 / 8 | 8 / 8 |
| Raw Choice oracle agreement | 8 / 8 | 8 / 8 |
| Returned recommendation matched | 8 / 8 | 8 / 8 |
| Unknown operations | 1 | 0 |
| Prohibited actionable recommendations | 0 | 0 |
| Median complete component operation | 810.108 ms | 256.942 ms |
| Median provider request | 239.729 ms | 234.941 ms |
| Total input / output tokens | Unknown | 5,608 / 790 |
| Reconciled provider cost | Unknown | Unknown |

All eight paired batch operations were faster; the median paired batch/serial elapsed-time ratio was 0.3123. This is descriptive evidence that batching these independent questions reduced component work. It does not measure native Codex turnaround or a coding-task quality benefit.

## Evidence and failure accounting

The [freeze](../../plugin-development/batch/freeze.json), [review](../../plugin-development/batch/review.json), runner and exporter were published in commit 682990cdafe562699ac539bef204e4def6e7e39a before the first live request. The exact [sanitized result](results.json) was independently regraded and checked against all 32 private request groups; see [audit](review.json). There were no reruns, hidden retries, omitted groups or duplicate groups.

All 32 HTTP responses and all 32 persisted private receipts have actual matching provider request IDs. The mode-0600 journal is retained outside the public repository; the public result includes its SHA-256, counts and source identities, not actual IDs, credentials, fingerprints or raw payloads. Request attempts, HTTP success, answer validation and persistence are distinct counts. Neither HTTP success nor a receipt establishes a billed amount.

One serial Score answer was rejected. It returned score 0.01 with published probabilities {0: 1.0, 1: 0.0, 2: 0.0}, whose weighted value is 0.0. The plugin's existing consistency tolerance is 0.001. [TypeSafe's Score documentation](https://docs.typesafe.ai/primitives/score.md) and [OpenAPI](https://api.typesafe.ai/openapi.json) describe the score as the weighted expected rubric level, but do not specify a numerical reporting tolerance. The discrepancy remains unexplained; no answer was silently repaired, tolerance changed, or attempt rerun. It is one unknown score, not a wrong raw Choice decision.

The raw rejected response separately reports 449 input and 19 output tokens, but the frozen service result discards usage with an invalid answer. Accordingly, the measured serial total remains unknown; no token-saving or dollar-saving percentage is claimed. The retained raw evidence permits a separately labeled future accounting audit without rewriting this cohort.

## Scope and limitations

- The runtime was Node 22.23.2 on macOS arm64, current plugin service 0.4.0 and Jev 1.13.0. Source and harness identities are in results.json.
- The private JSONL persistence adapter syncs receipt records. Its latency is not native FileStore latency. The component timing excludes process startup and any downstream coding work.
- Noul and Score ranges are authored criteria, not calibrated probabilities. The tiny cohort and repeated cases do not establish general accuracy or inferential certainty.
- The harness executes no recommended action. Actual harmful actions and independently verified task/action benefits are unmeasured, not zero.
- This result passes a component measurement check. It does not satisfy the frozen selection rule's native host/action/verifier requirements, select an improved configuration, or change installed defaults.

The original Codex pilot, completed 72-call decision cohort, DeepSWE schedule and held-out reservation remain unchanged.
