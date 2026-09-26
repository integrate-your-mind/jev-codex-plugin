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

The [development selection rule](plugin-value/development-selection.md) and [disjoint held-out reservation](plugin-value/heldout-selection.json) are saved before new feature comparisons. The [DeepSWE runtime checkpoint](plugin-value/runtime-validation.json) records failed environment setup and zero scored calls. Its native baseline/treatment and no-op/oracle controls remain unpassed; the earlier successful authored smoke controls do not satisfy those new gates. Completed decision measurements do not establish a task-quality effect, and no improved runtime configuration has been selected or installed.
