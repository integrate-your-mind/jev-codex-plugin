# Research-to-test record

Follow-up: [26 September X and primary-source research](x-research-2026-09-26.md)
reviews Polylane, context reranking, judge studies, public decision benchmarks,
and proposed disjoint experiments. External results do not establish plugin
task-quality improvement or modify the frozen studies below.

On 2026-09-26, GPT-6 Pro was selected in Chrome and a Deep Research review was
requested against public plugin revision
`7dfe432d7463bab7186a8dacf50924af282f9a20`. The completed report supplied 31
questions with hypotheses, metrics, experiments, failure thresholds, and
confounds. The extracted matrix is [research-questions.json](research-questions.json).
The research service does not expose its internal model identity; the selected
ChatGPT model and completed research workflow are distinct observed facts.

This report is a source of hypotheses, not an independent benchmark oracle.
Its implementation claims were checked against the pinned source and reproduced
with synthetic inputs. Proposed numerical thresholds are product decisions to
freeze before an experiment, not measured results or guarantees of statistical
power. No DeepSWE reference solution was used in this review.

## What the existing evidence establishes

The [completed synthetic pilot](../results/2026-09-26-paired-v1/README.md) found
8/8 artifact passes in each arm and an 18.7% median paired increase in summed
turn time with the plugin. Four task families with two repetitions are four
task clusters, not eight independent engineering tasks. This establishes no
task-quality lift and cannot rule out benefits on harder or different tasks.

All 100 hook-attributed calls used the generic lifecycle catalog. Twenty-six
marked context truncation and ten marked evidence truncation. Seven explicit
MCP calls could not be linked individually to provider receipts. These omissions
limit analysis of which recommendation affected an action.

The research review correctly challenged a cache explanation: uncached input
was 143,274 tokens in control and 141,872 in treatment. Total input increased,
but these aggregates do not demonstrate prompt-cache damage. Provider wait,
hook execution, changed trajectories, and local cache effects must be measured
separately.

## Confirmed integration defects at the pinned revision

1. `decision-hook.ts` accepts concrete candidate catalogs, but its output and
   compact receipt allow only generic lifecycle choices. A mocked selection of
   `read_thread` at confidence 0.97 produced an assessed advisory with no
   `decision=` field. Codex therefore never received that recommendation.
2. Concrete candidate catalogs retain a question asking whether to proceed,
   reconsider, or gather evidence. The question and legal answer meanings can
   disagree.
3. A schema-valid saved task context with nine bounded constraints generated
   15,530 bytes in the `task.prompt` evidence field. The real decision service
   rejected the request as `invalid_input` before the mocked provider was called.
   Outer context compaction did not bound that separate evidence field.

The source audit also identified persistent root objectives/catalogs and late
hook timing as hypotheses requiring tests. Native lifecycle events generally
do not supply the complete tool/model/skill catalog. Testing with a supplied
catalog measures that explicit path; it does not prove automatic discovery.
Pre-tool advice cannot rewrite a call that has already been selected, and a
Stop message cannot force another turn.

## Primary guidance checked

TypeSafe describes Jev as a typed decision component rather than a coding model.
That supports evaluating narrow choices and evidence judgments separately from
finished-code quality. [Coding-agent guidance](https://docs.typesafe.ai/introduction/coding-agents).

Its Jev 1.13 guidance recommends relevant state, direct questions, consistent
criteria, and code for exact arithmetic. Duplicated context and mismatched
candidate questions conflict with those recommendations.
[Jev 1.13 limitations](https://docs.typesafe.ai/model-jaggedness/jev-1.13).

The fan-out pattern batches independent questions and lets application code
decide which answers apply. Automatic hooks currently use one broad Choice;
the existing batch MCP feature should be tested as a distinct feature.
[Fan-out guidance](https://docs.typesafe.ai/patterns/fan-out).

TypeSafe's skill-selection example includes ordinary-agent, suggestion, and
oracle-advice arms, plus no-fit negatives and first-action scoring. Its published
model pair is Jev 1.12 and Claude Haiku 4.5; those numbers are not evidence for
this Codex plugin. The control design is useful for future feature experiments.
[Skill-selection experiment](https://docs.typesafe.ai/cookbooks/skill_suggestion).

The plugin retains the documented `hooks/hooks.json` structure. Manifest
validation, native hook loading, provider transport, advice delivery, and task
success remain separate checks; an older local validator cannot establish all
of them.

## How the questions drive the experiments

| Questions | Measurement path | Evidence boundary |
| --- | --- | --- |
| Q04, Q06, Q11–14, Q28–29 | Deterministic hook/service fixtures, including large valid state and concrete candidates | Tests adapter semantics only; mocked provider results are not model accuracy |
| Q05–07, Q13–15, Q20, Q24, Q26, Q31 | Live Jev evaluation with frozen authored inputs, separate labels, original/repaired source hashes, and delivered-choice measurement | Decision-level diagnostic; does not measure final Codex artifacts |
| Q01, Q08, Q16–19, Q22–27, Q30 | Frozen DeepSWE comparison with independent verifier and native event traces | Task quality remains unmeasured until the real paired runs complete |
| Q02–03, Q09–10 | Placebo/shuffled advice, selective timing, and atomic batch ablations on a disjoint development suite | Proposed follow-up studies; no claimed result |
| Q21 | Provider failure reason and response-validation accounting | Availability and schema reliability only |

Q26 requires care: an agent ending before a hidden verifier fails is an
unsuccessful completion, not automatically a false statement. Count explicit
unsupported claims separately from that broader proxy. Likewise, a subsequent
action matching advice is observable compatibility, not proof of causation.

The recommended sequence is to preserve current behavior, repair independently
reproduced integration bugs in a separate snapshot, test the information path,
then measure independent task outcomes. A repaired renderer alone is not proof
that users finish more tasks. Defaults should not be broadened on the strength
of receipts, confidence values, or generated research recommendations.
