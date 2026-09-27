# Host hook directory mapping amendment, 26 September 2026

Recorded after a model-free directory-mapping probe and before any native model
control using that mapping or scored DeepSWE attempt. Both arms receive the same
mapping. Task selection, agent images, plugin revision, model, effort, deadlines
and outcome rules remain unchanged. Earlier controls retain their original
identities and results.

## Observed incompatibility

Codex 0.155.0 launches plugin command hooks on the app host using the turn's
working directory. In this harness the selected remote directory was `/app`,
which exists in the task container but not on the Mac. A model-free host spawn
reproduced the missing-directory failure. The pinned plugin's SessionStart hook
ran successfully from a valid private host directory without a provider call.
This explains a launch incompatibility; it does not establish that automatic
native hooks work yet.

## Per-run mapping

Create a fresh, private host workspace directory for the control process. Inside
the task container only, create the same absolute path as a symlink to `/app`.
The task source stays at `/app`; it is neither moved nor mounted onto the host.
The host directory contains no task source or account credentials. No global
host `/app` directory or host-wide setting is created.

Use that per-run path as the sole selected `deep-swe` working directory and as
the working directory for starting the container exec-server. The host hook
launcher then has an existing directory, while remote commands and patches
operate on the task repository. Validate the selected logical path separately
from its canonical container target, `file:///app`; reject an unexpected target
or redirected parent path. Registration of the local environment remains only
for host MCP, and it remains absent from model command/patch selections.

The task container still has no network, account credentials, host workspace
mount, Docker socket, added capabilities or host PID namespace. The independent
verifier keeps its original `/app` layout and receives neither the alias nor the
Codex runtime. Cleanup removes the task container and the exact owned host
directory, preserving receipts.

## Evidence and remaining controls

The offline probe verified exec-server canonicalization to `/app`, a file write
and command through the alias, retention of the exact alias by app-server
thread/environment selection, successful host spawning from the alias, and
cleanup. It made zero model and provider calls. Its private receipt SHA-256 is
`e440a84339288da53c8134c58cb86a6bc42c5ea011fe94bcd8b5b0426d124a7f`;
the exec-server result SHA-256 is
`d5cd475aa36fdfd36aac673f00a49d4ef3a0187062b9b097a46ab43a512a9daf`.

Before scoring, fresh native controls must pass for both arms. Treatment must
demonstrate completed native pre/post hooks, an explicit evaluated Jev decision
with persisted provider evidence, and independently verified task artifacts.
Preview-only calls and enabled hook declarations remain insufficient. The
original task's separate no-op/reference-solution controls must also pass.
