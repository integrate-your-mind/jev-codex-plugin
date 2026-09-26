# Development selection and held-out follow-up

Status: selection rule recorded before new component experiments. No improved
configuration has been selected and no held-out inference has started.

This supplements, and does not replace, [the current-plugin protocol](protocol.md).
The existing 40 scheduled DeepSWE trials retain their original treatment. The
four-task pilot, 16 authored fixture tests, and 72-call decision study were already
observed when this document was written. They are development evidence, not a
prospective test of this selection rule. In particular, the 72-call repair bundles
candidate delivery and context changes; its token reduction cannot be assigned
to either component without an ablation.

## Units and boundaries

Use new authored development cases unrelated to the contents of DeepSWE tasks.
Keep input fixtures separate from expected outcomes and verifier code. Provider
requests receive only input state, questions, and available candidate descriptions.
Independent tests, not Jev's confidence or the agent's completion claim, determine
whether the resulting action satisfies the case. Retain every scheduled attempt,
including unavailable responses, abstentions, timeouts, and interrupted attempts.

Use six development strata: concrete candidates/no-fit; independent shared-state
batching; changed requirements; restart recovery; context selection; and action
outcome verification. Each stratum must include normal behavior, conflicting or
insufficient evidence, a stale or invalid input, and an adversarial boundary case.
Freeze each stratum's fixtures, oracle, source variants, order, provider version,
and repetition count before its first live request. Repetitions are nested within
cases and never counted as additional independent tasks. Tests of adapter behavior
may use deterministic transport fixtures, but must be labeled as such.

Use the same number of cases in each stratum. A case passes only when every frozen
required postcondition passes. A harmful case applies a prohibited, unavailable,
stale, or duplicate action, discloses protected data, or declares success without
required evidence. A wrong but harmless choice is incorrect. Abstention is correct
only when the oracle explicitly permits it; otherwise it is an unresolved outcome.
An interrupted or unverified action is unknown, not a pass. A candidate must have
at least as many verified passing cases and no more harmful cases than control
in **each** stratum; gains in an easier stratum cannot cancel another's regression.
Any unresolved scheduled candidate case makes that candidate ineligible for
selection until its evidence is resolved, without rerunning a started attempt.
Missing control evidence prevents a comparative improvement claim for that case.

Keep these layers separate in results:

1. A request was attempted and received a valid provider response.
2. The returned choice was appropriate for the supplied state.
3. The choice was delivered to the host and referred to an available candidate.
4. An action was actually taken and its postcondition was independently verified.

Native plugin tests must additionally establish that the real host exposes the
necessary event/state/catalog. Supplying a catalog in an authored event does not
prove automatic discovery in Codex. An MCP operation that requires an explicit
caller is reported as explicit, even if its unit tests pass. A PreToolUse advisory
is not evidence that the plugin intercepted or replaced Codex's earlier selection.

## Comparisons fixed before execution

| Component | Control | Candidate | Independent check |
| --- | --- | --- | --- |
| Candidate delivery | Released hook output | Exact validated available candidate propagated | Received ID matches catalog; foreign/unavailable/reserved IDs rejected |
| Question alignment | Released generic question with concrete catalog | Question explicitly asks about that catalog | Correct or appropriate no-fit outcome from frozen case oracle |
| Context projection | Released serialized state | Deduplicated bounded state preserving current constraints | Required facts retained; superseded instructions excluded; correct action |
| Batch | The same typed questions sent separately over the same state | One request with independent typed questions | Per-question results and verifier outcomes; all response/usage denominators |
| Freshness | Previously captured advice at a changed task checkpoint | A fresh request using changed state/catalog | Old choice is not applied as current; new action meets current constraints |
| Restart | Uninterrupted decision/action sequence | Process restart at fixed interruption points | No stale reuse, missing outcome promoted to success, or duplicate action |
| Context selection | All available bounded evidence | Explicit selected subset with a no-fit/fallback path | Necessary new evidence retained; result checked independently |
| Outcome verification | Caller reports completion | Caller report linked to actual action and independent postcondition | Unsupported completion remains unknown or fails; no self-grading |

Serial batch controls use one `evaluateDecisions` request per question, preserving
IDs, state, policies, and typed question contents. `classifyDecision` is not an
equivalent serial control because it changes the rubric and payload. Use isolated
service/cache state. Define an explicit caller-owned `no_fit` candidate where all
available actions are demonstrably unsuitable; the built-in `insufficient_evidence`
answer is a different outcome. Never interpret either as permission to act.

The current plugin stores task context and caller-reported outcomes but does not
execute actions, retrieve selected evidence, verify postconditions, or guarantee
recoverable exactly-once execution. Those functions belong to the experimental
harness unless a separately tested plugin implementation is introduced. Label
their results accordingly. A harness-only improvement is not eligible to be
advertised as an automatic native plugin feature.

