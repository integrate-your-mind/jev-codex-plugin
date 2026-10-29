# Jev Workflows routing repair and value pilot

Status: approved implementation specification, 2026-10-28. Integration owner: root. Baseline public source: `958eb5083ae73087db92488247f6d981839c852b`, version 0.5.3.

This specification supersedes earlier proposals for SQLite, a coding-model gateway, and automatic two-arm confirmation. Approval covers the repairs, offline Claude adapter, bounded native desktop qualification, and exactly eighteen pilot attempts if desktop isolation and graders qualify. It does not authorize a stable release, confirmation study, adaptive coding experiment, Claude inference, QQ changes, new coding-model API billing or automatic recharge. Preserve existing sessions, credentials, receipts and previous benchmark cohorts.

## User journey and interfaces

An opted-in user receives fresh evidence/tool advice at meaningful task changes. The ordinary coding agent chooses and executes tools under its existing permissions. Where a host actually supports it, a thin adapter may apply a jointly eligible model-effort profile before the next request. Advice, delivery, host acknowledgment, actual execution and independent task outcome remain separate states. Unsupported capabilities are reported, never simulated through another runtime.

Keep the eight public tools and plugin identities. Add optional versioned linkage/coverage fields without changing old meanings. New records describe host capabilities, catalog generations, task revisions, decision proposals, delivery, application, execution and outcome. Host/provider/model identifiers are extensible. Eligibility, pins, permission and provider-origin checks remain deterministic. No general tool executor or arbitrary app-server relay is exposed.

Maintain every page supplied by supported discovery and explicit inaccessible categories. Keep complete local inventory distinct from shortlist recall. Remove first-twelve truncation; packet limits are actual transport constraints, not product catalog or daily usage limits. A model and one supported effort are a single eligible profile.

## State, privacy and recovery

Reuse TypeScript service/provider validation and immutable receipt files. No database or always-running companion is required. Scope new `routing-v1` files to host/account/workspace/session/agent. Publish immutable observations before revisioned pointers and use the existing ownership-safe lock protocol. Reproduce the task-context replacement-owner race before fixing it. Never rewrite historical receipts into successful execution proof.

Preserve provenance, current objective/subtask, source/evidence versions, observed failures, pending tool cycle and explicit unknowns. Cache semantic identity separately from delivery IDs. Changed facts, pins, provider identity or catalogs invalidate advice. Late results cannot affect a new revision. Automatic consultation has a five-second deadline, duplicate suppression and provider-aware outage recovery; failures retain the authorized workflow without new approval loops.

New derived facts expire after seven days and minimal routing metadata after ninety days. Pinned and retained study/release evidence and their dependencies do not expire automatically. No raw transcript collection by default. Keep credentials out of catalogs, provider context and exports. Preserve existing state and configuration through additive upgrades, consistent backup and rollback.

Add `changed_state` and `always` modes. Fresh automation remains disabled with changed-state consultation selected. Preserve existing enabled state, scopes and null/unlimited caps. Legacy configuration retains its effective behavior until explicitly migrated. The approved local upgrade selects changed-state mode; this grants no new tool or provider authority.

## Host boundaries

Codex qualification must identify the actual desktop-owned runtime and supported connection, effective switching capability and an ordered pre-dispatch or atomic precondition. Preserve authentication/managed overrides. No private IPC, app patching, separate CLI substitution or gateway. Failed qualification records automatic model routing as undelivered. Native adaptive coding checks are outside the eighteen fixed-profile attempts and await later approval.

Preserve current profile on uncertainty/ties. Never reverse on unchanged evidence. Downshift only at a completed subtask with no pending tool cycle. Pins and changed policy take precedence. Requested settings do not establish actual inference.

Claude uses trusted ordinary PostToolBatch command hooks as the sole decision producer. They publish an immutable record and model-visible additional context. A native adapter uses documented filesystem reads and causal tool-call ID joins for the immediately preceding complete batch/session/agent/turn/index. First requests, reloads, stale or ambiguous joins preserve incoming model/effort. No direct promptless MCP workaround or security-guard removal. Exactly one streamed dispatch. Offline acceptance only until the live hold is lifted.

