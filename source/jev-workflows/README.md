# Jev Workflows

A portable Codex plugin that consults Jev for tool, model, task, skill, context, strategy, result, outcome, and custom classification decisions. The current source package is version 0.4.0. It includes eight MCP surfaces, three independently usable skills, bundled JavaScript entrypoints, and scoped lifecycle hooks.

## Capabilities

| Tool | Purpose |
| --- | --- |
| `classify_decision` | Choose among 1–12 caller-supplied candidates for any classification. |
| `classify_failure` | Diagnose a completed failed command from selected evidence. |
| `check_completion` | Assess whether evidence supports a completion claim. |
| `jev_status` | Read local readiness, limits, versions, and automation policy. |
| `configure_automation` | Enable, scope, or disable local automatic consultation. |
| `evaluate_decisions` | Evaluate independent typed Choice, Noul, and Score questions against one selected structured state. |
| `update_task_context` | Maintain bounded context scoped to a workspace, session, and agent. |
| `record_decision_outcome` | Link a caller-reported observation to an existing local receipt and evidence IDs. |

The `classify-decision` skill applies throughout a task. Supply actual available tools, model/effort pairs, tasks or categories, constraints in `context`, and relevant evidence. Jev returns a validated candidate ID or abstention. Codex applies advice through ordinary tools and existing authorization; Jev never grants permission, edits files, changes models, or certifies execution by itself.

```json
{
  "domain": "tool",
  "question": "Which tool can inspect the supplied PNG layout?",
  "context": "The question concerns visible spacing in a local PNG.",
  "candidates": [
    {"id": "view_image", "description": "Inspect the rendered local image."},
    {"id": "rg", "description": "Search source text for matching strings."}
  ],
  "evidence": [{"id": "artifact", "text": "The artifact is image/png."}],
  "mode": "preview"
}
```

`preview` is the default and makes no network request. `evaluate` sends selected redacted question, context, candidates and evidence to TypeSafe in a billable provider API request. A user request to use Jev, or enabled scoped automation, authorizes relevant evaluations without repeated questions. Do not send whole transcripts, credentials, environment dumps, or unrelated files. Redaction is defense in depth.

### Typed batch questions, context, and outcomes

`evaluate_decisions` evaluates independent questions together against one bounded structured `state`. Each question is typed as `choice`, `noul`, or `score` and carries its own instructions, criteria or candidates, optional domain, and optional policy. Choice questions use one to twelve caller-supplied candidates plus a service-owned non-action insufficient_evidence option; Noul questions return a bounded signal; Score questions use an explicit ordered rubric. Questions share state but must be independently answerable; combine their answers in caller code rather than asking one question to depend on another answer.

The policy is resolved per question. `conservative` is the default and applies the configured confidence and probability floors where relevant; a low-confidence Choice or Score is reported as abstained. `ranking` preserves the provider distribution for caller-side ranking and reports a ranking disposition instead of a recommendation. Policies carry a version and are marked `not_locally_calibrated`; neither disposition grants permission or proves an outcome.

`update_task_context` stores bounded redacted context locally for an explicit workspace, session, and optional agent scope. `continue` adds current facts, `replace` starts a new root objective and replaces the accumulated constraints and criteria, and `reset` writes a fresh empty record for that scope. Items and evidence references retain source, timestamps, operation, and other bounded provenance; scope identifiers are stored as hashes. Context is advisory input and does not change Codex settings or permissions.

`record_decision_outcome` stores references from an actual action to an existing local receipt and evidence IDs. It records what the caller reports (`supported`, `contradicted`, or `unknown`) and derives any provider request ID from that receipt, but it does not copy evidence or claim independent verification, billing, authorization, deployment, or acceptance.

## Automatic consultation

Fresh installations default to disabled. When the user requests automation, call:

```json
{"enabled": true, "scope": "all-workspaces", "maxHookCallsPerSession": null, "maxCallsPerDay": null, "maxBytesPerDay": null}
```

For selected projects, use `scope: "workspaces"` with absolute `workspaces` paths. Disable with `{"enabled": false}`. Host hook review/trust is separate from this local policy. Trust only the reviewed installed Jev definitions.

