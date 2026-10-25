# Separate verifier build amendment, 26 September 2026

Recorded before the repaired no-op/reference-solution controls and before any
scored DeepSWE attempt. The frozen dataset, task selection, agent images, plugin,
model, effort and scoring rules are unchanged.

The first original-task no-op control failed when the adapter required an agent
image in the separate verifier configuration. The pinned upstream Pier contract
instead builds the task's `tests/Dockerfile` context and skips test upload because
the tests are included in that image. No reward was produced by the failed
control, and the reference-solution control did not start.

The adapter now preserves this upstream build. It authenticates the original
task checkout, checks that the verifier Dockerfile has one base matching that
task's image ledger, and copies the opaque tests context into the private trial
directory. It replaces only the copied `FROM` image reference with the recorded
digest. Original task files, tests and scoring code remain unchanged. A metadata
scan found the expected base declaration in all 20 selected Dockerfiles; it did
not expose test or reference-solution contents to the model.

The verifier image name includes the original context hash and base digest. A
per-trial receipt records the full context hash, copied Dockerfile hash, base
digest, actual built image ID and runtime mount count. The build specification
is pinned; the resulting image ID is observed at runtime, not claimed to be a
precomputed registry digest. The verifier has no Codex runtime or credentials and
runs without network access. This upstream-required verifier build is distinct
from the eliminated per-task Codex installation builds.

Cleanup removes the trial's containers and confirms that neither running nor
stopped containers remain before removing its copied build context. Receipts are
retained. Reusable task and verifier images are preserved for the paired runs;
later cleanup must identify exact task-owned images and any remaining consumers.

Before scoring, the repaired original-task no-op control must return reward 0
and the separate reference-solution control must return reward 1. These are
unscored setup controls without a model or Jev call. All prior failures stay in
the attempt record. A successful synthetic workspace control cannot substitute
for these original-verifier checks.
