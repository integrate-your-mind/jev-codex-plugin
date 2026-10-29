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
| `native_launch_prepared` | `preparationHash`, `stateHash`, `evidenceHash`; one validated preparation after persisted start and before native identity |
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
| `recovery_untracked_launch` | `chatId`, `createdAt`, `completedAt`, `prelaunchStartedAt: null`, `evidenceHash`; consumes the next untouched slot and permanently halts scoring |
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

## Native launch preparation and incident recovery

A directly reproduced orchestration bug scored likelihood 10 × impact 8 = 80. A failed prerequisite was ignored, and missing-file stderr was passed to native chat creation as the coding prompt. The reusable correction is a narrow launch-data validator and CLI. They prepare native create arguments without executing tools, creating chats or opening a general host tunnel.

An immutable private launch contract joins the existing manifest hash and all eighteen slot IDs to their trusted project IDs, absolute workspace paths, base/configuration hashes and expected prompt-template hashes. It pins the common coding prompt independently. The preparation request supplies explicit command-success receipts, common/template files and observed native project settings. The CLI reads the common/template files itself. It never takes command stdout or stderr as prompt content. Missing files, nonzero exits, an incorrect grade receipt schema, mismatched hashes/settings, occupied slots or a changed study produce no native arguments. Preparation requires the actual slot's persisted `start` event before returning arguments. Publication uses an exclusive file, readback and a state digest; a failed or uncertain publication must be reconciled rather than retried under another name.

The launch contract is frozen before any attempt. Three named prerequisites are required: `prompt-preparation`, `workspace-validation`, and `prior-outcomes`. Each command receipt requires literal `exitCode: 0`, `signal: null` and a decoded artifact with its canonical hash. Grade artifacts are validated through `studyVerdict` and `terminal.verdict`/`terminal.healthy`, joined to the preceding retained patch and frozen grader. A normal not-fixed grade may carry its grading process exit code 1; the prerequisite that reads and validates that receipt must still complete successfully. No generic `verdict` fallback exists. Frozen templates preserve the exact common prompt, including trailing newlines, and contain `{{ATTEMPT_STARTED_AT}}` and `{{CODING_STOPS_AT}}` exactly once. The CLI renders these from the persisted start and its 35-minute deadline, rather than attempting to freeze unknowable future timestamps. The final bridge requires the preparation command's literal `exit_code === 0`, parses one expected prepared-schema JSON result and validates native arguments before invoking its injected typed `createThread` callback. Nonzero, incomplete or malformed command results cannot reach that callback. Native argument publication records `native_launch_prepared`, preventing another preparation for the occupied launch slot. This is a data boundary, not a native transport; callers must check the actual CLI/tool success and use the structured `nativeArgs` object.

Already-created native launches without pre-launch intent require honest recovery accounting. `recovery_untracked_launch` is accepted only for the next untouched slot, with no active attempt, a unique actual chat ID, observed creation/completion timestamps, explicit `prelaunchStartedAt: null`, and retained evidence. It consumes that slot as infrastructure-invalid and permanently halts scoring. It never invents a start time, native profile or valid exposure. The report includes the observed runtime as a measured lower bound, labels incomplete elapsed coverage, and leaves time per verified fix unknown when its denominator includes unknown time. Invalid-only arms have no scored fix curve. This event cannot authorize another launch, replacement attempt or new cohort.

## Throughput checkpoint

- Blocking first steps. Freeze this amendment and the event interface, then validate current source/grader/task pins and native exposure evidence before each attempt.
- Independent workstreams. This owner writes the public reducer/CLI/report data. A disjoint plotting worker may render the agreed report format. Owner two prepares private environments. Root owns configuration and actual native runs.
- Shared mutable state. One writer owns each branch and private run. Root serializes public integration, pushes and native event publication.
- Smallest safe decomposition. First publish controller/event shapes, then reports/plots, then focused synthetic verification. Root and the independent reviewer own observed outcomes and acceptance.
