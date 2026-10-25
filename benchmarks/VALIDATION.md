# Benchmark validation, 2026-09-26

This report distinguishes software validation from measured agent performance.

| Check | Observed result |
| --- | --- |
| Plugin typecheck, build, manifests | Passed; production distribution remains version 0.4.0 |
| Plugin tests | 163/163 passed |
| Generated distribution parity and drift tests | Passed; 3/3 tests |
| Portable export, task lock, comparison, normalization | 21/21 tests passed |
| Generic JSON Schema | Valid schema; actual normalized plan and all 16 trial records accepted |
| Authored task oracle controls | All initial broken fixtures rejected; all reference controls accepted |
| Copied model-generated pilot artifacts | 16/16 independently regraded successfully |
| Docker verifier controls | Three tasks each reject broken/missing artifacts and accept known-good artifacts |
| Grader separation | No `/tests` directory or `grade.mjs` in any of the three agent images |
| Pinned Pier runner | No-op trial completes collection and separate verification, expected reward 0, zero errors/model calls |
| Source integrity | Frozen runner/task/grader hashes match; 31 installed files verified, 30 semantic hashes published |

The [pilot result](results/2026-09-26-paired-v1/README.md) remains 8/8 versus 8/8 with higher treatment turn time, not a speedup. The [Docker receipt](cross-agent/smoke-runtime-validation.json) and [Pier receipt](cross-agent/pier-runtime-validation.json) document the execution boundary. Original run data and the retained Pier job results remain private, with public hashes and sanitized measurements.

The agent-neutral reducer is exercised against the real pilot, not just synthetic reducer inputs. Regression cases cover counterbalanced trial order, duplicate/missing/unexpected rows, model/configuration drift, invalid token accounting, unknown costs, missing measurements, and preserving existing output files.

Jev's own advisory completion check **abstained** at confidence 0.46 for low confidence. It is not used as a grader or as proof that these benchmarks are valid. Independent artifact tests, runtime evidence and source reconciliation support the claims above.

No DeepSWE model evaluation, live QQ comparison, reconciled dollar-cost comparison, or general quality improvement is established by these checks. Hosted CI is a separate result from this local report.

## Linux verification and hosted CI

The public revision was also checked in a credential-free Docker Linux arm64 container using digest-pinned Node 22.22.0. Typecheck, build, all 163 plugin tests, manifests and distribution parity passed. The first run exposed an existing fixture-filter bug: an absolute `/work/` ancestor caused the distribution test to omit its source tree. The filter now considers only paths relative to the fixture source; an added regression covers that case. The corrected Linux rerun passed all 3 distribution tests and all 21 cross-agent tests. [Sanitized execution receipt](cross-agent/linux-node22-validation.json) retains code/log hashes and the initial failure boundary.

