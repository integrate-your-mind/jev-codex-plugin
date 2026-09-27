# X research: Jev plugin value, 26 September 2026

Read-only follow-up to Boris Tane's post. Original posts and replies were read
in Chrome; linked reports, current documentation, benchmark source artifacts,
and two preprints were reviewed. These are external authors' findings, not
experiments reproduced by this project. No plugin defaults or frozen cohorts
were changed. No new scored benchmark ran for this research.

## Findings and evidence limits

### Production classification: replacement versus added advice

[Boris's post](https://x.com/boristane/status/2103597100483358873) links
[Polylane's report](https://polylane.com/blog/we-swapped-our-llms-for-jev/).
It reports replacing existing LLM decisions for response routing, incident
relationships, PR close reasons, severity, and resource ranking. Aggregate P90
fell from 4,752 to 508 ms; estimated cost per 1,000 completed calls fell from
$0.76199 to $0.46369. Page-authored chart metadata covers 20 September 20:00
through 24 September 20:00 UTC: 36,664 LLM versus 23,951 Jev calls, approximate
P90. These are unequal completed-call populations, not a paired task experiment.
[Boris's quality reply](https://x.com/boristane/status/2103882550808866971) says
quality was roughly unchanged; the reviewed report supplies no quality dataset.

Our inference: replacing a separate classifier call can save its cost and
latency. An advisory plugin adds work unless its recommendations eliminate
other work or improve outcomes. Polylane's percentage does not transfer to Codex.

### Context selection

[You.com's original post and thread](https://x.com/youdotcom/status/2103565692494925906)
report threefold token reduction and 84% accuracy on Vertical RTK by putting
Jev between retrieval and synthesis. The post does not establish improvement
over a matched accuracy baseline. A reply specifically challenges freshness:
relevant but stale evidence can remove the current evidence the synthesizer
needs. Treat these numbers as a product report, not a plugin benchmark.

Plugin hypothesis: rank candidate tool descriptions, relevant files, or retrieved
evidence before Codex consumes a large set. Measure required-evidence recall,
current-constraint retention, latency, and independently graded final outcomes.
Reducing tokens is a benefit only if important information survives.

### Trace judges: small studies are useful but narrow

[LangChain's study](https://www.langchain.com/blog/jev-agent-evals-langsmith)
reports 500/500 human-label agreements on five frozen weather-agent traces,
each judged 100 times, with 0.44-second mean Jev calls and low score variance.
That is five distinct cases, not 500 distinct tasks. LLM settings used provider
defaults; Jev service version was absent. Their
[published repository](https://github.com/danielgshea/jev-as-a-judge) is useful
for replay methodology. The X article and live blog differ in some examples;
use TypeSafe's API documentation for primitive semantics.

[MLflow's technical-QA experiment](https://www.mlflow.org/blog/jev-llm-judge/)
reports Jev, Terra, and Luna all matching labels on 30/30 examples, with Jev
median 369 ms. Each example includes documentation; labels are excluded from
provider input. One label correction and a narrow dataset limit generalization.
This supports testing evidence-grounded completion checks, not assuming they
prove code correctness.

### Public leaderboard interpretation

[JevBench's author](https://x.com/airesearch12/status/2103267815373574573)
explains that its composite ranks intelligence, calibration, speed, and cost
equally; winning the combined rank need not mean better decisions. Preserve
separate axes in our reports.

[Decision Index](https://huggingface.co/spaces/multimodalart/jev-decision-index)
was checked through its source because the live app stayed on Loading. Pinned
[data artifact](https://huggingface.co/spaces/multimodalart/jev-decision-index/resolve/1555c82d56292bc7759d159d68866c021607d443/data/index.json):
Decision Index 0.2.1, generated 2026-09-26 15:13:31 UTC. Jev 1.13.0 has
balanced_raw 68.08, balanced_skill 57.89, breadth_skill 57.07. These are distinct
weighted metrics, not interchangeable accuracy values. The X discussion's
79.4% claim could not be tied to this current aggregate. The index excludes
unrun interactive environments and does not measure repository task completion.
Its confidence audit still finds wrong answers at high confidence; remote HTTP
latency includes scheduling, network, and retries. The reusable
[harness](https://github.com/apolinario/decision-index) was reviewed at
19ad28ec9485493cc4f7fc07d91c178f948e6434; no benchmark data was downloaded.
That checkout's README describes an older 0.2 corpus. Exact reproducibility of
the newer 0.2.1 board requires resolving this source/data version mismatch.

[Maxime Rivest's comparison](https://x.com/MaximeRivest/status/2103810265548534102)
argues for task-specific small classifiers once labels and volume justify them.
The post is a reason to include deterministic and specialized baselines, not
evidence that its break-even estimates apply to changing Codex decisions.

### Confident errors and fallback limits

[Rao and Callison-Burch's preprint](https://arxiv.org/abs/2609.29769) examines nine
panels from seven public benchmarks. It reports shared errors across judges;
a replayed cascade improves at most 1.5 points over the best single judge with
cross-fitted thresholds. Escalating to another model does not guarantee an
independent correction. This is an author-reported replay, not a plugin test.

[Li et al.'s preprint](https://arxiv.org/abs/2609.26550) studies 1,312 decisions,
including a 642-item pilot and disjoint 670-item extension. It reports poorer
performance on derivation/coding judgments than ordinary preference/factuality;
9 of 138 high-probability JudgeBench judgments at q >= 0.9 were wrong. These
findings motivate hard negative cases and local calibration, not treating a
confidence threshold as proof of completion. Later model additions are
exploratory. Neither preprint was independently reproduced here.

## Documentation-grounded experiment changes

[State guidance](https://docs.typesafe.ai/concepts/state) separates evidence from
questions, recommends named structured context, and allows several independent
questions over one shared state. [Fan-out guidance](https://docs.typesafe.ai/patterns/fan-out)
recommends batching questions and filtering applicability in code. Our proposed
experiments preserve broad tool/model/task/skill/context coverage and impose no
daily usage quota.

1. **Information delivery first.** Keep the frozen 72-call study intact. It
   already tests current versus repaired question/catalog/payload/delivery.
   Add a separate native test that observes a concrete recommendation reaching
   Codex and the resulting action; matching actions alone do not prove causation.
2. **Compare placement.** On disjoint development tasks, compare consultation
   at every current event with consultation on material state changes. Changes
   include objectives, constraints, candidate availability, new evidence,
   failures, and completion criteria. Stable advice reuse must invalidate on
   any relevant change. Event relevance is an experiment, not a product quota.
3. **Separate batching from scheduling.** Hold state, questions, candidate order,
   and thresholds fixed; compare serial versus packed calls. Record all
   per-question outcomes, invalid responses, retries, tokens, and full latency.
   Never use one independent question's answer as evidence for another in the
   same request. Apply exact permissions and applicability rules in code.
4. **Add retrieval preservation tests.** Include stale but relevant distractors,
   newest user corrections, no-fit catalogs, renamed/unavailable tools, and
   critical evidence near truncation boundaries. Compare simple deterministic
   selection, Jev selection, and no filtering. Score both evidence recall and
   downstream task success.
5. **Calibrate on failures.** Use independent tests/human labels for false
   completion, unsupported claims, partial success, failed tests, and missing
   evidence. Report false acceptance, abstention, coverage, multiclass/Binary
   probability scores with definitions, and confidence-bin uncertainty. Fit
   thresholds on development data; evaluate on disjoint held-out tasks.
6. **Keep task outcomes decisive.** Fixed model and effort, counterbalanced
   task pairs, fresh state, original verifier, full scheduled denominator.
   Report success, harmful advice, wall time, tokens, actual billed cost when
   available, and cost per verified success separately. Add matched
   generic/shuffled advice only as a named control; do not pool it with baseline.

## Relationship to current evidence

The [completed Codex pilot](../results/2026-09-26-paired-v1/README.md) remains
8/8 passes in each arm, with treatment 18.7% slower in median paired summed
turn time. The [72-call decision study](../results/2026-09-26-plugin-decisions-v1/summary.json)
remains 36/36 provider decisions correct per arm, but concrete-choice delivery
improved from 0/32 to 32/32 and Jev input tokens fell from 53,522 to 38,508.
That establishes a delivery/payload improvement, not task-quality lift.

The frozen DeepSWE schedule is unchanged and has zero scored trials. The prior
preflight failed before inference with Docker BuildKit read-only filesystem
and host ENOSPC; this research did not retry Docker. After report writes
succeeded, one retry of the previously interrupted package regeneration
succeeded. Both missing generated files are restored; distribution parity and
three drift tests pass. Frozen source and installed defaults are unchanged.
Native DeepSWE runtime controls remain unfinished. No new release, installation,
marketplace acceptance, or performance claim follows from this report.

## Sydney Runkle follow-up: decisions inside an executable workflow

The user subsequently shared [Sydney's X article](https://x.com/sydneyrunkle/status/2103560531235795129).
It was read in Chrome and traced to the
[official LangChain article](https://www.langchain.com/blog/building-prod-with-jev-and-langgraph),
its demo source, and Browserbase's linked implementation PRs. The article
combines typed, batched judgments with stateful code that chooses the next
operation, persists progress, and supports intervention. It reports 5–6x
classification-step speedup; that is not an end-to-end Codex result.

### What the underlying examples actually establish

The [demo gist revision](https://gist.github.com/sydney-runkle/a632ba4ea0b2b72501dfa4b6ab2a7d8a/revisions/9bd06dc63f0408c980b3a5aa37d06cc1d97a813b)
uses six synthetic pages and interchangeable classifiers. It reports route
agreement, without independent correctness labels. Classifier duration is
summed and divided by call count; concurrent graph wall time is separate.
Native typed Jev requests and schema-constrained Claude prompts differ. Gateway
Jev 1.13.0 and optional direct `jev-latest` use different paths; retries are not
explicitly accounted for. Its example timing table and the article's headline
are different reported summaries, not a single reproducible aggregate.

[Stagehand PR 2953](https://github.com/browserbase/stagehand/pull/2953)
was open and experimental when inspected. It reports median act time
1.97→0.46 seconds, baseline 39/40 versus Jev plus fallback 118/120 across three
treatment repeats. A separate breadth comparison reports 204/240→229/240.
Thresholds were tuned on these suites; breadth tasks and run/report scripts are
not included in the stack. Jev-only results fell to 27/40 and 26/40 in the two
suites. These findings support investigating a hybrid workflow, with substantial
limits on independent reproduction and held-out generalization.

Its [selection library PR](https://github.com/browserbase/stagehand/pull/2952)
adds candidate descriptions with local context and distinguishes a forced best
candidate from a strict no-match answer. The implementation also parses
arguments, handles ambiguity, and uses ordinary code for execution checks.
This is richer than a generic lifecycle recommendation. We should not copy
its thresholds or pruning rules without evaluating candidate recall locally.

### Additions to the proposed plugin experiments

These are hypotheses and development tests, not changes to the frozen cohort:

- **Workflow placement:** compare the same bounded operation using Codex's
  ordinary decision, Jev selection plus Codex fallback, and oracle selection.
  Keep execution and verification identical. Jev-only is an optional diagnostic
  arm, never a substitute for required independent task verification.
- **Candidate sufficiency:** distinguish which available candidate fits best
  from whether any candidate can satisfy the request. Include duplicate names,
  unavailable tools, missing capabilities, and candidates whose prerequisites
  are unsatisfied. Track errors introduced by candidate pruning separately.
- **Recovery and freshness:** retain a validated decision with its state and
  catalog fingerprints, provider outcome, and observed action. Test a restart
  after assessment but before execution, and another after execution but before
  acknowledgment. An unchanged decision can be recovered; side-effect completion
  requires independent reconciliation. Changed constraints or candidates must
  invalidate advice. Do not claim exactly-once behavior without an executor
  contract supporting it.
- **Evidence of effect:** observe the selected action and its checked result.
  Separate candidate correctness, recommendation delivery, action uptake,
  postcondition success, and final task completion. Pre-tool advice arrives
  after tool selection, so selection experiments need an earlier explicit
  decision point or a helper workflow that owns the operation.
- **Timing and accounting:** include candidate construction, Jev calls, retries,
  fallback calls, execution, and verification in full operation wall time.
  Keep classifier latency separate. Pin versions and transport paths, preserve
  failures, and report independent task clusters and all scheduled attempts.

Portability does not require adopting LangGraph itself. A small typed workflow
inside the plugin can test these ideas while retaining Codex's host authority.
Arbitrary internal Codex decisions cannot be assumed interceptable through
ordinary plugin hooks. Universal decision-domain support and unlimited usage
remain compatible with these experiments. No product defaults changed and no
new live benchmark ran during this follow-up.


## Follow-up: task context, delegation, and cache costs

[Kun Chen's post](https://x.com/kunchenguid/status/2103895901140042044), read in Chrome on 26 September, argues that isolated prompts underspecify task complexity, model switching can lose cache savings, and a context-aware orchestrator should delegate substantial tasks after investigation. It quotes the already-reviewed Theo DeepSWE experiment; it is not a new controlled result. Its categorical claim that request-level routing cannot work is a hypothesis, not established by that single comparison.

A [reply by the Reflex maintainer](https://x.com/ziyacivan/status/2103914173507727573) links primary implementation notes. At [commit 4ad555624a1a19ffdf2fa937990663c7bfe0df89](https://github.com/ziyacivan/reflex-router/tree/4ad555624a1a19ffdf2fa937990663c7bfe0df89), the [README](https://github.com/ziyacivan/reflex-router/blob/4ad555624a1a19ffdf2fa937990663c7bfe0df89/README.md) and [observations](https://github.com/ziyacivan/reflex-router/blob/4ad555624a1a19ffdf2fa937990663c7bfe0df89/docs/observations.md) report:

- Three days, 27 sessions, 2,209 classified requests and roughly 384 million tokens.
- 96 downward model moves estimated to save $3.76, versus 38 upward moves adding $3.73: approximately $0.03 net.
- 73.4% of tokens came from main-chat tool-loop continuations; 18 main-chat switches were refused by a cache-cost check.
- A downward switch rewrote 63,689 context tokens. A local randomized token audit reports about 2.7 times as many Sonnet 5 output tokens as Opus 5.5, without measurable cost-per-task improvement.
- The maintainer attributes its strongest session's savings to routing new subagents from researched task briefs.

These are author-reported observations from one machine and user, with list-price estimates, uncalibrated routing thresholds and no independently reproduced quality benchmark. The estimator assumes equal token counts and omits other billing effects. Do not treat a best session, cumulative request count, or cheaper price per token as proof of task benefit.

Reflex is a gateway that can alter upstream model requests and pin subagents. Our advisory plugin does not own that boundary. Its current fixed-model cohort therefore cannot attribute a model-switching effect to Jev. The relevant comparison is whether added advice changes independently verified outcomes enough to justify its total overhead.

[OpenAI's current cache documentation](https://developers.openai.com/api/docs/guides/prompt-caching) says reuse depends on an unchanged rendered prefix; model, tool definitions and output settings can change it. The API reports cache reads and writes separately on current models. Report observed fields and actual available prices; leave absent cache-write measurements and unreconciled billing unknown. API documentation does not establish what a particular Codex trace or subscription was billed.

### Additional hypotheses, outside the frozen cohorts

1. **Context sufficiency:** compare the same decision with the latest prompt alone versus a bounded task brief containing objective, current constraints, repository observations, failed attempts and actual available candidates. Measure oracle agreement, abstention, required-evidence retention and downstream task completion separately.
2. **Decision timing:** measure advice at a task boundary, after new failures or requirements, and on unchanged tool-loop steps. Record whether advice changes an action or merely repeats it. This is an experimental trigger comparison, not a daily quota or a change to installed automation.
3. **Full operation accounting:** separate context preparation, Jev transport, host delivery, downstream model generation, tool execution and verification. Include retries, corrective turns, input/output/cache-read/cache-write tokens when observed; do not infer total savings from classifier latency.
4. **Delegation and escalation:** only in a separately authorized, capability-verified routing experiment, compare fixed strong-model execution with researched subtask assignment. Keep workers pinned for their task; count handoff overhead, missing reports, failed postconditions, corrective work and escalation. Jev cannot certify its own success.

These are prospective research questions. No existing schedule, held-out reservation, completed measurement, model default or feature-selection rule changed in response to the post.
