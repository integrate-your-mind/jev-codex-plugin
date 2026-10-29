# Whole-plugin pilot execution audit

This is a supplement to source acceptance at `747c348add739061ec0aa9958f27dae7d3957cc6`. It reviews new execution evidence and source followup `0e9b8c5` without conducting inference or altering the study. The reviewer did not author the subject or operate the coding chats.

## Observed failure and disposition

The first Standard Codex patch independently passed the frozen focused grader. The retained receipt joins the expected task, base, patch and grader, with a healthy passing terminal result. This is one verified fix on one bug, not a comparison or an official SWE-bench score.

Root then accessed a nonexistent top-level `verdict` field in that receipt. The actual schema provides `studyVerdict` and `terminal`. Preparation failed before the intended second prompt and start record were created. Root did not check the command's nonzero exit, then passed a missing-file shell error to native chat creation as the second task prompt. That chat consulted the source chat while trying to recover its assignment and ended without fixing code.

The observed failure is consequential. Likelihood is 10/10 because it occurred in this run. Impact is 9/10 because unchecked preparation output caused a real launch without its intended task or isolation instructions, invalidating that condition. Product is 90. Root is repairing the dispatch boundary rather than merely adding another instruction.

Further scoring must remain stopped under the approved isolation rule. The unintended second native launch consumed its assigned slot and cannot be silently replaced. It is infrastructure-invalid, not an ordinary coding failure. The Jev condition has not run. A partial chart must show one valid Standard Codex result, the invalid cheap launch, and unstarted conditions explicitly. There is no measurement of Jev's benefit or harm.

## Chronology and accounting requirements

Retain original immutable controller records. Recover missing observations only from original tool/native/grader timestamps and label the reconstruction. A missing prelaunch start-intent record remains missing; it must not be invented retroactively. The second native launch and its consumed elapsed time belong in the incident/partial accounting even when the original reducer lacks a normal start event for it.

The first grade's original completion time is inside its allowed grading window. Any recovered observation event must use genuine evidence time consistent with the already retained usage event, not rewrite the original event history merely to pass a clock check. Missing exact timing remains unknown or bounded by actual observations.

## Source followup and verification

Followup `0e9b8c5` preserves the frozen retrieval parameters, retains unavailable cheap packets without replacing the attempt, exports usage/packet coverage, and tests the exploratory screen. All fifteen controller tests passed independently in the review worktree. These tests remain synthetic harness evidence.

The launch guard is still awaiting review at this checkpoint. Acceptance requires a failed or missing preparation result to invoke no native dispatch, prompt identity to bind the intended task and approved common text, and grade import to validate the real receipt schema plus patch/grader/health joins. A helper's unit tests do not prove the root used that helper for an actual dispatch.

## Human decision needed for resumed inference

Two concrete options preserve the current evidence. Neither starts automatically.

1. Approve an explicit amendment that retains the verified first result and invalid second slot, adds no replacement, and executes only the remaining sixteen slots after the launch guard is accepted. Reporting must preserve the invalid condition and changed evaluability; the original all-eighteen-valid superiority screen cannot be claimed as satisfied.
2. Preserve this halted pilot as partial evidence and approve a separately identified cohort with newly selected bugs, avoiding the already exposed solutions and outcomes. This would be new inference, not a hidden retry of this study.

No stable promotion, QQ work, Claude inference, adaptive-routing study or followup cohort is authorized by this review.

## Recovery export review

The actual six retained events replay under recovery source `c2c527cf540ab89bcdfef6af7d03b8b6480c35c9`. The export has one completed valid fix, one consumed infrastructure-invalid launch and sixteen unstarted slots. The Standard Codex elapsed total is 596,155 milliseconds, including root's recovery delay. The invalid cheap launch contributes 54,000 milliseconds of observed native runtime as a lower bound with unknown prelaunch timing. It has no scored fix curve. Jev is unstarted and has no scored curve. The overall interpretation remains inconclusive.

The global halted caption omission was reported as likelihood 10 × impact 4 = 40 and corrected in renderer subject `73a298b48841049ea584472cd2fb906515fd7ea3`. Current actual SVGs all carry the halted status and timing caveats; the actual PNGs were visually inspected. A fresh copied path was used to confirm the cumulative plot's current bytes after an initial reused-path view showed an older caption. This does not establish the cause of that display discrepancy.

## Launch guard finding at 53226ee

The twenty focused guard/controller tests pass, but a direct test using the retained real common prompt and first coding prompt rejects that approved prompt. The common text ends in a newline and the actual launcher appended one more newline before the recorded timing metadata. The guard instead requires two additional newlines after the common text. With valid synthetic pins, successful decoded prerequisite receipts and a persisted start, it raises `Native prompt must be the expected coding content, never stderr`.

Likelihood is 10/10 because the real prompt format deterministically fails. Impact is 6/10 because a guarded continuation preserving that format cannot launch. Product is 60. In addition, freezing all eighteen complete prompt hashes before the first launch cannot represent their actual recorded launch/deadline suffixes, which are unknown then. A frozen common/template contract and deterministic per-slot timing validation can address that without weakening stderr or task-identity checks. The author and root were notified. Guard acceptance is withheld pending the targeted correction and a new exact-head verdict.

The proposed sixteen-slot continuation correctly requires a new linked identity and independent import/accounting acceptance. Current guard code intentionally cannot resume the halted original state. Human approval of that proposal remains a separate decision; this review does not grant it.
