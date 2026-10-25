# Jev project graph study

This is a new isolated prototype and study authorized October 16. Earlier Jev on/off benchmark cohorts and their native goal remain paused. Claude is excluded. The production plugin and signed QQ installation are preserved.

[Engineering specification](./SPEC.md) defines the matching, blinding, corpus, outcome checks, accounting and cleanup contracts. [Independent review](./REVIEW.md) records source acceptance and outstanding native evidence. The shared engine and experimental Codex package live in `../../prototypes/project-graph`; both native hosts load its same stdio MCP server.

## Reproduce

From the repository root, after the graph engine is built:

```sh
node --test benchmarks/graph-traversal/bugs.test.mjs benchmarks/graph-traversal/runner.test.mjs benchmarks/graph-traversal/adapters/codex-adapter.test.mjs benchmarks/graph-traversal/adapters/qq.test.mjs
node benchmarks/graph-traversal/runner.mjs freeze --phase plumbing --out /absolute/new/plumbing
node benchmarks/graph-traversal/runner.mjs run --out /absolute/new/plumbing --host codex --stop-on-invalid true
node benchmarks/graph-traversal/runner.mjs run --out /absolute/new/plumbing --host qq --stop-on-invalid true
node benchmarks/graph-traversal/runner.mjs summarize --out /absolute/new/plumbing
```

Use a fresh output directory for each frozen cohort. `JEV_API_KEY_FILE` must point to the existing protected credential file. Its content is never copied into a candidate workspace or command environment. Live provider execution is part of `run`; freeze, unit tests and native MCP discovery do not start coding-model turns.

The development cohort defaults to three genuine historical bugs, three arms, two hosts and five repetitions (90 scheduled slots). It may start only after native plumbing proves usable tools, actual model/effort resolution, real Jev ranking, untouched controls and confirmed cleanup. Run the two host drivers concurrently if desired; the study enforces two global model slots and rejects overlapping drivers for one host. Started slots are never silently rerun. A stale lock requires checking its actual owned processes and retaining the original result disposition.

Completion requires a correct artifact, successful native host termination and valid frozen configuration. Native output, artifacts, independent grader checks, graph packet delivery/read traces and provider receipts are retained separately. Missing cost stays null. Jev input list-price estimates are distinct from model subscription charges and reconciled billing. Three bugs remain three independent task clusters per host.

Current private evidence belongs under `/Users/romanmondello/Developer/startup/.qq-dev/verification/jev-graph-study-20261016`. This prototype is local experimental work, not a published plugin release or an improvement claim.
