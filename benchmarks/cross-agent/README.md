# Agent-neutral benchmark pack

This pack uses the existing Harbor/Pier task interface rather than a Codex-only task format. Agents receive the same repository problem; a separate verifier scores the submitted artifact. The normalized [comparison contract](comparison-contract.md) distinguishes an isolated Jev treatment from a comparison between complete agents.

## Inputs and current evidence

| Component | Purpose | What has been measured |
| --- | --- | --- |
| `smoke/` | Three portable single-turn JavaScript tasks with independent verifiers | Offline controls and runtime validation receipts; not an agent quality score |
| `deepswe-v1.1.lock.json` | Deterministic 20-task real-repository sample | Task identities and source hashes frozen; no new model results yet |
| Native Codex pilot | Actual installed plugin on a fixed model, four tasks including changed requirements | [16 completed trials and independent artifacts](../results/2026-09-26-paired-v1/README.md) |
| QQ | Reuse its existing Harbor adapter and headless trace contract | Adapter inspected; the current Harbor subclass needs a Pier-native bridge before running this pinned Pier suite |

The portable smoke deliberately excludes `changed-route`: flattening its second-turn correction into the initial prompt would change the experiment. Multi-turn orchestration remains in the native runner until a shared event-injection contract is implemented.

## Pinned upstream sources

