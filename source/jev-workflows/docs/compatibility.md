# Packaging and compatibility

`jev-workflows` has a portable Agent Plugins package at its root and a Codex compatibility overlay for hosts that still use the scaffold layout. The root files are canonical for new clients:

```text
plugin.json                         portable manifest
mcp.json                            portable MCP configuration
skills/                             fixed portable skill directory
.codex-plugin/plugin.json           legacy Codex metadata overlay
.mcp.json                           legacy Codex MCP companion
hooks/hooks.json                    conventional bundled hook discovery (owned by the hook implementation)
```

The portable manifest targets Agent Plugins 1.0.0 and declares the published schema at `https://agent-plugins.org/schemas/1.0.0/plugin.schema.json`. The portable MCP configuration targets the matching `https://agent-plugins.org/schemas/1.0.0/mcp.schema.json`. The exact downloaded schemas used for local validation are retained in `schemas/` with their source URLs and hashes in `schemas/README.md`.

## Canonical MCP runtime

The root `mcp.json` contains one local stdio server, `jev-workflows`. Its executable is the bare `node` token and its bundled entry is passed as an argument:

```json
{
  "type": "stdio",
  "command": "node",
  "args": ["${PLUGIN_ROOT}/dist/server.mjs"],
  "cwd": "${PLUGIN_ROOT}"
}
```

Agent Plugins defines `${PLUGIN_ROOT}` and `${PLUGIN_DATA}` expansion for every string in `args`, values in `env`, and `cwd`. It does not expand placeholders in `command`, so the command remains `node`. The runtime supplies `PLUGIN_ROOT` and `PLUGIN_DATA`; manifests must not override those reserved names. The portable root has no configured MCP environment. The Codex overlay forwards an explicit allowlist of environment names; neither file embeds credentials or secret-bearing headers.

The source `.mcp.json` is the portable declaration. The generated legacy host package rewrites only its copied Jev server entry: `args` uses the relative `dist/server.mjs` path and `cwd` is `.`. This is required because the legacy Codex parser resolves a relative `cwd` beneath the plugin root but passes stdio `args` through unchanged; `${PLUGIN_ROOT}` is an Agent Plugin placeholder and is not expanded by that parser. The generated file also adds the Codex-only `env_vars` allowlist. `scripts/validate-manifests.mjs` compares portable server fields and separately validates the exact Codex environment allowlist.

