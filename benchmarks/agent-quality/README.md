# Reusable paired Jev coding study

This dependency-free Node.js 22+ harness runs identical organic coding tasks with Jev off and on. It supports native Codex CLI, Claude Code, and an already running QQ server. [SPEC.md](SPEC.md) freezes the experimental protocol. Development and confirmation tasks have external deterministic graders; the model never receives their assertions.

Run focused harness verification:

```sh
node --test benchmarks/agent-quality/runner.test.mjs benchmarks/agent-quality/corpus.test.mjs benchmarks/agent-quality/adapters/*-adapter.test.mjs
```

Use existing authenticated hosts. Build the plugin with the repository's normal local verification first. Freeze an output directory outside the candidate projects, then execute and summarize:

```sh
node benchmarks/agent-quality/runner.mjs freeze --phase preflight --hosts codex,claude,qq --out /absolute/private/run-01
node benchmarks/agent-quality/runner.mjs run --out /absolute/private/run-01
node benchmarks/agent-quality/runner.mjs summarize --out /absolute/private/run-01
```

After verifying actual model identities, isolated off arms and on-arm contact/delivery, freeze a fresh `--phase development --repetitions 5` cohort. Use `--phase confirmation` for the reserved tasks after freezing a repair. Never overwrite or reclassify a prior scored cohort. Re-running `run` resumes only unstarted rows; interrupted slots retain their identities. Keep at most two simultaneous host runners. Within a runner, execution is serial and on/off first order is counterbalanced.

`--host-config /absolute/private/hosts.json` can override per-host model, effort, pluginRoot, codexPath/claudePath, sourceCodexHome or QQ discoveryPath. Example model-only configuration:

```json
{
  "codex": {"model": "gpt-6-astra", "effort": "high"},
  "claude": {"model": "claude-opus-5-5[1m]", "effort": "high"},
  "qq": {"model": "openai-codex/gpt-6-astra", "effort": "high"}
}
```

Resolve supported models on each host before changing these values. An alias cannot substitute arbitrary resolved models; any permitted resolution must be frozen explicitly in `allowedResolvedModels`. Claude packages are generated from this repository by default. To use an already packaged Claude root, set its `pluginRoot` and `packageClaude:false`. QQ exercises its native Jev checkpoint integration, using an existing trusted profile and preserving user sessions and server configuration; a copied plugin tree does not establish the native binary's identity.

The primary outcome is a correct artifact across all required checks, with completion also requiring successful host termination. All scheduled failures and missing outcomes remain visible. Summaries include all-attempt wall time and ranges, task-level repeats, host usage and Jev receipt diagnostics. Costs are nullable: provider-calculated estimates, reconciled billing and subscription charges are different quantities. Unknown cost is never zero. Bootstrap intervals use tasks as clusters; repeated trials do not create new independent tasks, and an all-pass ceiling does not establish equivalence.

Raw transcripts, local paths, session IDs and credential references are private. No keys are copied into projects or reports. Publish sanitized aggregates and code only. Preserve source and immutable result evidence; disposable candidate directories are removed after confirmed host termination. A retained workspace with `cleanupRequired` needs owned-run reconciliation before deletion.
