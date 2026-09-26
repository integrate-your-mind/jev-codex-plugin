# Privacy and data handling

Jev Workflows runs locally. The publisher operates no proxy or collection service for this release.

`preview`, `jev_status`, task-context updates, outcome recording, and local configuration do not contact TypeSafe. An authorized `evaluate` call sends selected questions, structured state/context, candidate descriptions, and evidence to `https://api.typesafe.ai/v1/systemone`. Enabled automatic hooks send bounded excerpts of the current task and exposed tool inputs/results, including relevant saved task context. Your TypeSafe API key is sent directly to TypeSafe as authentication. TypeSafe processes requests under its own service policies; provider retention is not controlled by this plugin.

The plugin redacts known credential patterns and excludes common binary, download, and secret fields. Redaction is imperfect: select relevant evidence and avoid supplying sensitive or unrelated material. It never reads the transcript path or scans arbitrary workspace files.

Local receipts retain input hashes, evidence identifiers, classifications, versions, policy values, timing, usage, observed provider request IDs/HTTP outcomes, and a SHA-256 credential fingerprint (never the key itself), without raw request payloads or provider error bodies. Invalid-response diagnostics retain bounded structural/numeric information rather than the raw provider body. Supplied correlation identifiers should be opaque IDs, not private titles or free-form descriptions.

Versioned task records retain bounded redacted objectives, steps, constraints, criteria, corrections, evidence references, candidate catalogs and update provenance in workspace/session/agent scopes. They remain local until relevant fields are included in an authorized evaluation, and remain on disk until explicitly reset or removed. Hooks also keep bounded current-turn result summaries; the older short-lived context caches expire for use after two hours when read. There is no background deletion guarantee. Outcome records retain a receipt reference, reported action/result, selected evidence references and provenance. They identify caller-reported observations and do not certify that an outcome was independently verified. Receipts, indexes, outcome records and usage files remain until you delete them.

`jev_status` identifies the actual state directory. Disable automation with `configure_automation({"enabled":false})` before removing its state. Deleting that directory removes receipts, cached context, accounting, and saved policy; preserve any records you need first. Uninstalling a plugin may leave its state directory behind.

Fresh installation has automation disabled. Enable it only for the workspaces you choose, and review host hooks. No analytics, advertising, publisher telemetry, or separate accounts are added. The plugin imposes no daily or session quota by default. Provider charges and rate limits still apply.

Report concerns through the repository's security reporting route or [issues](https://github.com/integrate-your-mind/jev-codex-plugin/issues). Do not post credentials, private logs, or confidential prompts in public issues.