The path behavior is implemented in Codex’s [plugin MCP parser](https://github.com/openai/codex/blob/main/codex-rs/codex-mcp/src/plugin_config.rs): host parsing joins a non-absolute `cwd` to the plugin root and does not perform placeholder expansion on `args`. The parser tests demonstrate the supported relative `cwd` form in [plugin_config_tests.rs](https://github.com/openai/codex/blob/main/codex-rs/codex-mcp/src/plugin_config_tests.rs). Agent Plugin placeholder expansion remains canonical in the separate Agent Plugin parser.

## Manifest overlay behavior

Portable clients discover `skills/` and root `mcp.json` at their fixed locations. OpenAI-specific presentation metadata lives under `extensions.com.openai` in the root manifest. The compatibility manifest repeats the same identity and interface metadata for legacy loading; it points to `./skills/` and `./.mcp.json` using the local scaffold contract.

The root manifest intentionally omits an explicit `hooks` override. Codex documents `hooks/hooks.json` as the default bundled hook location when neither the selected extension nor the compatibility manifest defines `hooks`; this avoids the direct `hooks` field rejected by the local plugin validator. Bundled hooks still require the host’s review and trust step; installation or enablement alone is not evidence that a hook ran.

### v0.2 Codex host behavior

The portable root package is the canonical artifact for Agent Plugins clients. In the initial Codex CLI `0.153.4` audit, the plugin loader recognized `plugin.json` as an Agent Plugin manifest and supplied no plugin hook sources for that format. The corresponding branch in the [official loader](https://github.com/openai/codex/blob/main/codex-rs/core-plugins/src/loader.rs) returns empty hook sources for `AgentPlugin` manifests before trust evaluation. In that host, `hooks/list` therefore reports no Jev hook even when `hooks/hooks.json` is present; adding a trust entry cannot activate a hook that was never loaded.

For this host limitation, the release includes a generated legacy compatibility variant. Run the packager from the source root with a new target whose final directory name is `jev-workflows`:

```bash
node scripts/package-host.mjs /absolute/path/to/jev-workflows
```

The generated target omits the portable root `plugin.json` and `mcp.json` so the legacy loader selects `.codex-plugin/plugin.json`. It retains `.mcp.json` (including the names-only `env_vars` overlay), `hooks/hooks.json`, `skills/`, and bundled `dist/` files. The copied legacy `.mcp.json` uses `args: ["dist/server.mjs"]` and `cwd: "."`; the portable source keeps `${PLUGIN_ROOT}`. It also writes `HOST-COMPATIBILITY.json` and a generated README note. The script refuses targets inside the source tree, nonempty unmarked targets, and excluded paths such as `node_modules/`, `work/`, `receipts/`, source, and tests. This variant is a host compatibility package; it does not replace the portable artifact.

When the legacy MCP process and legacy hooks must share an existing accounting directory, pass an explicit host-local absolute path:

```bash
node scripts/package-host.mjs \
  --state-directory /absolute/path/to/shared/jev-data \
  /absolute/path/to/jev-workflows
```

The packager validates that the path is absolute and contains no NUL character. In the generated host package it sets only `env.JEV_STATE_DIRECTORY` for the MCP server and prefixes each bundled hook command with a POSIX shell-quoted `JEV_STATE_DIRECTORY=...` assignment. It never overrides reserved `PLUGIN_DATA`; the default package without this flag sets `JEV_STATE_MODE=user` for both surfaces, so both use the same XDG/home state directory. The selected path is recorded as a nonsecret host setting in `HOST-COMPATIBILITY.json`.

This override exists because Codex’s legacy MCP parser does not inject the plugin data directory into stdio MCP processes, while hook discovery does provide its own `PLUGIN_DATA`. Supplying the same explicit path to both generated command surfaces lets the runtime share existing receipts and budget accounting. The caller must choose the correct host-owned path; packaging does not create, copy, or migrate accounting data.

### Hook review, trust, and coverage

#### Native event contract

The twelve entries in `hooks/hooks.json` are the declared contract. Codex supplies common JSON fields such as session_id, cwd, hook_event_name, and the active model; transcript_path may be null. This adapter requires session_id and cwd for every event, requires tool_name and tool_use_id for PreToolUse and PostToolUse, requires turn_id and tool_name for PermissionRequest, requires turn_id and trigger for PreCompact and PostCompact, requires turn_id, agent_id, and agent_type for SubagentStart and SubagentStop, requires turn_id for Stop and Interrupt, and requires reason for SessionEnd. It accepts a missing turn_id on UserPromptSubmit because some hosts omit it. The remaining event fields are bounded inputs, not a transcript interface.

| Event | Codex event fields used by the adapter | Valid advisory output |
| --- | --- | --- |
| SessionStart | source (startup, resume, clear, or compact) is supplied by Codex; the adapter requires session_id and cwd. | hookSpecificOutput with hookEventName SessionStart and additionalContext. |
| SessionEnd | reason is supplied by Codex (currently `other`); the adapter requires session_id, cwd, and reason. | JSON systemMessage; synchronous and advisory, with no steering or keep-open behavior. |
| UserPromptSubmit | prompt is supplied by Codex; turn_id may be supplied by Codex but can be absent; the adapter requires session_id and cwd, and caches only a bounded prompt. | hookSpecificOutput with hookEventName UserPromptSubmit and additionalContext. |
| PreToolUse | turn_id, tool_name, tool_use_id, and tool_input; the adapter requires tool_name and tool_use_id. | hookSpecificOutput with hookEventName PreToolUse and additionalContext; no permission decision or updatedInput is returned. |
| PermissionRequest | turn_id, tool_name, tool_input, and permission_mode; the adapter requires turn_id and tool_name. | JSON systemMessage only; it never returns an allow/deny permission decision. |
| PostToolUse | turn_id, tool_name, tool_use_id, tool_input, and tool_response; the adapter requires tool_name and tool_use_id. | hookSpecificOutput with hookEventName PostToolUse and additionalContext; it cannot undo the completed tool call. |
| PreCompact | turn_id and trigger (`manual` or `auto`); the adapter requires both. | JSON systemMessage; advisory only, with no compaction control field. |
| PostCompact | turn_id and trigger (`manual` or `auto`); the adapter requires both. | JSON systemMessage; advisory only, with no compaction control field. |
| SubagentStart | turn_id, agent_id, agent_type, and permission_mode; the adapter requires turn_id, agent_id, and agent_type. | hookSpecificOutput with hookEventName SubagentStart and additionalContext. |
| SubagentStop | turn_id, agent_id, agent_type, stop_hook_active, and last_assistant_message; the adapter requires turn_id, agent_id, and agent_type and ignores active-stop recursion. Its result cache is explicitly `unsupported_agent_scope`. | JSON systemMessage; it does not return a continuation decision. |
| Stop | turn_id, stop_hook_active, and last_assistant_message; the adapter requires turn_id and ignores active-stop recursion. It may include bounded current-turn tool-result summaries. | JSON systemMessage; it does not return a continuation decision. |
| Interrupt | turn_id and permission_mode; the adapter requires turn_id. | JSON systemMessage; it cannot prevent the interruption or restart the turn. |

For SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, and SubagentStart, additionalContext is the model-visible advisory channel. The other seven events use JSON systemMessage. Every assessment output is normalized to validated status, decision, confidence, reason, and receipt values; fields unavailable for that assessment are omitted. SessionStart supplies fixed local guidance without claiming a provider assessment. The adapter intentionally does not use Codex's permission, block, rewrite, or continuation output fields, so a Jev answer never grants approval, changes a tool call, controls compaction, or forces another turn. Command hooks remain subject to timeout and trust review.

PreToolUse and PostToolUse cover local shell, apply_patch, MCP, and most other local function tools; hosted tools such as WebSearch do not use that local hook path, and specialized paths may opt out. These are host coverage boundaries, not evidence that every tool or hidden reasoning step was observed. PermissionRequest applies only when Codex is about to ask for approval, and SessionEnd does not run for subagents.

After the legacy variant is installed and enabled, inspect the exact Jev hook in Codex’s `/hooks` view before trusting it. The public hooks documentation says that installation or enablement does not automatically trust a hook; untrusted or modified definitions are skipped. The [current hook discovery implementation](https://github.com/openai/codex/blob/main/codex-rs/hooks/src/engine/discovery.rs) exposes the review fields used by the host, including the hook key, event, matcher, source path, plugin ID, current hash, enabled state, and trust status. Trust only the reviewed current hash. The underlying TUI procedure persists it through `hooks.state` using `config/batchWrite` with `merge_strategy: Upsert` and `reload_user_config: true`; see the [official hooks RPC implementation](https://github.com/openai/codex/blob/main/codex-rs/tui/src/hooks_rpc.rs). No global trust is changed by packaging or installation.

The bundled adapter targets twelve public events: `SessionStart`, `SessionEnd`, `UserPromptSubmit`, `PreToolUse`, `PermissionRequest`, `PostToolUse`, `PreCompact`, `PostCompact`, `SubagentStart`, `SubagentStop`, `Stop`, and `Interrupt`. Automatic classification maps them to task, tool, context, strategy, or result as described above; SessionStart remains guidance-only, while model, skill, and general choices remain MCP/guidance surfaces. It covers host-exposed local tools, including shell commands, patches and MCP calls, with recursion exclusions for Jev itself. Hook output is advisory: no permission approval, input rewriting, blocking, model switching, or task creation. Hosted tools and specialized paths may bypass hooks; hidden reasoning is not exposed. Model selection advice must be applied through actual supported host controls, and the caller supplies the available candidates.

The public contract and trust workflow are documented in [Codex hooks](https://learn.chatgpt.com/docs/hooks). All twelve events loaded as enabled and trusted in the original CLI 0.153.4 checks and in the fresh neutral-package installation on CLI 0.155.0. Native success, intentional failure, and delayed-command scenarios exercised SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, and Stop. Remaining event payloads have adapter tests; these are not a claim that every event was naturally triggered. Native command PostToolUse payloads exposed stdout without exit metadata, and the delayed-command case exposed only terminal hook output. The harness checks actual stdout digests and command-item exits separately. Native proof requires `hooks/list` to show the Jev entries with `enabled: true` and `trustStatus: "trusted"`, followed by fresh matching events and corroborating local receipts or logs.

No `apps` or arbitrary UI metadata is packaged. The tools are advisory and expose no file-editing or permission APIs, but the package is not globally read-only: `jev_status` is local and read-only, while `classify_failure` and `check_completion` evaluate selected evidence by sending it to TypeSafe and the runtime stores bounded receipts, local reservations and provider-reported token usage. Those fields are not provider billing totals; see [accounting semantics](accounting.md). None of the tools can grant permission, authorize credentials, merge or publish changes, certify tests, or infer completion from a provider response.

## Validation

Run the local canonical validator from the plugin root:

```bash
node scripts/validate-manifests.mjs
```

It validates `plugin.json` and `mcp.json` with Ajv’s draft-2020-12 implementation, checks the identity/interface and MCP parity of the legacy files, enforces the documented stdio path contract, confirms all three built skills are present, and rejects secret-bearing manifest fields. The Codex compatibility validator remains a separate check because its accepted manifest shape is intentionally narrower than the portable Agent Plugins schema:

```bash
python3 "$HOME/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py" .
```

The canonical schemas are normative for their closed documents. The published specification supplies additional semantic rules, including path containment, placeholder expansion, executable-token handling, and component failure isolation.

References:

- [Agent Plugins packaging](https://developers.openai.com/plugins/build/plugins)
- [Agent Plugins specification](https://agent-plugins.org/specification)
- [Agent Plugins MCP guidance](https://agent-plugins.org/plugin-authors/mcp-servers)
- [Codex hooks](https://developers.openai.com/codex/hooks/)


## Verified Codex environment compatibility

The portable root MCP schema intentionally contains no `env_vars`. The generated Codex `.mcp.json` compatibility overlay forwards the named `TYPESAFE_API_KEY`, documented `JEV_*` runtime settings and `XDG_STATE_HOME`. It contains no secret value. Current official Codex source explicitly merges local overlay `env_vars` into portable stdio declarations: https://github.com/openai/codex/blob/main/codex-rs/core-plugins/src/agent_plugin_mcp_overlay.rs . Actual installed-runtime results are recorded in the accompanying verification report. Other hosts must supply the credential using their supported environment configuration.

The host process itself must have the credential in its environment; an unrelated terminal export does not update an already-running desktop app. `jev_status` reports readiness without exposing the value. Normal hook trust and workspace allowlisting still apply; no global hook trust is changed by installation.

The native v0.2 verification first showed six Jev hooks enabled and trusted, while MCP startup failed with `No such file or directory (os error 2)`. That result is consistent with the old legacy `${PLUGIN_ROOT}` declaration reaching the stdio launcher literally; it does not show a hook or trust failure. The generated host-path rewrite above is the bounded packaging fix. The refreshed native run confirmed MCP startup and five-tool discovery. The legacy host does not inject PLUGIN_DATA into stdio MCP servers, so this variant uses the documented XDG state fallback. Previous portable-host accounting remains preserved in its original host-owned directory; no counters are reset or copied over current counters. Automatic lifecycle invocation is verified separately from MCP discovery.

## TypeSafe documentation audit (2026-09-18)

The current [API reference](https://docs.typesafe.ai/api), [models documentation](https://docs.typesafe.ai/models), and [confidence documentation](https://docs.typesafe.ai/confidence) were checked against the implementation. The request uses the documented fixed endpoint, bearer authentication, versioned model ID, state, and typed questions. Choice responses validate the complete distribution separately from confidence. The selected probability and confidence threshold are local advisory settings, not a provider correctness guarantee. The adapter's 48,000-byte request and 64 KiB response ceilings are local safety limits; TypeSafe documents Jev's input context in tokens, not those byte values.

TypeSafe publishes token-priced input usage and dynamic request/token rate limits; it does not document a 64-call daily allowance. The former default was an implementation mistake. All daily-call, daily-byte, and session-call defaults are now null (no plugin-imposed local cap). Only a user-selected policy value adds a local limit. Existing persisted policy must be explicitly reconfigured to null if it previously contained numeric caps; changing defaults does not erase that state. Accounting is preserved.

HTTP 422 is an invalid request; 429 is a provider rate limit; 529 is provider overload. Malformed successful JSON is an invalid response. This direct HTTP client does not automatically retry: bounded hook consultation fails open to keep the host responsive. If the caller retries later, the provider recommends exponential backoff and honoring Retry-After rather than an immediate retry loop. No provider billing, service capacity, or unlimited provider availability is promised.
