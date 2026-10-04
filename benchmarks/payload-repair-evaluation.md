# Experimental hook payload repair

This note preserves the historical isolated benchmark candidate on branch `benchmark/plugin-payload-repair`, based on commit `7dfe432d7463bab7186a8dacf50924af282f9a20`. At the time of the experiment it was uncommitted and not installed.

Preservation disposition (2026-10-04 UTC): the three changed source/test files exactly match the production repair code commit `78612994bb856252fc300ffef17421d092f70b52` in [PR #9](https://github.com/integrate-your-mind/jev-codex-plugin/pull/9). The retained hook bundles differ from that production build only in the reported 0.4.0 versus 0.4.1 version. The host compatibility file's change is its generation timestamp. This branch retains the original candidate and historical evidence; it is not a second implementation or a new release. The reviewed production version 0.4.1 has since been installed and verified separately. No tests or live experiments were rerun for this preservation commit; the observations below describe the original experiment.

## Intended experimental differences

The candidate changes only the automatic decision hook and its direct regression tests:

1. An assessed choice is emitted only when its ID is safe, belongs to the exact request candidate roster, and is currently available. A valid caller candidate is preserved in the model-visible advisory and compact invocation receipt. A foreign, unavailable, reserved, or injection-shaped choice is normalized to `status=unavailable; reason=invalid_choice` before either surface is written.
2. A supplied concrete candidate catalog receives a concrete domain question such as “Which available tool candidate …?” The current event catalog takes precedence over saved task state. Duplicate candidate IDs and non-boolean availability invalidate affected input instead of resolving conflicts or coercing values. The existing event-specific proceed/reconsider/gather-evidence question remains the fallback when no valid catalog was supplied.
3. Saved task context is sent once as a structured object. Candidate catalogs, scope hashes, and prior-goal history are omitted from that state because the active catalog is already a typed request field. `task.prompt` evidence now contains only the bounded, redacted current prompt.
4. When task context makes the hook context exceed its bound, the compact object retains the root objective, latest step, newest constraints and correction, response status fields, and turn-result status/count. Both the 1,400-byte excerpt and strict 700-byte fallback are JSON-size bounded, record exact omitted-list counts, set explicit context/task-context truncation metadata, and remain valid JSON.

No hook manifest, event timing, local policy threshold, provider model, or host permission behavior changes in this experiment.

## Synthetic regression evidence

All regression inputs are synthetic and use temporary private state.

- Real service plus mocked provider selected `read_thread` from `[read_thread, run_tests]`. The exact hook output included `status=assessed; decision=read_thread; confidence=0.96`; the compact receipt recorded both `classification=read_thread` and `providerChoice=read_thread`.
- Mock services returned a foreign ID, an unavailable roster ID, and an injection-shaped string. Each produced `status=unavailable; reason=invalid_choice`; none appeared as a decision or raw receipt field.
- An abstained dynamic selection remained absent from model-visible advice while its safe candidate ID remained available in the private compact receipt for diagnosis.
- A real-service provider `insufficient_evidence` abstention remained neutral in the advisory and was retained only as `providerChoice=insufficient_evidence` in the compact receipt. A mocked assessed result with that reserved label was rejected as `invalid_choice`.
- A stale saved `read_thread` catalog plus a current event catalog containing only `run_tests` sent only `run_tests` and emitted only that current choice. A supplied catalog with duplicate `read_thread` IDs and conflicting availability fell back to the generic action catalog and matching generic question. String, numeric, and null `available` values were also rejected rather than being coerced to available.
- A schema-valid saved context with nine maximum-sized constraints previously produced 15,530 bytes of `task.prompt` evidence and was rejected locally as `invalid_input`. The repaired path sent only the bounded redacted current prompt as evidence, retained the newest constraint, criterion, and correction in structured compact context, marked exact omissions, reached the mocked provider exactly once, and returned an assessed result. An escape-heavy regression forced the strict fallback, verified its task-context encoding stayed at or below 700 bytes, and retained the newest decisive constraint and correction.
- The generated `dist/decision-hook.mjs` is directly imported in a test that confirms a supplied valid candidate reaches the advisory.

No TypeSafe or other external provider request is made by these regressions.

## Verification

Run from `source/jev-workflows`:

```sh
node --import tsx --test --test-concurrency=1 tests/decision-hook.test.ts tests/decision-hook-entry.test.ts
npm run typecheck
npm run build
npm test
npm run validate
```

Observed before this note was finalized:

- focused hook and bundled-entry tests: 37 passed, 0 failed;
- TypeScript typecheck: passed;
- complete test suite: 173 passed, 0 failed;
- manifest validation: passed.

The retained installable bundle was regenerated from the modified source. The dependency directory used during verification is a temporary ignored symlink to the original repository's existing `node_modules`; it is not part of the candidate changes.

## Snapshot hashes

Baseline source hashes at commit `7dfe432`:

```text
c1c42678a526277b8af022dbc279968db29901ff719973fa9db1e746cd5f56dd  source/jev-workflows/src/decision-hook.ts
8249606958f3c0ede43cdf907f56465423b27c3dd78c1e41221e60eb8f6738fd  source/jev-workflows/tests/decision-hook.test.ts
cbbe3150a0996b18737526a284c3d979430315ce4e459e89edcc17618439c10f  source/jev-workflows/dist/decision-hook.mjs
```

Experimental candidate hashes:

```text
eee9d69bfa8f36a5523c973ff1ca5b700ba3c4f9c18675abc0427a12573b3c8f  source/jev-workflows/src/decision-hook.ts
264d323f613f5d640f826dc20ea50a4dbb1cf8057c933401f38185f871d7907f  source/jev-workflows/tests/decision-hook.test.ts
aa916f2d2c439ff6ba38baa308249fafa53f68860b539757a2d0aa5e681faecc  source/jev-workflows/tests/decision-hook-entry.test.ts
13710dd51d7cb536e0620a4e9617f74dcb567364dc284c7c6feb53da77d8d496  source/jev-workflows/dist/decision-hook.mjs
```

## Evaluation boundary

These tests prove mechanism repair, bounded egress, and host-output safety. They do not prove that Jev improves task quality. The next comparison should keep the same frozen tasks, Codex model/effort, permissions, candidate rosters, and graders across baseline, released plugin, repaired plugin, and oracle-advice arms. Advice-to-next-action linkage and independent task grading are required before attributing a task outcome to Jev.
