# Theo's benchmark: primary-source record

Inspected directly on X and YouTube on 2026-09-26. These are Theo's reported results, not our independently rerun results.

## The X chart

[Theo's benchmark post and chart](https://x.com/theo/status/2103774771788108008) describe **20 DeepSWE tasks, one attempt per task, using the public leaderboard's harness**. Cost is what OpenRouter billed per task; time is mean agent working time per task.

| Reported condition | Passed | Billed USD/task | Mean working minutes/task |
| --- | ---: | ---: | ---: |
| Jev Router | 16/20 | 1.50 | 19.9 |
| GPT-6 Astra low | 16/20 | 1.46 | 4.6 |
| GPT-6 Astra xhigh | 17/20 | 4.42 | 12.8 |

The displayed 19.9/4.6 runtime ratio is about **4.33**. The chart supports a slower router at the same observed pass rate as the low-effort condition. It does not measure this fixed-model Codex advisory plugin. His [follow-up](https://x.com/theo/status/2103775863343026253) also distinguishes the routing criticism from Jev's other uses.

We did not find the exact 20 task IDs, selection seed, immutable harness/dataset revisions, per-task trajectories, provider route distribution, or complete timeout/retry settings in the inspected posts and video. Our published 20-task lock therefore creates **a new deterministic DeepSWE sample**, not an exact replication of his task subset. Do not combine our synthetic pilot with his chart as if they used the same task set, model settings, provider, or timing boundary.

## The linked video, extracted and reviewed

[Jev is incredible](https://www.youtube.com/watch?v=F3YXg7AaKWE), Theo — t3.gg, duration 30:29. YouTube displayed September 20, 2026. The [originating X post](https://x.com/theo/status/2101857305570721847) links this video. We extracted and read its automatically generated English captions; a private copy is retained with SHA-256 `d5387939f0f995255c979593c91590aa5f05162f3e3b5f1066bcb9ecf1729c27`. The full copyrighted transcript is not redistributed.

The video predates the September 26 DeepSWE chart. It explains his reasoning, rather than documenting that later run. Relevant sections, paraphrased:

- [12:40](https://www.youtube.com/watch?v=F3YXg7AaKWE&t=760s): judging implementations requires enough context and reasoning.
- [15:14](https://www.youtube.com/watch?v=F3YXg7AaKWE&t=914s): unpublished workflow evaluations and model-generated reference labels limit auditability.
- [22:22](https://www.youtube.com/watch?v=F3YXg7AaKWE&t=1342s): a narrow classifier should not automatically substitute for broad judging.
- [23:40](https://www.youtube.com/watch?v=F3YXg7AaKWE&t=1420s): compaction needs to preserve relevant tool results and state.
- [25:00](https://www.youtube.com/watch?v=F3YXg7AaKWE&t=1500s): changing history can invalidate cached prompt prefixes.
- [26:49](https://www.youtube.com/watch?v=F3YXg7AaKWE&t=1609s): classifying chat history is a concrete constrained use case.

Caption transcription can be imperfect; disputed wording should be checked against the linked audio. No dollar-pricing claim is taken from ambiguous captions.

## What this changes in our evaluation

1. Publish the task list, source revisions, grader, trial plan, failures, and generated artifacts. Freeze inputs before inference.
2. Grade executable behavior in a separate verifier. Neither Jev nor the tested agent is the success oracle.
3. Report latency, cached and uncached input, output, actual billed cost when available, and quality separately. Unknown cost stays null.
4. Test fixed-model advisory calls separately from model routing. A comparison of different agents is a whole-system comparison, not an isolated plugin effect.
5. Test changed requirements and relevant tool-result propagation. Successful task completion alone does not prove that advice was refreshed or caused the success.
6. Follow a small wiring smoke with real repository tasks; do not tune on final evaluation outcomes or omit negative results.

TypeSafe's [coding-agent guidance](https://docs.typesafe.ai/introduction/coding-agents), [fan-out pattern](https://docs.typesafe.ai/patterns/fan-out), and [Jev 1.13 limitations](https://docs.typesafe.ai/model-jaggedness/jev-1.13) motivate bounded decisions, shared context, and batching independent questions. These are hypotheses to test, not evidence that calling Jev at every event improves an agent.
