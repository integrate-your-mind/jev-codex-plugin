# Jev plugin value study

Status: protocol draft; no scored DeepSWE inference has started. Runtime identity,
image digests, and the machine-readable schedule must be frozen before launch.
This is a plugin experiment, not a model-router comparison.

The [26 September runtime amendment](runtime-amendment-2026-09-26.md) freezes
the remote execution boundary and required native controls before inference.
The [local MCP registration amendment](runtime-amendment-local-mcp-2026-09-26.md)
corrects the registry setting after a preserved startup failure; model task
execution still selects only the remote environment.
The [separate verifier amendment](runtime-amendment-verifier-2026-09-26.md)
restores the upstream tests build with a pinned base and recorded image identity.
The [host hook directory mapping amendment](runtime-amendment-cwd-mapping-2026-09-26.md)
records the per-run host/container alias needed by the pinned hook launcher.

## Question and estimand

Does enabling the released Jev Workflows 0.4.0 plugin change the probability that
the same Codex model completes a real repository task correctly? The primary
estimand is treatment minus control in independent task-verifier pass rate over
the frozen 20-task DeepSWE sample. Secondary outcomes describe completion claims,
advice delivery, recovery, latency, and token burden. Jev does not grade itself.

The earlier four-task synthetic pilot is a separate completed study. Both arms
passed all eight trials; treatment was slower in every pair, with an 18.7%
median paired increase in summed turn time. That pilot supplies no demonstrated
quality gain and is not pooled with DeepSWE.

## Frozen inputs and treatment

- Dataset: `../cross-agent/deepswe-v1.1.lock.json`, DeepSWE revision
  `0b9fabbb63b9104d678fe965e1632f2dd9eaa2ea`.
- Task selection: the existing deterministic 20-task list, seed
  `jev-cross-agent-v1`; no substitutions based on outcomes or perceived difficulty.
- Current-plugin source: repository revision
  `7dfe432d7463bab7186a8dacf50924af282f9a20`, released plugin 0.4.0. Preserve an
  immutable distribution snapshot and hashes before any repair work.
- Intended fixed agent: Codex CLI 0.155.0, `gpt-6-astra`, medium reasoning. Both
  arms use the same resolved provider, capabilities, instruction template,
  repository image, tool interface, time limit, and network policy.
- Control: plugin disabled, no Jev hooks or MCP server, no Jev-specific injected
  instructions. Treatment: the current plugin enabled with its actual native
  hook/MCP behavior. Neither arm receives benchmark answers or verifier source.
- No plugin-imposed daily quota. Provider failures and abstentions remain
  observed outcomes. A trial deadline bounds an experiment; it is not a product
  usage quota.

The upstream corpus and one-attempt methodology match the benchmark Theo used.
His exact 20 task IDs and raw run settings are unknown. This is an independently
selected sample and cannot be described as an exact replication of his run.

## Execution contract

Run one attempt in each arm for all 20 tasks (40 scheduled trials). Pair adjacent
arms on the same task to reduce host/time drift. Alternate which arm runs first
by frozen task position, giving ten control-first and ten treatment-first pairs.
Use fresh task containers, sessions, plugin state, and working trees. Do not
carry advice, edits, outcomes, or task context from one arm into another.

Honor the task TOML's resource and timeout settings. Current inspected tasks use
two CPUs, 8192 MB RAM, 20480 MB task storage, a 10800-second agent timeout, and a
separate 1800-second verifier timeout. Record enforced versus merely requested
limits and any architecture emulation. Resolve image digests; mutable tags alone
are not adequate provenance. Download/start only the task images in use.

Task command execution follows upstream `no-network`. Model and Jev transport
must be outside that command boundary. Reusable account credentials must not be
readable by task commands. Record the actual executor and any departure from the
public Pier runtime; verify both native hooks and equivalent tools before
inference. If this cannot be implemented, report an infrastructure blocker rather
than silently changing task conditions.

Collect the committed patch as required by upstream. Run the original verifier
against a pristine separate environment with no network. Keep reference
solutions and verifier tests out of the agent filesystem and prompts. Never feed
verifier failures back into the scored attempt. Frozen setup controls may inspect
plumbing without solving tasks; disclose them separately.

No selective reruns, task replacement, outcome-driven stopping, or profile
changes. Record launch failures, timeouts, interrupted runs, missing artifacts,
and invalid responses. An infrastructure repair creates a new explicitly named
cohort if it changes scored conditions; preserve all prior attempts. Resume an
unstarted scheduled row only, never overwrite a started row or choose its best
attempt. Stop only for a concrete runtime/access failure or user instruction,
and report the incomplete denominator.

