# Native runtime checkpoint

This source checkpoint is independently reviewed but is **not ready for scored
trials**. The 40-row schedule, model, effort, task sample and current-plugin
treatment remain unchanged. No scored DeepSWE model calls have started.

The adapter uses an immutable shared Linux runtime instead of rebuilding Codex in
each task image. Images are addressed by digest. The task container has no network,
host credentials or Docker socket; the runtime is mounted read-only in the agent
and is absent from the separate verifier. Host control state and evidence are
outside task-visible mounts. The treatment verifies an exact 30-file plugin tree
before and after copying. Cancellation terminates the host process group and
cleans up its owned temporary paths.

The earlier source and bootstrap checkpoint passed independently on the pinned environment:
29 Python tests, 6 Node tests, syntax checks and identity consistency. These are
adapter checks, not task-completion results. The Linux bundle's Node, Codex,
bubblewrap and exec-server startup checks also passed in the pinned offline image.

Native baseline v3 subsequently completed two remote commands and one patch and
passed exact nonce-workspace verification in a separate offline container.
Earlier failed controls remain in the [attempt audit](native-controls-2026-09-26.json).
Baseline v1 lost complete runtime evidence during ENOSPC, so its model/provider
activity is unknown. Baseline v2 completed commands and a patch but failed an
incorrect event-source assertion and never reached its verifier.

Treatment v1/v2 failed MCP startup. The
[local registration amendment](runtime-amendment-local-mcp-2026-09-26.md) fixed
that startup problem while retaining only remote task execution. Treatment v3
loaded the MCP tools and completed a turn, but its only classification was a
preview and all 15 emitted hooks failed. The control correctly remains failed.
Eighteen focused host/driver tests passed independently on Node 22.23.2 before
that run; they did not establish native hook success.

The initial sandbox probe used
obsolete `codex sandbox linux --help` syntax: Codex 0.155 treated `linux --help` as
the child command and bubblewrap failed before that child ran. A separate explicit
legacy-Landlock experiment using the named `:workspace` profile was rejected
before its synthetic command. Its negative control was skipped, not counted as a
successful denial. Neither failure proves the kernel lacks namespace support.
The exact diagnostics and private receipt hashes are recorded in
`runtime-validation.json`. No privilege or Docker security relaxation was applied.

The boundary assumes a trusted host operator and Python environment, with an
untrusted task container. Pier and Harbor distribution RECORD entries are checked;
this does not attest the complete transitive Python filesystem. Independent
inspection found 42 Pier bytecode cache files absent from its RECORD and no Harbor
extras. The adapter executes verified source bytes and uses a fresh private
bytecode-cache prefix. Complete-host attestation is not a claim of these checks.

The original-task no-op control also failed before grading because the adapter
incorrectly required the agent image for the separate upstream verifier build.
No reward was produced; its reference-solution control did not start. Repairing
that build path and validating its pinned image/context are separate from the
successful synthetic baseline.

Before scoring, the runtime still needs both arms' passing native controls on
the final configuration, and no-op and reference-solution verifier controls.
`executionReady` remains false. Any final runtime choice must be documented and
frozen before the first scored attempt; a successful version probe alone cannot
satisfy that requirement.
