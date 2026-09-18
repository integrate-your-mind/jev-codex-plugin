# Jev Workflows for Codex

An open-source Codex plugin for consulting [TypeSafe Jev](https://docs.typesafe.ai/) about tools, models, tasks, skills, context, strategies, and custom decisions. It also diagnoses failed commands and checks completion claims against evidence.

**Release candidate:** the source, packaged runtime and native integration have passed the checks in [VERIFICATION.md](VERIFICATION.md). Separate chat QA and provider dashboard reconciliation remain open. This is an independently maintained Git marketplace, not an approved OpenAI Directory listing.

## Install

Requires Node.js 22+ and your own `TYPESAFE_API_KEY` in the Codex host environment.

```sh
codex plugin marketplace add integrate-your-mind/jev-codex-plugin
codex plugin add jev-workflows@jev-workflows
```

Start a fresh Codex task and ask: **“Check Jev status, then use Jev to help choose tools and review my work.”** Review and trust the installed hooks when prompted. To enable automatic consultation, ask: **“Enable Jev automation for all my workspaces.”** Fresh installs keep automation disabled until you enable it.

There is no plugin-imposed daily, byte, or session quota by default. TypeSafe's API charges and rate limits apply. Prebuilt entrypoints are included; users do not need to run npm install.

## What it does

- `classify_decision`: compare your actual available candidates across eight domains or any custom taxonomy.
- `classify_failure`: diagnose a failed command using selected evidence.
- `check_completion`: assess whether evidence supports a claim.
- `jev_status` and `configure_automation`: inspect and control local operation.
- Three skills and twelve Codex lifecycle adapters provide consultation during work, where the host exposes events.

Jev returns a candidate or an abstention. It does not execute a decision, grant permissions, switch models automatically, or prove deployment. Hook coverage depends on the host; hidden reasoning and tools that bypass hooks are not observable.

## Source, releases, and verification

- [Complete source and development instructions](source/jev-workflows/README.md)
- [Installable Codex package](plugins/jev-workflows)
- [Release downloads](https://github.com/integrate-your-mind/jev-codex-plugin/releases)
- [Verification report](VERIFICATION.md)
- [Compatibility and event contract](source/jev-workflows/docs/compatibility.md)
- [Privacy and local retention](source/jev-workflows/docs/privacy.md)
- [Distribution and official-directory status](source/jev-workflows/docs/distribution.md)

The marketplace uses a generated compatibility package for current Codex hosts; portable Agent Plugins source is also included. This repository marketplace is publicly installable. It is not a claim of approval or listing in OpenAI's universal Plugins Directory, whose separate submission process currently requires HTTPS MCP or special local-MCP support.

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