## Measurement and analysis

Primary: independently verified pass/fail per task. Report both paired counts
and scheduled denominators: control-only pass, treatment-only pass, both pass,
neither pass, and missing/infra-unresolved. Infrastructure failure is neither
silently dropped nor represented as a proven code defect. Present operational
success over all scheduled trials alongside the quality comparison over valid
pairs, with an explicit missing-data sensitivity range.

Report the paired pass-rate difference and uncertainty at the task level. Use
an exact two-sided paired sign/McNemar test on discordant pairs and a declared
task-pair bootstrap interval for the effect; describe instability with only 20
tasks and do not treat test assertions or repeated model tokens as samples.
Statistical significance is not the only useful result. A wide interval or a
zero observed difference means the study is inconclusive about small effects.

Secondary, separately labeled exploratory measures:

1. Agent completion versus artifact verification; explicit false completion or
   test-passed claims checked against independent evidence, with unknowns kept.
2. Advice delivery: candidate chosen, candidate actually exposed to Codex,
   abstention/unavailable reason, context/candidate fingerprints, and stable
   event-to-receipt linkage for both hooks and explicit MCP calls.
3. Advice uptake: the next relevant action agrees, contradicts, or is unclear.
   Temporal adjacency is not proof that advice caused an action.
4. Recovery: repeated failed commands, distinct corrective actions, time to
   recovery, and unresolved failure. Incidental failures and injected feature
   scenarios are separate strata.
5. Active agent wall time including hook waits, startup/setup/verifier time
   separately, provider latency distribution, tool counts, hook count and time.
6. Input, cached-input subset, output, and reasoning tokens separately. Actual
   billed cost only when reconciled to billing; missing dollar cost stays null.
7. Requirement freshness, avoidable calls, harmful advice, confidence/abstention
   coverage, and invalid response rate where a preregistered rubric exists.

Counterbalancing does not eliminate shared-host load or provider cache effects.
Record timestamps and cached tokens. Do not claim the plugin is faster based on
provider latency alone or count successful HTTP responses as useful decisions.

## Development and ablations

The prospective component comparisons, configuration selection rule, and disjoint
follow-up sampling are specified in [development-selection.md](development-selection.md).
This does not change the frozen current-plugin treatment or its scheduled trials.

Keep authored feature scenarios disjoint from all DeepSWE tasks. First reproduce
current behavior with frozen truth labels and payloads. Mocked-provider tests
prove adapter behavior only. Live Jev tests measure decision correctness on those
authored cases; they do not establish final-code improvement.

Before tuning, preserve the current-plugin snapshot and baseline measurements.
Evaluate candidate repairs separately:

1. Align each question with its candidate catalog and pass the validated selected
   candidate through the hook to Codex.
2. Send one bounded decision-relevant state, with current constraints and tool
   evidence; measure information lost through redaction/truncation and prevent
   valid saved context from becoming an invalid classification request.
3. Supply actionable, deterministic descriptions tied to the selected candidate;
   do not ask Jev to invent free-text rationale or treat confidence as proof.
4. Consult at relevant task transitions, failures, and completion checkpoints;
   compare with current event coverage without adding a quota.
5. Batch independent typed questions over shared state; compare to serial calls
   while preserving the same questions and code-level applicability decisions.
6. Matched generic/shuffled advice controls on the development suite to separate
   useful information from extra tokens, delay, or merely asking Codex to reflect.

Do not change several factors and attribute the result to one. Freeze any repaired
treatment before another task-quality study. The original 20 tasks become a
previously used evaluation set after inspecting results; a confirmatory claim
for tuned repairs requires a disjoint held-out sample or explicit validation
label, not reuse presented as fresh evidence.

## Decision rule

Retain a broad benefit claim only with independently verified positive task
quality evidence and disclosed cost/latency tradeoffs. A task-level improvement
of at least two net tasks out of 20 is a practical signal worth a larger study;
it is not by itself statistically conclusive. A positive lower confidence bound
supports a claim limited to this cohort, not universal coding-agent superiority.

If current integration breaks advice delivery, repair that defect regardless of
whether the model is useful, then measure the repair separately. If benefit is
limited to failure recovery, context refresh, or completion checks, narrow the
recommendation to those features. If quality stays unchanged while overhead
increases, recommend selective/opt-in use and further targeted measurement. If
harmful advice or regressions dominate, recommend disabling the affected feature.
Do not change the user's installed defaults during this study without an
explicit, evidence-based decision. Preserve negative and inconclusive results.
