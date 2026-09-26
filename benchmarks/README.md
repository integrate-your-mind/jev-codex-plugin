# Reusable coding-agent benchmarks

These benchmarks measure whether Jev changes an agent's independently verified results, time, or resource use. They also support comparisons between agents. A classifier response, confidence value, or agent's completion claim is not a passing task.

## Published observations

- [2026-09-26 fixed-model Codex pilot](results/2026-09-26-paired-v1/README.md): 16 trials, four authored tasks, eight matched pairs. Both conditions passed 8/8. Jev treatment was **18.7% slower at the median matched pair**. No quality gain was demonstrated. This measures turn time, not total end-to-end runtime or billed cost.
- [Theo's primary sources and methodology](theo-methodology.md): direct X chart inspection and extraction of his linked YouTube captions. His experiment concerns the Jev **model router**, a different treatment from this advisory plugin.
- [Validation evidence](VALIDATION.md): local checks, independent artifact regrading, and actual Docker/Pier verifier execution.
- [Plugin feature diagnostics](plugin-features/README.md): 16 deterministic checks against the current and experimental repaired source. The current source satisfies 11; the repair satisfies 16. These use simulated provider responses and establish integration behavior, not Jev accuracy or coding-task quality.
- [Research-to-test record](plugin-value/research.md): the completed GPT-6 Pro/Deep Research review, 31 research questions, reproduced payload defects, and primary documentation.

- [72-call decision evaluation](results/2026-09-26-plugin-decisions-v1/README.md): provider decisions matched the authored oracle in both arms; the repair delivered all 32 assessed choices and used 28.05% fewer input tokens. This does not establish improved task completion.

## Reuse

- [Agent-neutral task pack and study protocol](cross-agent/README.md): Harbor/Pier task format, independent verifier environments, deterministic 20-task DeepSWE selection, and a comparison contract for Codex, QQ, and other adapters.
- [Native Codex paired runner](../source/jev-workflows/benchmarks/paired-v1/README.md): tests the actual installed plugin and lifecycle hooks with a fixed model, including a two-turn changed-requirements task.
- [Plugin value protocol](plugin-value/protocol.md) and [40-trial schedule](plugin-value/schedule.json): fixed-model task-quality comparison under development. A schedule is not an executed result.
- [Native runtime checkpoint](plugin-value/runtime-review.md): reviewed adapter and bootstrap source with 29 Python and 6 Node tests passing; real remote command, patch and verifier controls remain pending, and scoring is disabled.
- [Development selection rule](plugin-value/development-selection.md) and [held-out reservation](plugin-value/heldout-selection.json): prospective feature-selection criteria and a disjoint 20-task sample. Execution is pending.
- [Restart recovery candidate](plugin-development/restart/README.md): independently reviewed source-only patch; 179 plugin regressions passed, no live provider or task-quality claim.
- [Rejected-response usage repair](plugin-development/usage/README.md): independently reviewed patch retaining valid reported tokens when an answer fails validation; 169 plugin tests passed. Invalid advice and billing remain separate from transport and token observations.
- [Typed batch component benchmark](plugin-development/batch/README.md): frozen serial-versus-batch comparison with separate raw-choice, policy and recommendation grading. Seventeen offline checks passed. The [completed authored cohort](results/2026-09-26-typed-batch-v1/README.md) used 32 provider requests with retained private IDs; component latency improved, while task benefit remains unmeasured.
- [DeepSWE image identities](plugin-value/image-identities.json): 20 registry manifests and config digests verified without pulling layers or claiming native execution.
- [Live decision evaluation](plugin-live-eval/README.md): authored decision episodes comparing original and repaired payloads; separate from independent coding-task verification.

The three portable authored tasks are **wiring smokes**, not a representative coding leaderboard. The DeepSWE lock is a frozen future evaluation input; it is not a completed DeepSWE result. The native Codex pilot has run. No live QQ comparison or new DeepSWE model score is reported here.

Benchmark additions do not change plugin quotas, policy thresholds, release version, or the user's model settings. Negative results remain part of the record.
