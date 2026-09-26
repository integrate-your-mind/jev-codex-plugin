# Local MCP registration amendment, 26 September 2026

Recorded before the corrected synthetic treatment control and before any scored
DeepSWE attempt. This supersedes only the `include_local=false` registry setting
in the [earlier runtime amendment](runtime-amendment-2026-09-26.md). That file and
all earlier control receipts remain immutable. The frozen task sample, treatment,
model, effort, time limits, and scoring rules are unchanged.

## Observed failure and repair

The diagnostic treatment control reported: "local stdio MCP server
`jev-workflows` requires a local environment". It failed before a model turn.
The host-side plugin needs a registered local environment to start its MCP
process. The harness had removed that registration along with local task access.

Set `include_local=true` in the environment manager registry and retain
`default="deep-swe"`. Both thread and turn requests must explicitly select only
`deep-swe`. Local registration serves the host plugin process; it is not added
to the model's selected command or patch environments. The task still runs in
the same offline Docker container without account credentials, host mounts,
Docker socket, added capabilities, or host PID namespace. The plugin receives
only the benchmark-owned host configuration and state described by the protocol.

## Source evidence and checks

The pinned Codex 0.155.0 implementation separates registration from selection:

- `codex-rs/exec-server/src/environment_toml.rs:68-100` adds the local environment
  to the manager registry without replacing an explicit default.
- `codex-rs/core/src/environment_selection.rs:983-1001` builds the turn snapshot
  from selected environments.
- `codex-rs/core/src/tools/handlers/mod.rs:159-173` resolves tool environment IDs
  from that snapshot and rejects IDs absent from it. Both unified command
  execution and patch handling use that resolver.
- `codex-rs/codex-mcp/src/runtime.rs:801-833` requires a registered local
  environment for local stdio MCP. Host plugins retain that local binding.

Tests must check registry/default settings and the sole explicit thread/turn
selection. The synthetic control must still demonstrate remote shell and patch
events, an actual Jev tool call and provider receipt, completed hooks, and a
separate offline verification of the nonce workspace. Registration alone does
not establish runtime success. Source inspection is evidence about dispatch;
it is not a claim of a complete adversarial isolation audit.

## Independent verifier issue

An original-task no-op control separately failed while constructing the verifier:
the adapter incorrectly required the agent image in the verifier configuration.
Upstream uses a separate `tests/Dockerfile` build context. No task reward was
produced and the reference-solution control did not start. Restoring that
upstream verifier path requires its own image provenance and controls before
scoring. It is not resolved by this MCP amendment.