GitHub did not start [hosted CI](https://github.com/integrate-your-mind/jev-codex-plugin/actions/runs/36253715386): its annotation reports that the account is locked due to a billing issue. Local Linux success is not hosted CI success.

## Decision study and prospective value study checkpoint

The completed [72-call decision study](results/2026-09-26-plugin-decisions-v1/README.md) is separate from the native pilot above. An offline exporter reconciled all 72 starts and terminal records, validated HTTP responses, persisted receipts, and request-ID presence against retained private evidence. The public artifacts omit the actual provider IDs and raw payloads. Original measured JSON files remain unchanged.

Under Node v22.23.2 on macOS arm64, 26 focused benchmark tests passed, including the payload diagnostic, frozen live harness dry run, exporter, paired statistics, held-out selection, and static host configuration. The 21 cross-agent regressions also passed again. These checks made no provider calls. The exact source-only repair patch was applied to a fresh checkout of the recorded baseline; its hook source SHA-256 matched the completed study. Typecheck, build, manifest validation, and all 173 reconstructed-source tests passed.

Reconstruction exposed two setup mistakes before the passing run: testing before rebuilding used the old bundled hook; building with dependencies symlinked to an external checkout embedded that checkout path in bundle comments, which the packaging privacy test rejected. Rebuilding with dependencies inside the temporary checkout resolved both without changing the frozen source. No generated bundle from those failed checks is published here.

The [development selection rule](plugin-value/development-selection.md) and [disjoint held-out reservation](plugin-value/heldout-selection.json) are saved before new feature comparisons. The [DeepSWE runtime checkpoint](plugin-value/runtime-validation.json) records zero scored calls. Native baseline v3 passed remote commands, patching and independent nonce verification. Treatment loaded its MCP tools after a startup repair, but the latest control failed because its classification was preview-only and its hooks failed. The original-task no-op verifier control failed during verifier construction; its reference-solution control has not started. The [attempt audit](plugin-value/native-controls-2026-09-26.json) preserves these outcomes and unknown activity after an earlier ENOSPC failure. Completed decision measurements and synthetic controls do not establish a task-quality effect; no improved runtime configuration has been selected or installed.

The prospective typed-batch component harness passed 10 offline regressions, including local unavailability without a fetch, partial transport, service exceptions, identity/order tampering, and null unknown usage. All 20 selected DeepSWE image manifests and config hashes were checked against public registry bytes; config metadata is Linux amd64. This is metadata verification, not task-runtime execution.

For checkpoint 46dd949bc9292c22ceb0c5593d3f87f4670bd14a, [hosted CI](https://github.com/integrate-your-mind/jev-codex-plugin/actions/runs/36264657304) again did not start; GitHub explicitly reported an account billing lock. No hosted test steps ran.

A later evidence-retention audit found that the frozen 72-call transcript stores provider-ID presence rather than actual provider IDs, and the runner removed temporary native receipt files after checking them. Receipt parity and HTTP/validation observations remain recorded, but individual provider billing cannot be reconciled from this artifact alone. This limitation does not turn attempt reservations into successful calls; billing remains unknown. The completed study was not rerun or rewritten.

## Receipt and restart recovery checkpoint

The typed-batch runner now retains actual provider IDs in a private fsynced journal and verifies corresponding response, receipt and service-result representations. Credential fingerprints are stripped. Seventeen offline regressions passed. The [completed 32-request cohort](results/2026-09-26-typed-batch-v1/README.md) was independently regraded: 32 HTTP 200 responses, 31 validated responses, and 32 persisted receipts with actual IDs. One rejected serial Score answer remains in the denominator; costs remain unknown.

The independent [restart recovery candidate](plugin-development/restart/README.md) was rebuilt and passed all 179 plugin tests, typecheck and manifests. It preserves immutable claim generations, rejects stale replay, and separates persisted advice from unknown delivery. It is a source-only experimental patch, not an installed update or selected treatment.

At public checkpoint 682990cdafe562699ac539bef204e4def6e7e39a, [GitHub CI](https://github.com/integrate-your-mind/jev-codex-plugin/actions/runs/36267097415) again did not start because of the account billing lock. No hosted test steps ran.

## Live candidate delivery and explicit outcome evidence

The [frozen 16-row component study](plugin-development/experiment/results-live-v1/REPORT.md) completed at pre-inference revision 971343ed7b4026bc6ee6d3234daafc3152612f10. All 16 HTTP responses were validated and actual provider IDs remain privately retained. Four independent cases, repeated twice per arm, yielded 0/8 delivered actions for released control and 8/8 delivered, executed and independently checked actions for the bundled repair. Control outcomes remain unknown, not proven task failures. The candidate used 2.61% more input tokens; complete operation time includes work the control did not perform. No Codex task-quality or per-component causal gain is claimed. The runner passed 25 offline regressions; a pre-reservation temporary-filesystem failure is retained.

The [explicit outcome contract](plugin-development/explicit-outcomes/results-v1.json) passed 10 independent-root regressions under network denial and TypeScript checking. Four caller-supported claims remain caller reports; the harness finds one supported, one unknown, one unsupported for the current revision, and one contradicted. All four oracle checks passing means the expected assessment was produced, not four successful effects. Six actual API storage calls read back exactly and two invalid receipt calls were rejected. No provider or model call occurred.

The historical native v4 baseline and treatment controls both passed. Original DeepSWE no-op/reference controls remain infrastructure-invalid; zero scored task attempts have started. The source/evidence repair work is not a task result. At public component checkpoint 6e25dd6745ca0e7a3615629cddfebabf3632938a, both GitHub checks again failed before execution because of the account billing lock.