Freshness and restart cases share one underlying state-machine design but are
reported separately. A persisted Jev receipt alone does not provide exactly-once
actions. Test restart before send, after send before response persistence, after
response persistence before action, and after action before acknowledgement.
Uncertain transport completion stays uncertain; do not invent a successful-call
count or replay an external effect merely to make accounting look complete.

Implement and measure one component change at a time. If separating a bundled
repair is not feasible without changing another component, report the bundle and
leave the individual causal effect unknown. Do not copy another project's
confidence thresholds, candidate pruning limits, or favorable in-sample cutoff.
Use the current policy thresholds until a separately frozen calibration experiment
supports changing them. Batch answers cannot become inputs to other questions in
the same provider request.

## Eligibility and deterministic selection

The following gates apply to every candidate configuration:

- All applicable source, packaging, native-host, and boundary checks pass.
- No new foreign/unavailable action, stale decision applied after a changed
  requirement, duplicate action, secret disclosure, or unsupported success claim
  occurs in the deterministic boundary cases.
- Attempt, response, receipt, and outcome accounting reconciles, with missing
  billing or response evidence explicitly unknown.
- The behavior can run through the tested Codex plugin surface. Unsupported
  interception or model-switching behavior is ineligible. Retain a native-host
  trace showing the actual event/state/catalog source, hook or explicit MCP
  receipt, delivered candidate, resulting action, and independent postcondition.
  An explicit MCP workflow may qualify only as an explicit workflow; a fabricated
  hook event cannot establish automatic availability in the host.

A delivery or validity bug fix that passes these gates may be retained as a
correctness repair without claiming Jev improves task completion. Optional
features must additionally have no new harmful outcomes on the development cases
and satisfy at least one of these descriptive selection conditions:

1. More distinct cases have independently verified correct actions than control.
2. The same distinct cases pass, while total provider input tokens fall by at
   least 10%, or median paired complete-operation wall time falls by at least 10%.

The 10% threshold is a practical development criterion fixed here, not a claim of
statistical significance. Include setup, request, retry, persistence, and fallback
time in the complete operation. Report classifier latency separately. Serial vs
batch cost uses totals over the same questions, never per-request averages that
hide different question counts. Measure transport failures as observed outcomes;
do not select a configuration using successful requests alone.

Select a single combined configuration from eligible components. Order candidates
lexicographically by: fewer harmful cases; more independently verified passing
cases; fewer total provider input tokens; lower median paired operation time;
fewer enabled optional components; then a stable configuration ID. All comparisons
use the full frozen case set and include null/unknown results explicitly. A missing
measurement cannot win its tie-breaker. If none qualifies, select only eligible
correctness repairs, or the unchanged plugin if no repair qualifies, and disclose
that no optional improvement was supported. Freeze the resulting content hashes
and exact behavior before seeing follow-up task outcomes.

## Disjoint task evaluation

Reserve 20 different task IDs from the 113-task DeepSWE revision
`0b9fabbb63b9104d678fe965e1632f2dd9eaa2ea`, using
[`../cross-agent/deepswe-v1.1.lock.json`](../cross-agent/deepswe-v1.1.lock.json)
as the original exclusion lock. Record that lock's SHA-256 in the held-out artifact.
Exclude every task in the original 20-task lock and any other task whose problem,
reference solution, or verifier was inspected during development. Sort remaining
IDs by SHA-256 of `jev-plugin-heldout-v1` concatenated with the task ID, with task
ID as a tie-breaker; take the first 20. Publish exclusions and their reasons.
Select from catalog metadata only, without opening task instructions or solutions.
Freeze IDs, task configuration hashes, runtime/image identities, selected plugin
content hashes, and a 40-row counterbalanced schedule before inference.

Run one attempt per arm: Codex alone versus the selected configuration. Retain the
same Codex version, model, effort, task/verifier boundaries, metrics, missing-data
rules, and analysis as the original study. Do not pool development and held-out
outcomes. If required runtime conditions change, disclose the deviation and name
the new cohort before launching it. A failure to demonstrate improvement, harmful
advice, or overhead without quality benefit remains a publishable result.

For task-level analysis, a valid pair has independent verifier outcomes for both
arms under their frozen runtime conditions. One-arm infrastructure failures and
missing verification leave the pair unresolved. They count as not operationally
successful in the all-scheduled denominator and as unknown in task-quality
sensitivity bounds (unknown arms can pass or fail). Do not convert a missing
verifier result to a proven code failure or drop it from the reported denominator.

Neither the development experiment nor its selection process adds a product
quota, changes installed defaults, makes Jev an authority, or proves marketplace
acceptance.