- [DeepSWE v1.1](https://github.com/datacurve-ai/deep-swe/tree/0b9fabbb63b9104d678fe965e1632f2dd9eaa2ea), commit `0b9fabbb63b9104d678fe965e1632f2dd9eaa2ea`.
- [Pier](https://github.com/datacurve-ai/pier/tree/4f3441fb3e7c21ce8a4ed0b6155a8d9a176a645a), commit `4f3441fb3e7c21ce8a4ed0b6155a8d9a176a645a` (`datacurve-pier` 0.3.1).
- Harbor 0.20.0; Python 3.12.13. [Observed dependency lock](requirements.lock.txt) records the validation environment. The lock pins versions and Pier's Git revision; it is not a hash-verified, cross-platform wheel lock.

DeepSWE has 113 tasks in this pinned revision. Selection sorts SHA-256 of `jev-cross-agent-v1` concatenated with the task ID, then freezes the first 20. This is our selection algorithm, **not** Pier's integer `--sample-seed` algorithm. The lock includes task trees, exact task configuration hashes, base commits, and one attempt per task. No DeepSWE inference preceded this selection. See [Theo's methodology](../theo-methodology.md) for the unavailable details that prevent an exact replication claim.

Do not redistribute upstream task repositories under this plugin's MIT license. DeepSWE's [PROVENANCE](https://github.com/datacurve-ai/deep-swe/blob/0b9fabbb63b9104d678fe965e1632f2dd9eaa2ea/PROVENANCE.md) preserves individual project licenses alongside the benchmark's Apache-2.0 contributions. This repository publishes selection metadata, not copies of those upstream tasks or reference solutions.

## Reproduce the pack without inference

Run from this repository root with Node 22+ and Python 3.11+:

```sh
node --test benchmarks/cross-agent/tests/*.test.mjs
node benchmarks/cross-agent/export-smoke.mjs --output /absolute/new/smoke-pack
git clone https://github.com/datacurve-ai/deep-swe /absolute/new/deep-swe
git -C /absolute/new/deep-swe checkout 0b9fabbb63b9104d678fe965e1632f2dd9eaa2ea
node benchmarks/cross-agent/freeze-upstream.mjs \
  --repo /absolute/new/deep-swe --output /absolute/new/deepswe.lock.json
cmp benchmarks/cross-agent/deepswe-v1.1.lock.json /absolute/new/deepswe.lock.json
```

The freezer rejects the wrong revision, dirty checkout, malformed task contracts, duplicate selections, and overwriting an existing lock unless explicitly requested. Use a clean new output directory; export and freeze tools do not need provider credentials.

To install the observed runner environment into a private virtual environment:

```sh
uv venv --python 3.12 /absolute/new/pier-runtime
uv pip install --python /absolute/new/pier-runtime/bin/python \
  -r benchmarks/cross-agent/requirements.lock.txt
```

To exercise actual runner wiring without a model call, use the no-op agent. Reward **0** is expected because the initial implementation is broken:

```sh
/absolute/new/pier-runtime/bin/pier run \
  --path benchmarks/cross-agent/smoke/interval-repair \
  --agent nop --env docker --n-concurrent 1 --n-attempts 1 --max-retries 0 \
  --job-name smoke-nop --jobs-dir /absolute/new/pier-results
```

The agent image contains only the initial workspace. The verifier receives the collected solution file, runs offline, and starts with reward 0. Its grader is excluded from the agent build context. The generated manifest records hashes; runtime receipts record what was actually exercised. These controls prove plumbing and acceptance/rejection behavior, not model performance.

Completed validation: [Docker positive/negative/missing-artifact controls](smoke-runtime-validation.json) and [actual Pier no-op trial](pier-runtime-validation.json). Both used the digest-pinned generated task pack and made zero model calls. The retained Pier receipt includes hashes of its private raw result and artifact manifest.

## Run the shared reducer on real Codex results

[normalized-codex-pilot](normalized-codex-pilot/manifest.json) translates the completed 16-trial public pilot into the same records a QQ or other adapter can emit. This translation was made after measurement; its original frozen plan remains in the source result package. It reproduces all eight paired deltas and preserves unknown billing, unresolved provider routing, and unenforced native resource limits rather than inventing values.

```sh
node benchmarks/cross-agent/normalize-paired.mjs /absolute/new/normalized-pilot
node benchmarks/cross-agent/compare.mjs \
  --plan /absolute/new/normalized-pilot/plan.json \
  --trials /absolute/new/normalized-pilot/trials.jsonl \
  --out /absolute/new/normalized-pilot/recomputed-comparison.json
```

The tests exercise the real public pilot as well as missing, mismatched, and null-measurement cases. The reducer verifies recorded consistency; it cannot independently prove that a runner recorded the truth.

## Real-repository study protocol

Use the exact 20 task names in the lock, passed individually with Pier's repeatable `--include-task-name` option against the pinned `tasks/` directory. Do not sample again. Before inference, save the complete run plan, hashes, normalized condition definitions, runtime/provider revisions, image digests, task order and resource limits. The general reducer rejects incomplete or mismatched cohorts; it cannot discover unrecorded changes in an adapter.

For the first fixed-model comparison, run the same Codex CLI version, model, effort, provider, credential class, task images, host architecture, timeout and resource budget in both conditions. The declared difference is Jev Workflows disabled versus enabled, with its exact plugin revision and exposed hooks. Keep both conditions' task-network restrictions equal; allow provider and TypeSafe endpoints explicitly in the adapter. Preserve warm/cold cache policy and counterbalance order. No artificial daily Jev quota is introduced.

Use one attempt per task, concurrency one, and zero adaptive retries. Retain infrastructure-invalid trials and publish their denominator separately; do not relabel an agent timeout or context exhaustion as infrastructure failure. Report both all-scheduled outcomes and the prespecified valid-task analysis. A corrected infrastructure rerun is a separate identified run, never a silent replacement of a failed score. Freeze the treatment before looking at held-out task results.

Record end-to-end elapsed time, agent working time, setup and verifier time separately. Match Theo's working-time metric only if its boundaries agree. Include router and Jev latency/cost in the treatment. Sum input/output once; cached input is a subset of input, and reasoning output may already be included in output. Retain unknown billing as null until correlated provider records establish dollars. Report task pass fractions, paired task outcomes, mean cost and mean working time, plus median/tail times. Do not replace these with a made-up combined score.

The first 20-task pass is descriptive. Before a confirmatory claim, freeze a distinct held-out sample or the remaining corpus and prespecify uncertainty estimates at the **task** level. Repeated trials of one problem do not create new independent problems. Publish null and harmful effects alongside improvements.

## Other agents, including QQ

The tasks, verifiers, selection lock and normalized result contract are reusable. Each agent needs an adapter that preserves those boundaries; an importable class alone does not establish compatibility.

QQ already has a public [Harbor adapter](https://github.com/retsu-AI/qq/tree/f7640231900477ec8d6fa7e3a8d284f26ca7a3ce/benchmarks/harbor), headless JSONL execution, and ATIF conversion. Pinned Pier has additional installation and provider-network contracts and a distinct Python base class. The current QQ Harbor adapter cannot be claimed to run unchanged under it. A Pier-native bridge must implement those methods and preserve trace/accounting conversion before any live QQ score is reported. QQ's key-forwarding and summary fixes also need to be present in the exact tested revision; credentials must never be copied into result files.

Concretely, the bridge needs Pier's `BaseInstalledAgent`, `install_spec()`, `network_allowlist()`, `environment.agent_process_env(...)`, and Pier trajectory validation. Simply adding missing methods to a Harbor subclass skips Pier's post-run accounting path. The pinned runtime uses a filtered Squid egress proxy, not a billing proxy. QQ's plain-HTTP provider client bypasses proxy handling, so HTTPS gateway/proxy compatibility must be tested before a provider-backed run. These are inspected integration requirements, not a completed adapter.

QQ's checkpoint, routing, and approval features are separate factors. Checkpoint enforcement can serialize tools, so a combined on/off comparison would include that scheduling change. Record them explicitly. Comparing Codex with QQ is a whole-agent comparison, even when model and task settings match. Comparing each agent with and without the same narrowly defined Jev feature can estimate within-agent effects; do not pool them into a universal plugin speedup.

## Questions for subsequent experiments

- Full lifecycle advice versus advice only at changed objectives, failures, or result checkpoints.
- Batched versus serial independent decisions with identical evidence and questions.
- Refresh after changed constraints, unavailable tools, contradictory results, compaction, and reused event identities.
- Model routing with outcomes from all candidate models as hindsight labels, rather than confidence as ground truth.
- Larger real-repository tasks, cache behavior, correct abstention and useful fallback.

These are proposed ablations, not results. The current negative pilot is preserved before any implementation tuning.
