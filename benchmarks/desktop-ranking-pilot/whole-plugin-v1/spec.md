# Whole-plugin desktop pilot amendment

Approved execution scope, October 28, 2026. Root owns native execution, configuration, private environments/events and integration. This owner supplies the new controller and reports. The earlier ranking protocol and its records remain unchanged.

The question is whether the whole plugin helps the fixed coding model finish real bugs. The three arms are `plugin-off`, `cheap`, and `plugin-on`. Plugin-off has no Jev exposure. Cheap has the same disabled plugin plus deterministic BM25 evidence. Plugin-on uses the installed plugin normally in `changed_state` mode, including multiple consultations, abstentions and ordinary service outages. Plugin-on is not restricted to one ranking call. Ambient advice outside the assigned coding chat is outside this cohort.

## Frozen study and native evidence

The manifest schema is `whole-plugin-pilot-v1`. It contains `studyId`, `privacy: "private"`, six task records, the retained corpus/reservations, current grader preflights, `preflightHash`, `host`, `arms`, and `policy`. Tasks pin `id`, repository, base revision, input/public-failure/grader/reference hashes and the cheap packet hash. The six task IDs and balanced arm permutations are the existing six-bug schedule, mapped to the new arm names. There are exactly eighteen single-use slots.

`host` contains `kind: "codex-desktop"`, `model: "gpt-6.1-sol"`, `effort: "ultra"`, `appVersion` and `backendVersion`, each version nullable, and a settings evidence hash. Native chat/workspace/model-setting/exposure observations are sufficient. No private IPC, pre-dispatch callback, actuator, hidden backend version, gateway or separate coding CLI is required. Root retains actual private evidence and records hashes. Unknown versions remain null.

Each `start` event occurs before native startup, retrieval or waits and retains a pre-launch evidence hash. After native creation, `identity` binds the fresh `chatId`, `workspaceId`, actual model/effort, base revision, actual exposure profile and evidence hash. Exposure pins enabled state, consultation mode, visible Jev tools/hooks/guidance and configuration/package hashes. Plugin-off and cheap require disabled exposure; plugin-on requires enabled changed-state exposure. A changed profile, base, chat reuse or exposure breach stops scoring and retains evidence. Normal plugin outages do not invalidate a trial. A failed startup consumes its assigned slot through `integration_failed`; it is never retried or replaced.

## Event contract

Every event has unique `id`, ISO `at`, `manifestHash`, `type`, and a slot ID, except the global `interim_report`. Slot IDs are `<task-id>.<arm>`. Events are immutable numbered JSON files and replay through a pure reducer. Root is the single writer. No raw transcripts or secrets enter controller events.

| Type | Additional fields |
| --- | --- |
| `start` | `evidenceHash` retained before native startup |
| `identity` | `chatId`, `workspaceId`, `model`, `effort`, `baseRevision`, `exposure`, `evidenceHash` |
| `retrieval` | `packetHash`, `evidenceHash` |
| `retrieval_unavailable` | `reason` unavailable/error/missing, `evidenceHash`; preserves the assigned attempt and missing delivery |
| `consultation` | `consultationId`, `status` assessed/abstained/unavailable/error, `providerInvoked` boolean or null, `delivered` boolean, `receiptHash` nullable, `evidenceHash` |
| `uptake` | `consultationId`, `value` observed/ignored/unknown, `evidenceHash` |
| `approval` | `evidenceHash` |
| `public_verification_failed` | `evidenceHash` |
| `coding_ended` | `patchHash`, `reason` completed/timeout/failed/outage, `evidenceHash` |
| `graded` | `patchHash`, `graderHash`, `verdict` verified-fix/not-fixed/infrastructure-invalid, `healthy`, `evidenceHash` |
| `billing` | `codingUsd`, `jevUsd`, `complete`, `subscriptionCapacity`, `evidenceHash`; missing dollars/capacity are null |
| `usage` | `inputTokens`, `outputTokens`, `cachedInputTokens`, `evidenceHash`; one observed per-attempt total, unknown counts null |
| `integration_failed` | `reason`, `evidenceHash`; consumes an assigned startup failure |
| `identity_broken` | `reason`, `evidenceHash` |
| `tick` | No additional fields; records observed elapsed support |
| `interim_report` | `reportHash`, `artifactsHash`, `evidenceHash`; no slot ID |

Root records all consultation outcomes and uptake separately. Consultation IDs cannot repeat across slots. Off/cheap consultations are an exposure breach. Missing delivery never implies uptake. Packet absence or plugin outage never removes an assigned unsuccessful result or independently verified fix.

## Clocks, state and recovery

Coding ends within 35 minutes of start, including startup, retrieval, approvals and human waits. Grade the retained terminal patch within ten more minutes and by minute 45. The controller returns absolute deadlines and invalidates late observations; root owns actually stopping native work. Completed, pending, coding failure, timeout and infrastructure-invalid records remain distinct. There are no retries, replacements or extra coding preflights.

The first three attempts consume their actual slots. After their terminal grades, root generates and records the interim chart artifacts before starting slot four, then continues the other fifteen. The controller never starts native execution. It stores manifest plus immutable events in the authorized private run directory. An interrupted append is replayed and reconciled before another write. Existing source, receipts and task environments remain preserved. No database, schema migration or account change is needed. Git checkpoints preserve public source and sanitized exports; root preserves private evidence separately.

## Reports and acceptance

The report returns JSON, CSV and SVG/PNG plots for observed verified fixes, cumulative all-assigned elapsed time versus observed verified fixes, paired task outcomes, measured cost, approvals and uptake. Every assigned attempt contributes elapsed time, including failures and outages. Pending and invalid outcomes remain unknown, with denominator and fix bounds. Bar denominators show actual completed source-valid observations rather than silently using six. No scored observations means no performance curve. Partial curves end at observed terminal support; pending elapsed remains explicit. Unknown billing stays null, subscription capacity is separate, and zero verified fixes cannot win time-per-fix.

The report is descriptive. It does not infer benefit from connections, advice counts or synthetic fixtures, and it does not launch another study. Real results are supplied only by root's native executions and independent grader receipts. Tests use clearly synthetic events and check normal, failure, outage, exposure-break, deadline, pending and recovery behavior.

## Throughput checkpoint

- Blocking first steps. Freeze this amendment and the event interface, then validate current source/grader/task pins and native exposure evidence before each attempt.
- Independent workstreams. This owner writes the public reducer/CLI/report data. A disjoint plotting worker may render the agreed report format. Owner two prepares private environments. Root owns configuration and actual native runs.
- Shared mutable state. One writer owns each branch and private run. Root serializes public integration, pushes and native event publication.
- Smallest safe decomposition. First publish controller/event shapes, then reports/plots, then focused synthetic verification. Root and the independent reviewer own observed outcomes and acceptance.
