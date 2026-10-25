# Tweet draft — work in progress, not a release announcement

Building Jev Workflows for Codex, Claude Code & QQ: no plugin quotas, traceable receipts, opt-in quieter advice, and reusable on/off benchmarks for correctness, completion, time & cost. No proven quality gain yet.
https://github.com/integrate-your-mind/jev-codex-plugin

The link points to the existing public source repository. Today's benchmark harness and quieter-advice candidate are preserved local work, not a newly published release. The wording deliberately makes no marketplace, speedup or quality-improvement claim.

## Optional follow-up posts

1. The benchmark protocol uses the same tasks, model, effort and permissions within each host, external correctness checks, and preserved failures. Codex and QQ share GPT-6 Astra/high; Claude uses pinned Opus. Incomplete data stays incomplete.
2. Fixed isolation and receipt-accounting bugs that made enabled hooks look like successful calls—or made real calls look like zero. Attempts, validated responses and delivered advice are separate now. QQ provider-ID coverage still needs work.
3. QQ's local Apple-signing fix was verified across rebuild/restart with real Codex + Jev requests after initial authorization, preserving existing sessions and credentials. The newer benchmark adapter's final approval path still needs a fresh native on/off pair.
4. The opt-in quieter-advice candidate keeps consultations and audit receipts intact while suppressing neutral hook text. Local tests pass; held-out performance testing and release validation are still ahead. No artificial daily quota was added.
5. Paused with all results preserved. The five completed Claude task pairs had the same correctness in both arms; Codex's one complete pair also tied. Too early for a benefit claim. We will publish reproducible evidence once the full study is complete.
