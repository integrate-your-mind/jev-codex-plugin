# Codex graph adapter

The adapter targets the installed Codex CLI 0.155.0. Non-generative `codex --version` and `codex exec --help` confirmed the native flags. The [versioned exec event contract](https://github.com/openai/codex/blob/rust-v0.155.0/codex-rs/exec/src/exec_events.rs) and [configuration schema](https://github.com/openai/codex/blob/rust-v0.155.0/codex-rs/core/config.schema.json) define the fixture shapes and hook switches.

`runTrial` requires `authorizeProvider: true` before it starts the coding process. Otherwise it writes a `not_started` receipt. An authorized run creates a private `CODEX_HOME` and a temporary symlink to the existing protected `auth.json`. It does not alter the source credentials. The symlink is removed after termination. Private native session files, stdout, stderr, and receipts remain under the trial output directory.

The launch requests `gpt-6-astra` with `high` effort in every arm. It disables lifecycle hooks, plugin hooks, and plugins with native feature settings. The child inherits a small environment allowlist. The graph server receives its root, state, objective, arm, and Jev state directory through its MCP environment. Only the Jev arm can receive an explicitly supplied `jevApiKeyFile` reference. The coding process receives neither that reference nor Jev secret values.

The evidence model has three parts. Native `thread.started` identifies the session. A matching private `turn_context` supplies model and effort. Native item events supply one record per tool or command attempt, retaining MCP arguments, results, status, and errors. Requested settings and invented fields on `turn.started` never establish model resolution. Missing or ambiguous native session evidence makes a run ineligible.

`repeatedActions` counts repeated identical command strings and MCP server, tool, and canonical argument tuples across distinct native item IDs. Updates to the same item do not count as repetition. It does not infer semantic equivalence. Human approval and interruption totals remain `null` because the exec stream omits those request events and a private rollout is not a complete request log. Observed private event counts are reported separately as lower bounds.

The process lifecycle waits for the host exit, then terminates any surviving members of its detached process group. Timeout and external abort have distinct receipt fields. TERM and KILL waits are bounded. `cleanupRequired` remains true when group termination cannot be confirmed. A terminal JSON event alone cannot establish completion.

Implementation acceptance uses native-shaped fixtures plus local Node subprocesses for normal, timeout, and abort cleanup. No coding-model call, MCP discovery, completed repair, provider bill, or efficacy result is claimed by those checks. The root runner owns catalog validation, the study freeze, real tool uptake, independent behavior grading, and matched outcomes.

The smallest useful unit is this Codex adapter and its tests. Native schema discovery blocks implementation. QQ work remains independent. Each trial owns its config and process group. The parent integrates and independently reviews the final commit.
