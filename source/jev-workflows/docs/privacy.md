# Privacy and data handling

Jev Workflows runs locally. The publisher operates no proxy or collection service for this release.

`preview`, `jev_status`, and local configuration do not contact TypeSafe. An authorized `evaluate` call sends selected question, context, candidate descriptions, and evidence to `https://api.typesafe.ai/v1/systemone`. Enabled automatic hooks send bounded excerpts of the current task and exposed tool inputs/results. Your TypeSafe API key is sent directly to TypeSafe as authentication. TypeSafe processes requests under its own service policies; provider retention is not controlled by this plugin.

The plugin redacts known credential patterns and excludes common binary, download, and secret fields. Redaction is imperfect: select relevant evidence and avoid supplying sensitive or unrelated material. It never reads the transcript path or scans arbitrary workspace files.

Local receipts retain input hashes, evidence identifiers, classifications, versions, timing, usage, observed provider request IDs/HTTP outcomes, and a SHA-256 credential fingerprint (never the key itself), without raw request payloads or provider error bodies. Hooks also keep bounded redacted task prompts and up to eight current-turn result summaries. These context caches expire for use after two hours and are removed when an expired entry is read; there is no background deletion guarantee. Receipts and usage files remain until you delete them.

`jev_status` identifies the actual state directory. Disable automation with `configure_automation({"enabled":false})` before removing its state. Deleting that directory removes receipts, cached context, accounting, and saved policy; preserve any records you need first. Uninstalling a plugin may leave its state directory behind.

Fresh installation has automation disabled. Enable it only for the workspaces you choose, and review host hooks. No analytics, advertising, publisher telemetry, or separate accounts are added. The plugin imposes no daily or session quota by default. Provider charges and rate limits still apply.

Report concerns through the repository's security reporting route or [issues](https://github.com/integrate-your-mind/jev-codex-plugin/issues). Do not post credentials, private logs, or confidential prompts in public issues.
