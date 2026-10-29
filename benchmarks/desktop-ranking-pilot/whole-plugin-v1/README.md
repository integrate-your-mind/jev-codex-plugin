# Whole-plugin Codex pilot

This controller records the approved six-bug, eighteen-attempt experiment. It does not create chats, invoke coding models, stop native work or independently grade patches. Root supplies observed native evidence and frozen grader receipts. The ranking-only controller in the parent directory remains unchanged.

The pure reducer owns single-use slot state. A private frozen manifest plus numbered immutable events owns durable study state. Raw transcripts, credentials, workspace paths and grader solutions stay outside exports.

```sh
node benchmarks/desktop-ranking-pilot/whole-plugin-v1/cli.mjs template config.json manifest.json
node benchmarks/desktop-ranking-pilot/whole-plugin-v1/cli.mjs freeze manifest.json private-run-dir
node benchmarks/desktop-ranking-pilot/whole-plugin-v1/cli.mjs record private-run-dir event.json
node benchmarks/desktop-ranking-pilot/whole-plugin-v1/cli.mjs status private-run-dir
node benchmarks/desktop-ranking-pilot/whole-plugin-v1/cli.mjs export private-run-dir new-output-dir
python benchmarks/desktop-ranking-pilot/whole-plugin-v1/plot.py new-output-dir/report.json new-output-dir
```

See [spec.md](spec.md) for manifest and event fields. `template` accepts study ID, host settings evidence, arm exposure profiles and optional per-task public-input/failure/packet hashes. It reuses accepted grader controls without rerunning them. Record `start` before opening a native chat, then `identity` after verifying actual loaded profile, workspace and components. Cheap arms also require a timed `retrieval`. `coding_ended` freezes the patch identity before an independent `graded` result.

The first three terminal outcomes require a retained `interim_report` event before attempt four. Export each update into a new directory. JSON and CSV contain only aggregate counts, observed times, task IDs and nulls for unknown billing. Charts retain pending and infrastructure-invalid outcomes explicitly. Render dependencies are in `plot-requirements.txt`; rendering tests use synthetic reports and never count toward the pilot.

All assigned elapsed time contributes to cost per verified fix. Fix percentages use actual completed, source-valid observations. Curves stop at terminal observations and include unsuccessful assigned time. Unknown model billing remains unknown, provider invocations are separate from success, and consultation counts do not establish benefit. The exploratory verdict requires all eighteen source-valid outcomes, observed advice uptake, no increased approval interruptions, and the approved fix/time screen.

This is not an official full SWE-bench score. Completion does not launch a confirmation study or lift Claude, QQ, routing or stable-promotion holds.

## Guarded native launch preparation

Use the guard for an independently authorized future study. It cannot resume a halted cohort or replace its consumed attempts.

```sh
node benchmarks/desktop-ranking-pilot/whole-plugin-v1/cli.mjs freeze-launch-contract private-run-dir launch-contract.json
node benchmarks/desktop-ranking-pilot/whole-plugin-v1/cli.mjs prepare-launch private-run-dir launch-request.json
```

Freeze the contract before the first attempt. Its schema is `whole-plugin-launch-contract-v1`, with `manifestHash`, `commonPromptHash`, and the eighteen ordered `slots`. Each slot pins `slotId`, trusted native `projectId`, absolute `workspace`, `baseRevision`, `configurationHash` and the expected `promptTemplateHash`. Hashes use the canonical `hash` export from `controller.mjs`.

Persist the normal `start` event before preparation. A request uses `whole-plugin-launch-preparation-v1`, `manifestHash`, `slotId`, observed ISO `at`, `selected`, `commonPromptPath`, `promptTemplatePath`, and `prerequisites`. `selected` contains the observed `projectId`, `workspace`, `model`, `effort`, `baseRevision`, and `configurationHash`. Each prerequisite contains `id`, literal `exitCode: 0`, `signal: null`, `artifactPath`, and `artifactHash`. Command failure or an absent prompt file returns an error and no native arguments. Do not concatenate, pipe or reuse command stdout/stderr as prompt content.

