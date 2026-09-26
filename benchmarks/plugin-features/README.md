# Plugin feature benchmark

This is a deterministic, authored benchmark of a selected Jev Workflows source tree. It covers data input normalization, task context propagation, candidate catalogs, evidence retention, redaction, deduplication, bounded context, and advisory output formatting across disjoint scenarios.

`scenarios.json` contains serialized Jev inputs and mocked assessment responses; its `checks` fields are runner metadata and are never copied into an event payload. `truth-labels.json` is versioned separately as an independent feature oracle. `external-reproductions.json` records payload-only audit fixtures and is not evidence that those fixtures were exercised. `results.json` records fixture hashes, source content hashes, captured payload/output hashes, execution status, observed behavior, and independent requirement status.

Run from the source package (dependencies are already present):

```sh
cd source/jev-workflows
node --import tsx ../../benchmarks/plugin-features/run.mjs \
  --source-root "$PWD" > ../../benchmarks/plugin-features/results.json

# Compare a baseline source tree from the same dependency environment.
node --import tsx ../../benchmarks/plugin-features/run.mjs \
  --source-root /absolute/path/to/source/jev-workflows
```

Most scenarios use a deterministic in-process service injection and are labeled as fixture replay. The large saved-context scenario uses a response-validating synthetic `fetch` implementation and never contacts the provider; it records whether the actual hook reaches that boundary with a valid bounded payload. `providerCalls: false` always means no real provider call; `serviceInvocations` counts injected service calls and `mockProviderCalls` counts only synthetic transport calls. The hook context check uses the 5,000-byte hook limit separately from the 12,000-byte provider-schema context limit. Requirement outcomes are computed from observable checks, with `satisfied`, `failed`, and `unknown` kept separate from harness execution. Results establish source behavior and plumbing boundaries only; they do not measure provider quality, task-completion uplift, DeepSWE heldout performance, or production acceptance.

The focused regression test compares the baseline and an optional repaired source root. Set the repaired root explicitly; without it, the comparison is skipped:

```sh
JEV_REPAIRED_SOURCE_ROOT=/absolute/path/to/repaired/source/jev-workflows \
  node --test benchmarks/plugin-features/run.test.mjs
```

The objective-replacement check verifies the observable context record after an explicit `replace` operation: the new objective is present and obsolete serialized history is absent. It does not claim that a model followed the objective.
