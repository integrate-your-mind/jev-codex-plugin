# Hook delivery repair verification

Base: `f67f0f35df13cbc0556539e6f86fe14e2c04d6f8` on `origin/main`. The existing experimental repair was integrated into `fix/concrete-decision-delivery` without benchmark infrastructure.

## Reproduced failure

With the base release bundle and the new regression test, a supplied `read_thread` candidate assessed at confidence 0.98 produced `status=assessed; confidence=0.98`, omitting the selected decision. The `bundled hook emits only a supplied validated candidate` test failed as expected. The rebuilt 0.4.1 bundle passes that test. This reproduction uses an injected service response; it establishes adapter delivery behavior, not model quality.

## Local checks

- Independent `npm ci --ignore-scripts`: success, no dependency changes.
- TypeScript typecheck and build: passed.
- Full plugin suite: 162 tests passed, no failures/skips.
- Manifest validation and generated host distribution parity: passed.
- Distribution drift tests: 2 passed.
- `git diff --check`: passed.

Coverage includes real service validation with a mock HTTP response, safe concrete candidate delivery, foreign/unavailable/unsafe choice rejection, neutral abstention, current versus stale catalogs, duplicate IDs, malformed availability, oversized and escape-heavy context, recent constraints/corrections, redaction, credential rotation, concurrency, and unlimited policy. No provider calls occur in these unit tests.

The generated host package keeps conventional `hooks/hooks.json` discovery. Build outputs are retained installable assets; test state under `work/` is removed by test teardown. Raw local test logs are retained outside the committed verification report.

## Limits

This report proves the local checks above only. Independent review and installed runtime checks are recorded below. Hosted CI did not run because of an account billing lock. Task-quality improvement remains unproven; a catalog must still come from a host or explicit caller.

## Independent review and installed runtime

An independent agent reviewed exact commit `78612994bb856252fc300ffef17421d092f70b52` against `f67f0f3` in a separate detached worktree. No actionable findings. It separately passed typecheck, build, all 162 tests (including 37 focused hook tests), manifest checks and distribution parity.

Version 0.4.1 was installed through the existing personal marketplace with the existing state directory preserved. The cache hook matches the tested build. The current chat's MCP status reports 0.4.1 with all three automation limits null and both product limits null.

A fresh Codex 0.155.0 app-server loaded and trusted all 12 reviewed hooks from the 0.4.1 cache. One ephemeral GPT-6 Astra low-effort turn ran the specified sentinel command once, exited 0, and completed. UserPromptSubmit, PreToolUse, PostToolUse and Stop each produced a correlated assessed live-provider receipt. Terminal output and same-turn result evidence were verified.

A separate live call through the installed hook with supplied `read_thread` / `run_tests` candidates returned and visibly delivered `read_thread` at confidence 0.99. HTTP success and a provider request ID were retained. This is a controlled integration fixture, not a benchmark or proof of a better task decision. The public [runtime receipt summary](delivery-fix-runtime-0.4.1.json) contains the bounded evidence; full local receipts retain private diagnostic metadata.

The [hosted run for the code commit](https://github.com/integrate-your-mind/jev-codex-plugin/actions/runs/37175197669) failed before any job step. GitHub reported: “The job was not started because your account is locked due to a billing issue.” No claim of hosted CI success, merge, marketplace approval, or benchmark improvement is made. The recent Cloud task inventory did not identify a Jev repository environment; no unrelated Cloud run was submitted.
