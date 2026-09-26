# Reusable coding-agent benchmarks

These benchmarks measure whether Jev changes an agent's independently verified results, time, or resource use. They also support comparisons between agents. A classifier response, confidence value, or agent's completion claim is not a passing task.

## Published observations

- [2026-09-26 fixed-model Codex pilot](results/2026-09-26-paired-v1/README.md): 16 trials, four authored tasks, eight matched pairs. Both conditions passed 8/8. Jev treatment was **18.7% slower at the median matched pair**. No quality gain was demonstrated. This measures turn time, not total end-to-end runtime or billed cost.
- [Theo's primary sources and methodology](theo-methodology.md): direct X chart inspection and extraction of his linked YouTube captions. His experiment concerns the Jev **model router**, a different treatment from this advisory plugin.
- [Validation evidence](VALIDATION.md): local checks, independent artifact regrading, and actual Docker/Pier verifier execution.

## Reuse

- [Agent-neutral task pack and study protocol](cross-agent/README.md): Harbor/Pier task format, independent verifier environments, deterministic 20-task DeepSWE selection, and a comparison contract for Codex, QQ, and other adapters.
- [Native Codex paired runner](../source/jev-workflows/benchmarks/paired-v1/README.md): tests the actual installed plugin and lifecycle hooks with a fixed model, including a two-turn changed-requirements task.

The three portable authored tasks are **wiring smokes**, not a representative coding leaderboard. The DeepSWE lock is a frozen future evaluation input; it is not a completed DeepSWE result. The native Codex pilot has run. No live QQ comparison or new DeepSWE model score is reported here.

Benchmark additions do not change plugin quotas, policy thresholds, release version, or the user's model settings. Negative results remain part of the record.