## Fixed-profile pilot

Six real bugs across at least two repositories and task types, disjoint from old reservations. Freeze task source, public failure record, candidate manifest, coding model/effort, permissions, graders, package hashes and policy before starting. Rankers see no hidden tests/reference repair/future commits. A genuine public failing-test record on each broken base is common to all arms.

1. Coding model alone, with no Jev tools, hooks, guidance, candidate packet or transport.
2. Cheap deterministic BM25 retrieval in relevance order.
3. Same candidates/content/format with one Jev Choice selecting the first evidence target; remaining candidates retain cheap order. Abstention/error retains cheap order.

Use the retained BM25 parameters `k1=1.2`, `b=0.75`, stable ID tie-breaking. Bound the experimental packet to 16 KiB and actual provider option limits, including the none option. Keep full inventory and omitted coverage. Ranking packets differ only in order. Disable unrelated consultations in both packet arms. Retrieval/Jev latency counts in the task clock. Freeze exact decision-model version and prompt; do not use a moving alias.

Exactly six bugs times three arms, eighteen attempts, one per arm-order permutation. Initial real-bug integration attempts consume their slots. No hidden coding preflight, retries or replacements. Baseline exposure isolation must be proven in the actual desktop, not a CLI. If isolation or treatment identity breaks, stop scoring and preserve partial evidence. An unavailable native model actuator does not block this fixed-profile experiment.

Coding ends by minute 35, including startup and human waits; independently grade the retained terminal patch by minute 45. Preflight must establish verification fits ten minutes, broken base fails, reference repair passes, and absent/wrong patches fail. Preserve all assigned failures, timeouts, abstentions, outages and ignored advice. Infrastructure-invalid results remain distinct with denominator bounds. Up to 13.5 measured task-hours; noncoding preparation and cleanup are separate.

Produce observed verified-fix step curves versus common task-time allowance, with baseline/plugin and cheap comparator. Report paired outcomes, total elapsed time, approvals, repeated failed public verification cycles, advice delivery/uptake and honest cost coverage. Full time per fix includes all assigned attempt time divided by verified fixes; zero fixes cannot win efficiency. Subscription capacity is not billed dollars.

Exploratory screen: valid measurement, observed delivery/uptake, no increased approval burden, and either one net additional fix versus cheap without net baseline loss, or 20% lower full time per fix versus both without observed fix loss. Six bugs do not prove general effectiveness. Always return charts for human review. Do not start sixty confirmation attempts automatically. A tool-ranking result does not establish model-routing value.

## Verification and delivery

Regression priorities: candidate truncation likelihood 10, impact 8, product 80; task-context lock likelihood provisionally 5, impact 8, product 40, frequency unmeasured. Require red regressions before fixes. Rate additional bugs on the same scale and leave code alone below product five, without waiving explicit requirements or data/security/billing obligations.

Verify pagination/later candidates, freshness, concurrency, deadlines, pins, interrupted publication, package parity and backward compatibility. Use existing local CI, current-head independent review and small checkpoints. Public source and sanitized evidence can be published; private traces stay private. Stable promotion awaits pilot review. Official directory acceptance is separate from public source/manual packages.

## Implementation ownership checkpoint

- Blocking first steps: approved spec/source checkpoint; reproduce defects; qualify native baseline and grader before any coding attempt.
- Independent workstreams: lock/state, consultation/catalog, offline Claude adapter, desktop/pilot support; one owner and durable branch per writer.
- Shared mutable state: root alone integrates public contracts, server wiring, generated distribution bundles and the final feature map. Workers preserve other edits and coordinate new interfaces.
- Smallest safe decomposition: independently testable modules and normal merges into one integration branch. Root serializes remote preservation and final CI, never bypassing checks.
