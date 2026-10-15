# Jev cross-host update (2026-10-15)

Owner: root integration owner. Request: Romy's October 15 update across Codex, Claude Code and QQ. Native goal is active in the original chat. This document extends the plugin's existing verification records; it is not a separate delivery queue.

## Intended behavior

A user can install the same Jev decision engine in Codex or Claude Code, submit typed questions with current task context, receive advisory decisions, and inspect provider-confirmed receipts. QQ consumes the same documented wire contract with native Rust types. A provider or host failure preserves ordinary agent execution and host authorization. No artificial daily/session quota is introduced. A provider response, action performed and task acceptance remain separate states.

## Architecture and state

Keep the portable TypeScript engine canonical; generate host packages with native manifests, variables and supported events. Codex retains its existing adapter. Claude gets a thin input/output adapter, not a fork of decision/policy/accounting code. Preserve the installed Codex credential file, policy and receipt directory. For this local Claude installation, explicitly point its MCP and hooks to that existing state directory; use host-prefixed session IDs so task caches do not collide. Distributed Claude defaults to a durable per-user state directory; never store state in a versioned plugin cache.

Claude events have no Codex turn_id. A Claude UserPromptSubmit creates a local turn identity and atomically stores it beneath the private session state; subsequent events reuse it. A missing identity stays explicitly unavailable, never inventing provider evidence. Normalize PostToolUseFailure to the common result path but preserve the original event name in output. Only documented events are registered. No permission decision, tool argument mutation, Stop continuation, or automatic model switch is emitted. Unsupported events remain silent. The adapter must avoid invoking Jev recursively on its own tools.

Validate at boundaries: request construction, provider responses, hook envelopes, and package generation. Network sends are bounded/redacted and cancellable. Credentials remain in existing environment/protected files and are never serialized into packages, fixtures, public evidence or command arguments. Source packages contain no local machine paths. Optional host-local package configuration contains paths only. State files use restrictive permissions, atomic replacement and per-session ownership; concurrency must not corrupt another session. Existing accounting and receipts remain readable; no destructive migration. Recovery is reinstalling the prior retained package with the same state directory.

## Contract synchronization

Research current official Jev API/model documentation first. Record endpoint, request model selector, response model rules, primitive schemas, provider limits and errors in one versioned JSON contract plus reusable fixtures. TypeScript and Rust tests consume the same contract revision and fixture bytes. A deterministic sync/check command compares the QQ copy with this canonical source and fails on drift. It performs no background networking or automatic upgrades. Engine safety bounds are documented separately from provider limits and usage quotas.

## Scope and tradeoffs

Implement the current documented Jev decision API capabilities relevant to these integrations; record any unsupported primitive explicitly. Do not add a second orchestrator, recurring monitor, auth flow, bulk historical benchmark, or QQ login/TUI changes. Provider aliases may evolve; preserve actual resolved model in receipts and validate documented alias relationships. Never claim an accuracy improvement from transport compatibility tests. Host versions are tested independently; initial Claude discovery reported 2.1.218; native installation and runtime QA used Claude Code 2.1.301.

## Acceptance

- A1: typed normal, invalid, unknown-model, timeout/rate-limit/provider-error and cancellation fixtures pass in each client; actual provider model and request ID are retained.
- A2: Codex existing hook/MCP tests and real installed smoke continue to work with unchanged credential/state and unlimited policy.
- A3: Claude native manifest validates; user-scoped installed inventory confirms the plugin; a fresh native Claude session loads the plugin and successfully uses its MCP tool with a real provider receipt. Normal and failed tool hooks carry task context, and plugin-owned tools do not recurse. No permissions are weakened.
- A4: QQ uses the synchronized contract and passes relevant Rust tests plus repository-required formatting/lint/build verification. Its dirty dogfood checkout and unrelated work remain intact.
- A5: deliberately modifying a copied contract fixture makes the drift check fail; restoring it passes. Document a single update command and shared release compatibility revision.
- A6: source and generated packages agree, meaningful independent review covers the exact final source head, and reviewable public PRs link raw sanitized verification. CI/merge/store approval/runtime/quality outcomes are reported separately.

## Verification outputs

Retain release dist and sanitized receipts under verification/. Temporary test directories are owned by the test that creates them and removed in finally blocks. Dependencies are shared/reused only where ownership is established; do not delete another task's outputs. A final evidence record will identify revisions, scenarios, observed outcomes, independent review and any concrete remaining dependency.

## Sources checked

- https://docs.typesafe.ai/llms.txt
- https://docs.typesafe.ai/api
- https://docs.typesafe.ai/models
- https://code.claude.com/docs/en/plugins-reference
- https://code.claude.com/docs/en/hooks
- https://code.claude.com/docs/en/plugin-marketplaces

## Experimental media boundary

Explicit batch callers may opt into images and Box with an experimental flag. Support the documented JSON assets representation so MCP clients do not need multipart handling: PNG/JPEG base64 assets, referenced by name in state/instructions/criteria, with validated format, dimensions and byte bounds. No automatic screenshot capture, remote URL fetch or file reading. Reject unused/missing references and malformed images locally. Box requires Jev 1.14/preview and an image; validate ordered unit-square coordinates and nullable confidence. The ordinary text path, hooks and default model remain unchanged. Multipart is an alternate wire encoding, deliberately omitted because JSON assets carry the same capability. QQ's present callers remain text choices; its shared contract records media capability without adding an unrelated visual UI workflow.

## Shared identity and repeatable CI follow-up

Romy requested consistent naming for both hosts and repair of this repository's CI. Keep one repository and one engine. The public product name is Jev Workflows; both host manifests, marketplaces, skill namespaces and MCP IDs retain `jev-workflows`. Keep the existing repository URL to preserve installations and links. Generated packages must fail verification if either identity or display name drifts. No credential, state, policy or receipt migration is needed.

The integration owner owns the CI entrypoint and PR; the existing Claude adapter owner owns host descriptions and installation documentation. Independent review covers the final revision. The smallest useful unit is a shared verification command used by local execution and Actions, plus host identity checks and clear installation instructions. Acceptance is native manifest validation, source tests, negative identity/distribution fixtures, package parity, installed host discovery and a GitHub-visible status tied to the tested commit. A new commit requires new evidence.

The personal GitHub account currently rejects Actions before jobs start because of a billing lock. Preserve that failure and the existing hosted workflow. Provide a local verification command without GitHub credentials or provider calls, and publish its result separately as local validation using the commit-status API after verifying a clean, trusted checkout of the exact SHA. This does not claim Linux Actions ran or clear the account lock. No public-repository self-hosted runner, recurring watcher, billing change, GitHub App, new secret or paid infrastructure is introduced. Untrusted fork code requires disposable machine isolation; a temporary directory is not a security boundary.

Verification fails on the first failed command. Local dependencies and temporary snapshots are disposable; release bundles, public sanitized evidence and existing private receipts are retained. No durable runtime state changes, migrations or concurrency beyond the existing test suite are required. The previous shared packages remain the rollback artifacts.
