# Incomplete restart experiment preservation

This branch preserves the pre-existing unfinished source edit from `benchmark/restart-recovery`, based on `7dfe432d7463bab7186a8dacf50924af282f9a20`. It is an archival snapshot, not a usable plugin build, integration candidate, or release. The source file is retained without modification.

The experiment adds pending/completed event claims with process ownership and recovery attempts. It is not included in PR #9's installed payload-delivery repair. It also differs from the later independently reviewed source-only restart patch already published at `benchmark/paired-codex-pilot:benchmarks/plugin-development/restart/restart-source.patch`. Do not attribute that later patch's test results to this snapshot.

Known incomplete state observed during preservation:

- `finalizeEventClaim` contains an invalid escaped temporary-path expression.
- The invocation receipt call omits the experiment's required claim argument.
- Event finalization helpers are not wired into the hook completion path.
- No matching rebuilt bundles or restart tests are present in this local edit.

No new tests, provider requests, or repairs were run for this snapshot. It has not been installed. Retain it for provenance; continue any future restart work from the later reviewed patch, subject to separate integration and verification. Unlimited usage policy is not changed by preservation.
