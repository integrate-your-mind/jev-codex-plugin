# Paired Codex pilot v1: public result

This directory contains a sanitized, reproducible evidence package for a **descriptive synthetic pilot** comparing fixed Codex alone with the installed Jev advisory plugin. It is a local frozen plan and result package, not an external preregistration. It does not establish a product speedup or a general productivity claim.

## Result

All 16 scheduled trials completed without infrastructure failure. Both arms passed all eight artifact-graded trials (8/8 versus 8/8), so this study observed no quality gain. Treatment had a higher paired median turn duration by **8,874.48 ms (+18.7%; ratio 1.187)**. This is a negative result for an observed quality improvement under this pilot.

The fixed profile was model `gpt-6-astra`, effort `medium`. The four authored task clusters were repeated twice per arm; repeated runs are not independent task samples.

| Task | Repeat | Codex alone | Codex + Jev | Alone turn ms | Jev turn ms | Delta ms |
| --- | ---: | --- | --- | ---: | ---: | ---: |
| retry-repair | 1 | pass | pass | 57029.41 | 60496.27 | 3466.85 |
| interval-repair | 2 | pass | pass | 47201.13 | 51256.69 | 4055.56 |
| csv-parser | 2 | pass | pass | 41083.95 | 52867.26 | 11783.31 |
| retry-repair | 2 | pass | pass | 46581.82 | 57329.63 | 10747.81 |
| changed-route | 2 | pass | pass | 56759.85 | 70000.91 | 13241.06 |
| csv-parser | 1 | pass | pass | 41947.07 | 51970.63 | 10023.56 |
| changed-route | 1 | pass | pass | 62267.43 | 69992.83 | 7725.40 |
| interval-repair | 1 | pass | pass | 44736.71 | 51145.38 | 6408.66 |

Turn timing is the sum of per-turn elapsed time. It excludes startup, oracle execution, and cleanup.

## Usage and receipt evidence

| Arm | Input tokens | Cached input (included in input) | Output tokens | Total observed tokens |
| --- | ---: | ---: | ---: | ---: |
| Codex alone | 715434 | 572160 | 9750 | 725184 |
| Codex + Jev | 857264 | 715392 | 11021 | 868285 |

The sanitized receipt evidence derives 100 local receipt IDs, all 100 files were found, and four responses had `validatedResponse=false`. The receipt metrics are a lower bound: seven direct MCP calls have no per-call result-receipt association, so no timestamp or global-counter inference is used. Provider request IDs are represented only by presence counts.

## Integrity and provenance

The copied solutions are independently regraded against the exact source grader. All 16 copied solutions pass; `regrade-results.json` records each trial and check count. `solutions-manifest.json` records SHA-256 hashes for every copied solution.

The package records hashes for the runner (`30137d3e8c5cb8fd6a5246510cd8a01e16de21251724a033fc59169b2833a503`), task document (`e517029eb95b7c9915544b42edc9d8e853810d54047a2bf11a8815a642b4ba43`), and grader (`a91d0dfa79bd27f858f18e8e9dd8e4b6155287ee0a963aec457d0839dd7c8b94`). The captured private provenance manifest verified 31 installed files against the current installed cache for version `0.4.0+codex.20260926072321`; the public [`runtime-provenance.json`](runtime-provenance.json) publishes the 30 semantic relative-path hashes and intentionally excludes `.DS_Store`. It also publishes hashes, without paths or contents, for the privately retained `plan.json`, `trials.jsonl`, and `report.json`.

## Exclusions and limits

Two earlier attempts are excluded from the 16-trial result: the initial attempt was invalidated after a creative-production runtime-plugin alias leaked into the baseline, and the subsequent isolated attempt aborted on runtime-isolation drift. Their outputs are retained privately and are not folded into this denominator.

The scored run was sequential, so model/server cache warming may affect later trials. Both arms used the same workspace-write/network capability because the treatment needed provider access. The study uses four small synthetic task clusters, one fixed model/effort, and no billing reconciliation. It cannot support a causal, general productivity, routing, or product-speed claim.

## Reproduce the artifact regrade

From the repository root, rerun an individual copied solution against the exact source grader:

```sh
( cd benchmarks/results/2026-09-26-paired-v1/solutions/<trial-id> && node ../../../../../source/jev-workflows/benchmarks/paired-v1/grade.mjs <task-id> )
```

The public package records the resulting 16-trial regrade in [`regrade-results.json`](regrade-results.json).

## Files

- [`summary.json`](summary.json): sanitized per-arm and paired result data.
- [`receipt-metrics.json`](receipt-metrics.json): sanitized receipt-derived metrics and the MCP coverage limitation.
- [`plan.json`](plan.json): sanitized local frozen execution plan and source hashes.
- [`runtime-provenance.json`](runtime-provenance.json): sanitized release/runtime metadata, 30 semantic installed-file hashes, and hashes of the retained private evidence files.
- `solutions/`: one `solution.mjs` per trial ID.
- [`solutions-manifest.json`](solutions-manifest.json): SHA-256 manifest for copied solutions and public package files.
- [`regrade-results.json`](regrade-results.json): independent exact-grader results.

No raw sessions, transcript text, private paths, credential fingerprints, provider request IDs, or secrets are included.
