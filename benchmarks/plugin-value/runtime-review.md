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

The source and bootstrap checks passed independently on the pinned environment:
29 Python tests, 6 Node tests, syntax checks and identity consistency. These are
adapter checks, not task-completion results. The Linux bundle's Node, Codex,
bubblewrap and exec-server startup checks also passed in the pinned offline image.

Actual file-operation controls remain unproven. The initial sandbox probe used
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

Before scoring, the runtime still needs faithful remote command and patch controls,
baseline and treatment host controls, and no-op and oracle verifier controls.
`executionReady` remains false. Any final runtime choice must be documented and
frozen before the first scored attempt; a successful version probe alone cannot
satisfy that requirement.