The adapter targets all twelve Codex lifecycle events declared in [hooks/hooks.json](hooks/hooks.json): `SessionStart`, `SessionEnd`, `UserPromptSubmit`, `PreToolUse`, `PermissionRequest`, `PostToolUse`, `PreCompact`, `PostCompact`, `SubagentStart`, `SubagentStop`, `Stop`, and `Interrupt`. It supplies bounded advisory context and validated assessment fields where an event is assessed. Automatic domains are task for user prompts and subagent starts, tool for pre-tool and permission events, context for compaction events, strategy for interrupts, and result for post-tool, stop, subagent-stop, and session-end events; SessionStart supplies local guidance. Jev's own calls are excluded. Timeouts, unavailable credentials, abstention, exhausted budgets, and invalid events leave Codex work able to continue. Hooks never approve permissions, rewrite arguments, block actions, or force additional turns.

The MCP `classify_decision` tool accepts the domains `tool`, `model`, `task`, `skill`, `context`, `strategy`, `result`, and `general`. Automatic hooks use the event mapping above; model, skill, and general remain available through MCP and guidance because Codex has no native model-change hook or supported hook output that switches models. This is broad consultation on exposed decisions, not access to hidden reasoning. Hosted tools and specialized paths can bypass hooks. See the [event contract](docs/compatibility.md#native-event-contract) for payload and output details.

## Install and compatibility

Requires Node.js 22 or later on the runtime PATH. Prebuilt `dist/` files need no npm install. Provide `TYPESAFE_API_KEY` through the host environment; `jev_status` reports only whether it is configured. Keys never belong in manifests, source, command arguments, or release archives. An export in an unrelated terminal does not update an already-running app's environment.

For a long-running MCP process whose key may rotate, opt in with `JEV_API_KEY_FILE` set to the absolute path of a private file owned by the current user with mode `0600`. It must contain exactly one literal assignment in the form `export TYPESAFE_API_KEY='<actual supported key>'` and an optional final newline; replace the bracketed placeholder with the key from TypeSafe. File-sourced keys must be 80–512 characters from `A–Z`, `a–z`, `0–9`, `.`, `_`, and `-`, with at least 12 distinct characters. This is a local safety constraint so automatic hooks can suppress a queued event containing a rotated-out key; TypeSafe's API documentation specifies bearer authentication but does not guarantee this key format. Keys supplied directly in the environment are unaffected. The reader never executes shell syntax. Each request uses one snapshot of the current file, and cache entries are isolated by credential. An unreadable, malformed, unsupported, or missing configured file stops evaluation without falling back to a previously captured environment key. A running host must receive the new path setting through its supported environment configuration once; rotating file contents afterward needs no MCP restart.

The portable package has root `plugin.json` and `mcp.json`. The initial Codex CLI 0.153.4 audit found that loader recognized this format but skipped its bundled hooks. The generated compatibility package has since passed native installation and hook checks on CLI 0.155.0. Generate it with:

```sh
node scripts/package-host.mjs /absolute/release-directory/jev-workflows
```

The generated variant retains `.codex-plugin/plugin.json`, `.mcp.json`, skills, hooks and runtime, and omits the two portable root manifests. Install the prebuilt Codex variant from the public repository marketplace and review its hooks. The default generated package aligns MCP and hook state using `JEV_STATE_MODE=user`, without machine-specific absolute paths. Both packages use the same code. The Codex overlay forwards approved environment names only, with no credential values. See [compatibility](docs/compatibility.md).

## Standalone skills and CLI

Each skill includes a prebuilt `scripts/jev.mjs`. When its MCP tool is available, the skill uses it; otherwise it can invoke that local CLI with Node.js 22 or later. No npm install or MCP server is needed. The standalone path supports decision classification, failure diagnosis, completion assessment, and typed batches through evaluate-decisions. It does not install automatic hooks or expose `configure_automation`.

```sh
node dist/cli.mjs status
node dist/cli.mjs classify-decision < request.json
node dist/cli.mjs classify-decision --evaluate < request.json
```

The CLI accepts a single JSON object on stdin. Without `--evaluate`, it produces a local preview. Evaluation requires the flag and either `TYPESAFE_API_KEY` in the process environment or `JEV_API_KEY_FILE` pointing to the protected file described above; never put the key in arguments or request JSON. `classify-failure` and `check-completion` accept the same inputs as their MCP counterparts. Parse the JSON result's `status`: exit code 0 includes valid `unavailable`, `skipped`, and `abstained` outcomes. The runtime, provider schema, redaction, receipts, and optional user settings are shared with MCP. Separate CLI processes do not share the server's in-memory cache.

Build standalone ZIPs with `node scripts/package-skills.mjs /absolute/fresh/output-directory`. Install each extracted skill directory in a skill location supported by the host (for example `$CODEX_HOME/skills`, normally `~/.codex/skills`); keep `SKILL.md`, `references/`, and `scripts/` together. Avoid installing duplicate skill copies when using the full plugin. Local scripts require a host that supports process execution; the companion is not a hosted service.

The public repository and Git marketplace are available distribution routes. OpenAI Directory approval is separate: current submission guidance may require partner review for core local execution or persistent credentials. These ZIPs do not establish Directory eligibility or supply a remote MCP endpoint.

## Limits and evidence

The endpoint is fixed to `https://api.typesafe.ai/v1/systemone` and the model to `jev-1.13.0`. The plugin applies local safety ceilings of 48,000 bytes to each serialized request and 64 KiB to each response; these are byte limits in this adapter, not TypeSafe's token context limit. TypeSafe documents a 64k-token request context for Jev 1.13, including a 32k-token state-plus-longest-question limit. Explicit evaluations time out after ten seconds. Hook consultations use a five-second host deadline, a four-second adapter deadline, and a three-second provider deadline, with shorter lifecycle paths; they do not retry automatically. Conservative per-question policy defaults to 0.6 confidence and 0.6 selected probability where those signals apply; ranking policy preserves distributions and does not force a recommendation. These are provisional operating thresholds, not correctness guarantees.

There is no plugin-imposed daily call, daily byte, or per-session call cap by default (`null` means unlimited). Jev's own API rate limits still apply; rate-limit and overload responses fail open without immediate retries. Usage accounting remains enabled and is never reset when settings change. Optional user-chosen caps can be configured through policy or `JEV_MAX_CALLS_PER_DAY` / `JEV_MAX_BYTES_PER_DAY`; explicit environment values take precedence and accept `unlimited`. An existing persisted numeric policy remains in force until it is explicitly changed to `null`; changing the defaults does not erase prior policy state. `jev_status` labels local reserved attempts separately from retained response evidence, nullable remaining configured caps, and UTC accounting rollover. A reservation is recorded before dispatch and is never a successful-request or billing count. Assessed and abstained responses can both carry provider-reported token usage. New receipts retain observed HTTP status, timestamps, provider request IDs when supplied, and a nonsecret credential fingerprint; historical receipts cannot be retroactively attributed. See [accounting](docs/accounting.md). Repeated unchanged requests can reuse the MCP cache, event IDs deduplicate hook delivery, and `JEV_ENABLED=0` disables provider requests.

Private state lives in host `PLUGIN_DATA` for portable clients; generated Codex compatibility packages use shared user state. Otherwise it lives in `$XDG_STATE_HOME/jev-workflows` or `~/.local/state/jev-workflows`. Compact receipts preserve digests, evidence IDs, validated answers, versions, timing and usage; they contain no raw request or provider error body. Automatic hooks retain bounded redacted scoped task context until reset or local deletion; older prompt caches expire after two hours. Invocation records contain compact metadata. They never read or transmit `transcript_path`.

## Build and verify

```sh
npm ci --ignore-scripts
npm run typecheck
npm run build
npm test
npm run validate
```

`dist/` is the retained release output. Tests remove their own temporary state under `work/`. Unit and MCP protocol tests make no live provider calls. Separately gated live evaluators require `JEV_RUN_LIVE_EVAL=1` and freeze fixture expectations before any request. Synthetic tool/model/task examples demonstrate classifier behavior, not measured model performance or universal runtime coverage.

`scripts/package.mjs` packages source and prebuilt runtime without dependencies, state, receipts, or credentials. The verification report accompanying the release records exact tested versions, native invocation evidence, live Jev results, and remaining limitations.

## References

- [OpenAI plugin packaging](https://developers.openai.com/plugins/build/plugins)
- [Codex hooks](https://developers.openai.com/codex/hooks/)
- [TypeSafe API](https://docs.typesafe.ai/api)
- [TypeSafe confidence](https://docs.typesafe.ai/confidence)