Required artifacts are JSON. `prompt-preparation` uses `whole-plugin-prompt-ready-v1` with `manifestHash`, `slotId`, `commonPromptHash`, and `promptTemplateHash`. `workspace-validation` uses `whole-plugin-workspace-ready-v1` with `slotId`, the same `selected` observation, and `nativeProject` from the latest supported project listing. That readback must contain matching `projectId`, exact workspace `path`, `isGitRepository: true`, and `projectKind: "local"`. A future unregistered contract project ID may be null; a known ID must match, and every actual selected ID must be valid. The prepared artifact binds it once. `prior-outcomes` uses `whole-plugin-prior-outcomes-v1` with `grades`, containing the preceding completed independent receipts. A grade receipt must use `whole-plugin-independent-grade-v1`, matching `slotId`, `patchHash`, `graderHash`, `studyVerdict`, its actual grading `exitCode`, and healthy `terminal.verdict`. Missing `studyVerdict` is a schema failure.

Successful preparation exclusively writes a private `launches/<slot-id>.json`, verifies readback, records `native_launch_prepared`, and returns a structured `nativeArgs` object. It makes no native call. Use the exported final bridge below so the actual command status and structured result are checked at the native-call boundary. A second preparation is rejected. Uncertain publication is retained for reconciliation, never silently retried or bypassed. The guard establishes validated launch inputs; actual chat exposure and model identity still require native observations.


The frozen prompt template retains the exact common text, including its trailing newline, followed by the existing timing suffix. Replace the two time values with `{{ATTEMPT_STARTED_AT}}` and `{{CODING_STOPS_AT}}`. The CLI fills them from the slot's persisted start and its deadline; no contract mutation or current-clock substitution is needed between attempts.

The supported host integration supplies its existing preparation runner and native creation callback. The bridge accepts only a completed command result with literal `exit_code: 0` and a single prepared-schema JSON object. It validates the prepared content hash, fixed model and effort, local project target and exact prompt hash before invoking the callback. It never interprets stderr as a prompt, salvages JSON from mixed output or executes arbitrary tools.

```js
import {dispatchPreparedNativeLaunch} from './launch.mjs';

const commandResult = await runPreparation();
const nativeResult = await dispatchPreparedNativeLaunch(
  commandResult,
  nativeArgs => createThread(nativeArgs),
);
```

Here `runPreparation` is the host's narrow `prepare-launch` invocation, returning its actual command receipt, and `createThread` is its supported native chat-creation binding. Tests inject a stub and assert zero calls for failure, stderr, malformed JSON or a wrong prepared schema. This recipe does not create a new transport or grant permission to launch a held study.

## Approved sixteen-attempt linked continuation

```sh
node benchmarks/desktop-ranking-pilot/whole-plugin-v1/cli.mjs freeze-continuation parent-run new-private-child-run continuation-config.json
```

The approved config supplies a new `studyId`, actual `humanApprovalEvidenceHash`, and optional observed ISO `at`. The parent directory is read-only to this command. It replays the retained original event history, requires the valid first Standard Codex result plus the invalid second cheap launch and sixteen untouched slots, and creates a new directory exclusively. Existing child output causes failure rather than replacement.

The child manifest pins parent manifest/state/imported-slot hashes and the approval receipt. Its first global `continuation_import` event retains the parent snapshot and copies exactly the first two slot records, including their raw timing, usage and missing-start limitations. Imported records are immutable in the child. No start can occur before this import; only the original third slot is next. Native launch contracts may freeze after the sole import event, before any new start. Existing prepared/native identity checks then apply normally.

After that third terminal result, retain the first-three comparison charts before starting the fourth slot. Reports count the two imported attempts once, permit at most sixteen new attempts, expose parent linkage and keep the original eighteen-slot screen inconclusive. The linked continuation is not a new independent full benchmark. No CLI command here launches coding work.
