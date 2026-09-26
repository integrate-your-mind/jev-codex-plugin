<img src="assets/jev-workflows-mark.svg" width="80" height="80" alt="Jev Workflows branching decision icon">

# Jev Workflows for Codex

An open-source Codex plugin for consulting [TypeSafe Jev](https://docs.typesafe.ai/) about tools, models, tasks, skills, context, strategies, and custom decisions. It also diagnoses failed commands and checks completion claims against evidence.

The current source package is version **0.4.0**. It includes the full MCP plugin, eight MCP tools, twelve lifecycle adapters, and three standalone skills that work without MCP. See [verification results](VERIFICATION.md) for tests and independent agent QA. This community Git marketplace is publicly installable; OpenAI Directory review is separate.

**Official catalog status:** the catalog contribution is [prepared in a public fork](https://github.com/openai/plugins/compare/main...integrate-your-mind:codex-official-plugins:jev-workflows-marketplace-entry), but OpenAI restricts upstream PR creation to repository collaborators. No official store listing is live. The separate directory draft also needs local-plugin compatibility review; [publication requirements](source/jev-workflows/docs/publication.md) record the remaining dependencies.

## Install

Requires Node.js 22+ and your own `TYPESAFE_API_KEY` in the Codex host environment.

```sh
codex plugin marketplace add integrate-your-mind/jev-codex-plugin
codex plugin add jev-workflows@jev-workflows
```

Start a fresh Codex task and ask: **“Check Jev status, then use Jev to help choose tools and review my work.”** Review and trust the installed hooks when prompted. To enable automatic consultation, ask: **“Enable Jev automation for all my workspaces.”** Fresh installs keep automation disabled until you enable it.

There is no plugin-imposed daily, byte, or session quota by default. TypeSafe's API charges and rate limits apply. Prebuilt entrypoints are included; users do not need to run npm install.

## Standalone skills

For hosts that run local skill scripts, download and extract one or more skill ZIPs into a supported skill directory. Each includes instructions and a prebuilt Node.js CLI; no npm install or MCP server is required. Keep the entire extracted folder together. Use the full plugin when you want automatic hooks.

The download links below contain the version 0.4.0 standalone skills. The Git marketplace includes all eight MCP tools and the lifecycle hooks.

- [Decision classification](https://github.com/integrate-your-mind/jev-codex-plugin/releases/download/v0.4.0/classify-decision.zip)
- [Failure diagnosis](https://github.com/integrate-your-mind/jev-codex-plugin/releases/download/v0.4.0/diagnose-failure.zip)
- [Completion evidence review](https://github.com/integrate-your-mind/jev-codex-plugin/releases/download/v0.4.0/check-completion.zip)

The CLI defaults to a local preview. Authorized evaluation requires `--evaluate` and your TypeSafe key in the environment. Read its JSON status; an abstention or unavailable result does not stop ordinary work. [Usage and boundaries](source/jev-workflows/README.md#standalone-skills-and-cli).

## What it does

- `classify_decision`: compare your actual available candidates across eight domains or any custom taxonomy.
- `classify_failure`: diagnose a failed command using selected evidence.
- `check_completion`: assess whether evidence supports a claim.
- `evaluate_decisions`: evaluate independent typed Choice, Noul, and Score questions against one shared structured state.
- `update_task_context`: maintain bounded, provenance-bearing context for one workspace, session, and agent, with explicit continue, replace, and reset operations.
- `record_decision_outcome`: link a caller-reported observation to an existing local receipt and evidence IDs without treating it as independent verification.
- `jev_status` and `configure_automation`: inspect and control local operation.
- Three skills include prebuilt CLI fallbacks, and twelve Codex lifecycle adapters provide consultation during work, where the host exposes events.

Jev returns a candidate or an abstention. It does not execute a decision, grant permissions, switch models automatically, or prove deployment. Hook coverage depends on the host; hidden reasoning and tools that bypass hooks are not observable.

The batch interface sends independent questions together over one selected, bounded state. Choice questions rank supplied candidates, Noul questions provide a bounded signal, and Score questions use an explicit ordinal rubric. Conservative policy can abstain when the applicable confidence or probability threshold is not met; ranking policy preserves the returned distributions for caller-side ranking. These outputs remain advisory and do not authorize actions.

Task context is local and scoped to the actual workspace, session, and agent. `continue` adds current facts, `replace` starts an explicit new objective, and `reset` clears that scope. Updates retain bounded provenance, evidence references, corrections, criteria, and candidate catalogs. Outcome records link local receipts and evidence IDs to what the caller reports happened; they are never independent proof of success, billing, permission, deployment, or acceptance.

## Source, releases, and verification

- [Complete source and development instructions](source/jev-workflows/README.md)
- [Installable Codex package](plugins/jev-workflows)
- [Release downloads](https://github.com/integrate-your-mind/jev-codex-plugin/releases)
- [Verification report](VERIFICATION.md)
- [Compatibility and event contract](source/jev-workflows/docs/compatibility.md)
- [Privacy and local retention](source/jev-workflows/docs/privacy.md)
- [Distribution and official-directory status](source/jev-workflows/docs/distribution.md)

The marketplace uses a generated compatibility package for current Codex hosts; portable Agent Plugins source is also included. This repository marketplace is publicly installable. It is not a claim of approval or listing in OpenAI's universal Plugins Directory, whose separate submission process currently requires HTTPS MCP or special local-MCP support.

The Git marketplace remains the primary installation route. Standalone skill
ZIPs are additive distribution artifacts; their availability does not establish
official directory approval or partner acceptance of local execution and
persistent credential handling.

## Development

```sh
cd source/jev-workflows
npm ci --ignore-scripts
npm run typecheck
npm run build
npm test
npm run validate
```

Tests use disposable local fixtures. Live evaluation is separately gated and requires an authorized TypeSafe key. No credentials, private receipts, or user transcripts belong in commits or issue reports.

[MIT license](LICENSE). Independent community integration by Romy Mondello; not an official OpenAI or TypeSafe product.
