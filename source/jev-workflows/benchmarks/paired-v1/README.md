# Paired Codex pilot v1

This benchmark measures the **incremental effect of the installed Jev Workflows advisory plugin** on a fixed Codex model and effort. It does not test OpenRouter's model router or prove that Jev chooses better models.

Before inference, `preregistration.json` freezes four task prompts, an independent artifact grader and two repetitions per condition: 16 trials, eight matched pairs. Model/effort are selected from the native host default once and pinned. Trial order is deterministic and counterbalanced. A fresh workspace and ephemeral Codex thread are used for each trial. All failures and timeouts remain visible; there are no score-based reruns.

## Questions from X

Reviewed directly in authenticated X on 2026-09-26. These are motivations, not benchmark evidence:

- [Kerran MacDonald](https://x.com/kerranm/status/2103852283003851240): what refreshes tool advice when task context changes? Test replaced requirements and examine correlated lifecycle receipts.
- [Theo](https://x.com/theo/status/2103774771788108008): reports comparable DeepSWE performance to Astra low, slightly greater cost, and nearly five times the duration for OpenRouter Jev Router. His [follow-up](https://x.com/theo/status/2103775863343026253) distinguishes that criticism from Jev's broader usefulness. The post is a reported experiment; its reproducibility was not independently established here.
- [DesignCntrl](https://x.com/DesignCntrl/status/2102268489834573985): claims faster open alternatives. This requires a separate same-input classifier comparison; no alternative model superiority is established here.
- [NotASecretLich](https://x.com/NotASecretLich/status/2101483264191909926): reports time/cost savings from replacing selected workflow steps. Test selective replacement separately from adding advisory calls around existing reasoning.
- [Kevin Kern](https://x.com/kevinkern/status/2103783945003491330): reports worse results and time-limit issues in a small custom Codex routing experiment. Preserve timeout failures and measure end-to-end work.
- [Pavel Larionov](https://x.com/pa1ar/status/2103817557702758781): suggests assessing produced results instead of predicting effort. A future post-result-only condition can isolate this hypothesis.
- [Eric Provencher](https://x.com/pvncher/status/2103859274883748048): the visible excerpt questions whether short isolated tasks represent long-running work. This pilot is explicitly a harness/overhead study; longer real-repository tasks are required before productivity claims.

## What currently refreshes advice

In v0.4.0, distinct prompt, tool, result, compaction, subagent and stop lifecycle events can trigger a new evaluation under automation policy. SessionStart supplies guidance rather than making a provider request. Prompt updates refresh task context; PostToolUse supplies bounded recent results. There is no cached decision result reused by a TTL.

Duplicate event identities are suppressed. Changed semantics under a reused event identity do not invalidate that suppression. Changes that never reach a lifecycle event or explicit context update cannot be observed. Task context persists until replace/reset; prompt and recent-result caches expire separately. Therefore, event coverage and actual context propagation must be tested, not inferred from the presence of hooks.

Focused context/hook tests passed 31/31 before the pilot. These mocked tests establish mechanical behavior, not decision quality or task improvement.

## Scoring and interpretation

Primary metric: all-scheduled-trial artifact pass rate after successful isolation preflight. Completed-turn status is reported separately; the primary outcome follows the frozen artifact grader. The hidden-from-prompt grader runs after each trial, outside its workspace; it does not ask Jev or Codex whether the work succeeded. The grader path is not a hard filesystem secrecy boundary. Synthetic agents are instructed to remain in their workspace.

Secondary metrics: paired turn duration, startup separately, model tokens/cache usage when exposed, command counts/failures, Jev attempts/validated responses/abstentions, provider latency, hook duration, and changed-requirement correctness. Hook duration sums can overlap and must not be equated with critical-path overhead. Matched turn duration is the direct in-task overhead comparison; startup, oracle and cleanup are reported separately. API token fields are usage observations, not reconciled billing. Do not invent dollar savings from subscription usage.

Four small authored tasks and two repeats are insufficient for general productivity or statistical-significance claims. Repeated runs on one task are not independent task samples. Model nondeterminism, server load and prompt caching remain possible confounds even with counterbalancing. Accuracy at ceiling implies the task set cannot establish a quality gain. A null or negative result must remain published alongside positive results.

Treatment assignment, rather than successful Jev response, defines the primary comparison. Report unavailability and abstention without dropping those trials. A supplementary subset of successful provider calls may explain behavior but cannot replace the all-trial result. If no treatment call reaches Jev, the run measures integration failure and cannot establish the effect of functioning advice.

For this pilot, improvement means an observed quality gain with its time/token tradeoff, or lower time/token use at the same observed quality. Mixed results remain a tradeoff; do not collapse them into an arbitrary weighted score. No effect size is a general claim until a larger held-out study replicates it. Task-level pair rows, not individual test assertions, are the sampling units.

## Next study after the pilot

Freeze a larger held-out suite of real repository bug fixes with executable acceptance tests and multi-turn corrections. Compare fixed Codex, full plugin, and post-result-only or meaningful-checkpoint advice under identical capabilities. Separately measure batch versus serial decision latency, stale-context invalidation and out-of-distribution abstention. For model routing, execute each candidate model on the same tasks to obtain outcome-based routing labels; predicted confidence is not a routing oracle.

TypeSafe's current [coding-agent guidance](https://docs.typesafe.ai/introduction/coding-agents) describes Jev as a structured decision component rather than a replacement coding model. Its [fan-out pattern](https://docs.typesafe.ai/patterns/fan-out) recommends batching independent questions to save round trips. Its [1.13 limitations](https://docs.typesafe.ai/model-jaggedness/jev-1.13) warn about irrelevant context, indirection, numeric precision, and adversarial state. These support testing narrow, well-specified checkpoints and batching; they do not establish that advice at every lifecycle event improves performance.

Keep raw private logs/receipts locally. Publish sanitized per-trial rows, source hashes, configuration, failures, grader code and an exact reproduction command only after inspecting for private paths/credentials. No result-driven changes to plugin thresholds or quotas are part of this study.

## Reproduce

Use Node 22+, a signed-in Codex CLI, and the installed/trusted Jev plugin with automation already enabled. From `source/jev-workflows`, provide an absolute, new output directory:

```sh
npm run bench:paired -- --live \
  --tasks "$PWD/benchmarks/paired-v1/tasks.json" \
  --output /absolute/new/private/benchmark-output --repeats 2
node benchmarks/paired-v1/summarize.mjs /absolute/new/private/benchmark-output
```

The runner creates a private temporary Codex home, links existing authentication and the installed Jev package, and copies the existing trusted Jev hook hashes. It removes that temporary home on normal completion or a handled failure. It does not install plugins, alter global hook trust, or change user policy. The baseline has no plugins; the treatment has only Jev. Preflight verifies both conditions before inference and again before every trial. An isolation failure invalidates the comparison; retain its partial record, repair the harness, and label the subsequent execution separately. Do not present infrastructure failures as task-quality failures.

The current runner expects the installed identity `jev-workflows@personal`, exactly one cached version, existing trusted hooks, and Python 3.11+ for reading TOML. Another marketplace identity requires a harness adaptation and a new recorded runner hash. Both arms have network access because Jev needs it; offline task execution is a prompt constraint, not network isolation. The grader is withheld from the prompt, not protected by a hard filesystem boundary. Shared provider caches and installed Jev state are not reset. Fresh workspace/session identities isolate task context, and receipt attribution uses those identities rather than changes in global counters.

The first two execution attempts were discarded after non-Jev runtime plugin exposure despite successful initial preflights. Their partial rows remain retained, and prompts/grader remain unchanged. Those attempts warmed caches for some tasks; the final pilot is not a cold-cache experiment. Publication must disclose that pre-exposure and the harness fixes.
