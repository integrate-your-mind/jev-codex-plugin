# Standalone Jev command

The bundled `scripts/jev.mjs` is a prebuilt Node.js 22+ program. Resolve its absolute path from this skill's location and run it with `node`. No MCP server or dependency installation is required.

```sh
node /absolute/path/to/diagnose-failure/scripts/jev.mjs status
node /absolute/path/to/diagnose-failure/scripts/jev.mjs classify-failure < request.json
node /absolute/path/to/diagnose-failure/scripts/jev.mjs classify-failure --evaluate < request.json
```

The paths above are placeholders: use the actual skill path. `request.json` is a local file containing only the selected request; preserve any user file and clean up an owned temporary request when no longer needed. Piping an equivalent JSON object to stdin also works. Do not paste secrets in chat or shell arguments. `TYPESAFE_API_KEY` must already be configured in the process environment for evaluation. A running host may need a restart after its environment changes. Do not restart unrelated work automatically.

Use this shape, replacing the example with observed task evidence:

```json
{
  "task": "Run unit tests",
  "command": "npm test",
  "exitCode": 1,
  "output": "AssertionError: expected 1 to equal 2",
  "evidence": [
    {
      "id": "test-log",
      "text": "AssertionError: expected 1 to equal 2",
      "source": "selected test output"
    }
  ],
  "outputTruncated": false
}
```

Without `--evaluate`, the command constructs a local redacted preview with no provider call. An input `mode: "evaluate"` without the flag is rejected. An explicit `mode: "preview"` together with `--evaluate` is also rejected; choose one mode. With the flag and existing user authorization, selected redacted content is sent directly to `https://api.typesafe.ai/v1/systemone` using `jev-1.13.0`. The same provider charges and limits apply as MCP. There are no plugin-imposed call or byte quotas by default; explicit user settings are honored.

Stdin must be a single JSON object and is capped at 128 KiB before parsing. The service further limits serialized provider requests to 48,000 bytes. The CLI does not read request paths itself, inspect the repository, or modify automation settings.

Local `status` reports credential presence, whether evaluation is enabled, and configured caps in `quotas`; it does not count remaining calls, provider successes, or billing.

Send only the evidence required for this request, even in preview. Redaction is defense in depth; host logs may retain stdin and stdout.

The output is one JSON object. For nonzero exit codes, inspect the `error` field (there is no `status` on that envelope); otherwise inspect `status`, not just the process exit code:

- `preview`: local payload only; no Jev assessment happened.
- `assessed`: validated advisory answer; inspect the returned choice/category/support and evidence IDs.
- `abstained`: insufficient evidence or confidence; continue normal reasoning.
- `unavailable` or `skipped`: inspect `reasonCode`, report relevant limitations, and continue ordinary work.
- An `error` field, such as `{"error":"evaluation_requires_flag"}`: malformed CLI input or execution error; process exits nonzero. Never retry simply to obtain a preferred answer.

Evaluation state first uses a valid absolute `JEV_STATE_DIRECTORY`. Otherwise `JEV_STATE_MODE=user` chooses `$XDG_STATE_HOME/jev-workflows` or `~/.local/state/jev-workflows`; without user mode, `PLUGIN_DATA` takes precedence over that user directory. A host-specific `PLUGIN_DATA` can therefore keep CLI and MCP state separate. Do not change global settings to force sharing; use the host's existing authorized configuration. A provider request ID is transport evidence, not billing confirmation. Standalone commands start a fresh process, so the MCP server's in-memory response cache does not span separate CLI invocations.

This skill does not register tools or hooks. Public Git distribution is supported by the project; acceptance into OpenAI's Directory is a separate review, especially when core functionality requires local execution or persistent credentials.
