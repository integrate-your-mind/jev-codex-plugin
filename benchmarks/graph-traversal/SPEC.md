# Evidence-ranking experiment, October 25

Owner: root integration. Romy authorized the next useful experiment after the WC3/QQ review. The question is whether optional Jev ordering of code evidence improves completed repairs over graph-only and cheap lexical ordering, without increasing approval interruptions. This is a new cohort and source branch. Earlier benchmark cohorts remain untouched and paused. No global installation change, approval weakening, QQ core restoration, gameplay, hosted CI or public release is authorized by this experiment.

## Architecture and user journey

A coding agent investigating a real failure calls the shared `project_graph` MCP tool to search, expand and read compiler-derived TypeScript nodes. Every arm has the same tools, source cards, deterministic mandatory-dependency coverage, permissions, coding model and deadline. The arm only changes optional frontier ordering. Native traces must bind delivered packet identity and node order to a later read or expansion. Advice is optional, never a permission or task-completion gate.

The engine has a provider-neutral relevance evaluator boundary, with Jev as the concrete adapter. QQ's current generic host/MCP contracts are controlling; removed Jev config/checkpoint integrations must not be restored. Other decision models may implement the evaluator contract later, but none is invoked by this study. Jev uses independent ordinal Choice questions, combines validated probabilities in code, pins its exact model and records provider request IDs, usage and failures. Score consistency validation in the shared plugin stays strict. No product call/day/session quota is introduced.

WC3 transfers are typed fact provenance, current source revision, explicit unknowns, scoped attempts, complete intents, chosen-versus-executed trace separation, and independent effect checks. Generic proceed/reconsider judgments and universal permission hooks are excluded. Provider outage backoff may reduce redundant failed requests without limiting ordinary usage. Fallback remains the fixed cheap ranking and stays assigned to Jev in outcomes.

## Data, state and preservation

Nodes, edges, excerpts, source hashes and monotonic traces are owned by the engine. Cache keys include source revision, objective/query, candidate identity and graph state. Pagination uses a frozen frontier until source changes. Required nodes are never pruned. Source edits invalidate old IDs. Source symlinks/external imports cannot escape the project; graph/Jev state and protected credential references stay outside model-visible projects. Bounded redacted packets are the only content sent to Jev.

Plans and per-trial started/result records use immutable IDs and atomic exclusive writes. Every coding execution receives a durable Git worktree and its own branch under the private evidence worktree's `.agent-work/projects/cedar-<id>`. Its seed repository contains only the exported pre-fix source and a neutral initial commit, never solution commits or hidden graders. No source, helper, plan, result or only-copy evidence is authored under temporary OS paths. Owned disposable cache/build scratch stays under per-worktree `.agent-work` and is removed only after source/evidence preservation. Keep final artifacts, Git commits/bundles and receipts. Raw native transcripts remain private and excluded from public Git.

Native Codex and QQ use isolated config/auth references and private session stores. Preserve existing credentials, Keychain ACLs, signed installed QQ, original tmux sessions and global settings. Do not change user-selected models or reasoning settings. For matched runs request the same catalog-confirmed coding model and effort, recording actual resolution. Native model calls may start only after non-generative configuration/tool discovery and Jev component contact validation succeed.

## Corpus and controls

Reuse three genuine historical source bugs with independent behavior graders: current-catalog/context precedence, provider validation diagnostics, and credential-rotation isolation. This source corpus had no completed coding-model cohort. Freeze pre-fix/fix SHAs and prompt/fixture hashes; prove pre-fix failure and historical fix success before runs. Keep fix SHAs, patches, graders and arm names outside the coding workspace and prompt. Public history exposure is disclosed. Grader tests use fake credentials and mocked transports, never production accounts.

Graph-only uses fixed structural order. Cheap uses frozen BM25 parameters. Jev ranks the same candidate set with the same cards. Coding-model comparisons do not compare different agents or models as causal substitutes. Verify QQ generic support and exact executable source revision before admitting QQ; the old October 16 adapter and installed executable are not accepted as current automatically.

Maximum two simultaneous owned native model trials. Atomic model leases persist until termination is confirmed; per-host driver locks and exclusive trial claims prevent duplicate execution. Interrupted/started slots are retained, not silently rerun. No new trial starts after a configuration/access failure until the cause is resolved and a new cohort or explicit disposition is recorded.

## Protocol and acceptance

1. Complete focused source/contract/runner checks and historical red-green graders.
2. Validate a real Jev request using the protected existing file reference, recording the actual HTTP outcome, returned model, request ID and nullable usage. Diagnose actual failures; do not count a reserved attempt as success.
3. Validate native MCP discovery and model catalog/config without generating an answer. Perform a separate six-slot plumbing cohort (one bug, three arms, two hosts), excluded from efficacy totals.
4. Freeze the new study identity before scored outcomes. The first diagnostic block is three bugs × three arms × two hosts = 18 scheduled repairs. This block tests operational usefulness and does not establish reproducible speedup. Before a performance/adoption claim, complete five interleaved repetitions per bug/arm/host (90 total) on the frozen implementation, or label the result inconclusive with exact missing slots. Publish the schedule in advance; ordinary failures and poor outcomes are not grounds to discard or rerun slots.
5. Review actual native tool uptake, correctness and failure accounting independently, then determine whether to retain, revise or reject this optional feature. Any implementation fix during plumbing precedes a new scored freeze. Fixes after scored outcomes require a separate cohort.

Primary metrics: independently completed repairs (all required behavior checks plus successful native host termination and frozen configuration); artifact correctness and false completion separately. Supporting metrics: total elapsed time including cold indexing/setup/ranking/grading; component time; host and Jev tokens; provider IDs and unique actual fetches; nullable reported/estimated/reconciled dollars; human approval requests; repeated actions; no-use/fallback/failed/interrupted/missing trials. An increase in interruptions is a regression even if inference is cheap. Never infer billing or correctness from receipt counts, confidence or self-review.

Pair by bug, host and repetition. Three bugs remain three independent clusters per host. Retain every assigned failure and missing slot in operational accounting. Report medians/ranges and paired differences; no universal quality or speed claim from one diagnostic block or a ceiling effect.

## Failure and recovery

Missing provider access, unsupported current QQ config, actual model mismatch, inability to isolate credentials, unconfirmed process cleanup or altered grader assets are concrete configuration failures. Preserve their literal receipts. Continue authorized independent work, but never substitute a fallback-only run for a Jev comparison. A local compile, package, fake-provider test, model turn, completed artifact and independently accepted useful fix are distinct states. Unknown cost stays null. A provider account limitation is not a plugin-imposed quota.

The experiment source is preserved on the plugin feature branch. Private prompts/transcripts, trial repositories, artifacts and reports are preserved in the private WC3 evidence repository, with a manifest separating source identity, provider execution, grading, review and publication. The existing branch-protection baseline remains enforced; no merge/deploy/public release is part of this experiment.
