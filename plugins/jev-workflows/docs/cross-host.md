# Cross-host Jev configuration

Codex and Claude Code use one TypeScript decision engine and separate native host packages. QQ uses a Rust boundary checked against the same language-neutral contract revision. No recurring update job is installed.

## Model and protocol

- Default model: pinned `jev-1.13.0`.
- `JEV_MODEL`: `jev-1.13.0`, `jev-1.14.0`, `jev-latest`, or `jev-preview`. Unknown selectors fail locally. Aliases may advance; receipts preserve the resolved version. This selects Jev, not the host's coding model.
- `JEV_LONG_CONTEXT=1`: sends TypeSafe's explicit long-context header. It does not increase this adapter's selected-context or payload bounds. Long context remains off by default.
- Input and output token counts are independently nullable. Accounting totals only reported values and separately counts missing fields. Local receipts are not a billing ledger.
- One HTTP attempt per evaluation. Caller-controlled retry can produce another request and receipt. Automatic hook deadlines remain short; no silent retry multiplies attempt counts.
- HTTP 400/408/413/415 and existing auth/rate-limit/provider errors retain typed diagnostics and request IDs when available.

The provider supports more context and options than the ordinary plugin's bounded selected-context interface. These per-request bounds are privacy/resource safeguards, not daily usage quotas. Defaults remain unlimited for calls, bytes per day and hook calls per session. A user can still deliberately configure limits.

## Claude Code

Install from the repository's `.claude-plugin/marketplace.json`. The generated `plugins/jev-workflows-claude` contains only Claude-compatible manifests, native `${CLAUDE_PLUGIN_ROOT}` references and prebuilt runtime. Validate with `claude plugin validate` and verify a fresh session actually loads its MCP tools and hooks.

The adapter creates a private local turn ID on UserPromptSubmit and reuses it for subsequent events. Session identities are prefixed with the host name. PostToolUseFailure uses the common result analysis with the original event name restored in output. Missing context, malformed input, disabled policy, unauthorized workspaces and provider failure are fail-open. Permission and completion events never change host permissions or force an additional turn.

Set `TYPESAFE_API_KEY` in the host environment or `JEV_API_KEY_FILE` to an existing protected literal credential file. No credential values belong in manifests or command arguments. Local packaging can pass `--credential-file` and `--state-directory` paths to both MCP and hooks. For a shared Codex/Claude installation, use the existing Jev state directory; no credential or receipt migration is needed. Default distributions use durable user state outside the plugin cache. Active sessions must reload to see changed packages.

## Shared QQ contract

`contracts/jev/contract.json` records current API invariants, supported models and documented sources. `conformance.json` supplies language-neutral response cases. Both TypeScript and Rust tests consume those bytes.

```sh
node scripts/sync-jev-contract.mjs /path/to/qq
# After reviewing a deliberate contract update:
node scripts/sync-jev-contract.mjs --write /path/to/qq
```

Then run both repositories' checks. The command updates only QQ's two contract files, checks repository identity and rejects symlink targets. It does not overwrite implementation or install software. QQ's existing choice-based approval/checkpoint/routing consumers retain their own policies, thresholds and evidence semantics. Experimental media does not silently become a QQ visual workflow.

## Experimental media

`evaluate_decisions` accepts explicit JSON PNG/JPEG assets and Box questions behind an experimental images flag. No hook captures a screenshot, reads an image file or fetches a URL automatically. Image callers choose the data to send; binary image contents cannot be text-redacted. Use non-sensitive images. Previews show metadata rather than base64, and receipts retain digests rather than raw images. Box requires Jev 1.14 or its preview alias. Coordinates and optional confidence remain advisory.

JSON assets implement the documented media capability. Multipart and request compression are alternate transport encodings and are not required by this adapter. Audio and video are not supported by Jev. Experimental formats and accuracy may change; this update proves compatibility, not quality uplift.

Sources: https://docs.typesafe.ai/api, https://docs.typesafe.ai/models, https://docs.typesafe.ai/images, https://docs.typesafe.ai/sdk/javascript/changelog, https://code.claude.com/docs/en/plugins-reference, https://code.claude.com/docs/en/hooks.
