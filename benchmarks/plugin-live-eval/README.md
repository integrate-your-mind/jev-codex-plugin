# Plugin decision evaluation harness

This harness measures decision plumbing only. It does not run DeepSWE, grade a coding task, infer provider superiority, or claim that advice improves an agent. The authored set has 18 practical synthetic episodes, six families with three episodes each, two counterbalanced arms, and two repetitions: 72 planned attempts.

Each episode carries a native `task_context` projection with a root objective, latest step, constraints, criteria, corrections, evidence references, and concrete candidate IDs/descriptions. The driver also seeds the same context through each source's native `updateTaskContext` API. The provider-facing input is created by the actual imported `runDecisionHook`; episode truth is kept only in `oracle.json` and is loaded after the hook call for descriptive scoring.

The arms are imported independently from the exact `src/decision-hook.ts` paths supplied by `--baseline-source` and `--repair-source`. The driver records each source's Git revision, source tree digest, entrypoint digest, and per-attempt arm digest. It refuses an identical baseline and repair source hash and checks both hashes again after the run. The baseline is pinned by source content (`sourceSha256=7b805b1784720cf18748c4b0c6d727134eb76713c4b0ebe96fa96cc49b9348e8`, `entrypointSha256=c1c42678a526277b8af022dbc279968db29901ff719973fa9db1e746cd5f56dd`); its Git revision is recorded as provenance.

The published cohort is complete. Preserve its frozen inputs and results. Validate
the existing freeze with Node 22.23.2:

```sh
NODE22="${NODE22_BIN:-node}"
test "$("$NODE22" --version)" = "v22.23.2"
"$NODE22" benchmarks/plugin-live-eval/freeze.mjs
```

For a separate reproduction, use exact baseline and repair source snapshots and a
new private output directory outside the public checkout. Never replace the
original completed transcript or re-freeze changed inputs under its cohort name.
The driver starts a Node worker with the source tree's pinned `tsx` loader, so it
imports TypeScript source rather than a stale distribution artifact:

```sh
mkdir -m 700 /absolute/path/to/new-private-results
"$NODE22" benchmarks/plugin-live-eval/run.mjs \
  --dry-run \
  --baseline-source /absolute/path/to/baseline/source/jev-workflows \
  --repair-source /absolute/path/to/repair/source/jev-workflows \
  --workspace /absolute/path/to/workspace \
  --out /absolute/path/to/new-private-results/dry-run.jsonl
```

Dry run constructs the native `createService` for each arm and supplies only a local schema-valid `fetch` transport. It verifies that root/latest context, candidate IDs, evidence, and the truth boundary reach the sanitized model payload, and verifies that abstention output contains no directional `decision=` field. It does not contact the provider. `test.mjs` covers distinct arm imports, missing-context detection, the 72-attempt durable plan, private output mode, truncation, and exclusive output creation.

Live mode is an explicit separate action:

```sh
JEV_RUN_LIVE_EVAL=1 JEV_LIVE_EVAL_AUTHORIZED=1 \
"$NODE22" benchmarks/plugin-live-eval/run.mjs --live \
  --baseline-source /absolute/path/to/baseline/source/jev-workflows \
  --repair-source /absolute/path/to/repair/source/jev-workflows \
  --workspace /absolute/path/to/workspace \
  --out /absolute/path/in/a/private-0700-directory/live.jsonl
```

The live path configures the native workspace policy with unlimited optional caps, constructs the native `createService` for each arm, forwards the native fetch, uses the existing credential-file loader, and never prints keys, credential fingerprints, provider request IDs, or raw provider payloads. It records only safe receipt fields: local receipt ID/persistence, request-ID presence, transport attempt/HTTP response/validated response counts, nullable token usage, confidence/probabilities, status, choice, and latency. Billing is unknown. Every attempt writes a durable `attempt_started` row before invocation and one terminal row afterward; errors remain in the log and are never selectively retried. Existing output paths are rejected with exclusive creation.

The summary fields `rawChoiceCorrect`, `abstentionCorrect`, `deliveredUsefulChoice`, and `neutralAbstentions` are decision-level diagnostics against the independent synthetic oracle; abstention correctness never treats a missing choice as an accidental null match. Report delivered-correct IDs and abstention outcomes separately; neither is a task-quality outcome. This comparison changes a bundle of question alignment, context projection, candidate validation, and rendering, so it cannot attribute any difference to one component. In particular, Q05 catalog richness and Q07 descriptive rendering are not isolated factors, and the current repair output validates candidate IDs rather than candidate descriptions. The research-question mapping is recorded per episode (`Q05` concrete catalogs, `Q06` choice preservation, `Q11` task switch, `Q13` failure evidence, `Q14` truncation, `Q15` confidence, `Q20` abstention, `Q26` completion claims, `Q31` irrelevant state). Q31 is represented as a single unrelated-state diagnostic and is explicitly unmeasured as a clean-versus-padded invariance experiment. The copied research record is advisory and not an oracle.
