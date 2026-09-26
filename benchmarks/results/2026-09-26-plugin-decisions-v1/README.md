# Jev plugin decision evaluation v1

This result is a decision-plumbing evaluation of the Jev hook bundle. It contains 72 provider calls: 18 authored episodes × 2 repeats × 2 arms (`baseline` and `repair`). The arms were imported independently with Node `v22.23.2` on macOS arm64. The private JSONL transcript is retained outside the repository; this public directory contains only sanitized summaries and trial rows.

The raw provider disposition matched the supplied episode oracle for both arms: **36/36 baseline and 36/36 repair**. There are 32 assessed episodes and four evidence-insufficient abstentions per arm. Among assessed episodes, concrete decisions delivered were **0/32 baseline → 32/32 repair**; all 32 repair decisions matched the oracle. A neutral abstention is counted separately from a concrete candidate choice.

The repair arm used 38,508 input tokens versus 53,522 for baseline, a **28.05% reduction**. Output tokens were 2,278 for each arm. Median provider latency was 207.5 ms baseline and 205 ms repair; median hook invocation latency was 237 ms and 230 ms. Actual billed dollars are unknown.

The public files were derived from the private transcript with [`export-live.mjs`](./export-live.mjs). The exporter takes explicit input, oracle, summary-output, and trial-output paths; validates the attempted and terminal row accounting, arm/source identity, oracle hash, HTTP/validation fields, provider-ID presence boolean, and local receipt provenance; and copies only an explicit public allowlist. It never writes provider request IDs, raw payloads, local receipt IDs, source paths, credentials, or secret values. Its synthetic regression suite is [`export-live.test.mjs`](./export-live.test.mjs).

Regeneration against the retained transcript reproduced the existing public counts, source hashes, runtime, token totals, latency and payload medians, per-trial choices, statuses, HTTP/validation fields, receipt persistence/parity, and provider-ID presence flags. The generic exporter derives cohort-neutral limitation text, so its `limits` wording and JSON key order may differ from the existing summary; the existing `summary.json` and `trials.json` were preserved unchanged. No discrepancy in measured trial values was found.

The comparison changes a bundle of task-context projection, question alignment, candidate validation, and rendering. It cannot attribute the observed delivery difference to one component. The repair is therefore reported as a bundled arm. The result does not prove downstream task completion, task-quality improvement, deployment, acceptance, provider superiority, or billing cost. It also does not test automatic candidate discovery, native process startup, or a clean irrelevant-state invariance experiment. The supplied source pins are:

- baseline source SHA-256: `7b805b1784720cf18748c4b0c6d727134eb76713c4b0ebe96fa96cc49b9348e8`
- baseline `src/decision-hook.ts` SHA-256: `c1c42678a526277b8af022dbc279968db29901ff719973fa9db1e746cd5f56dd`
- repair source SHA-256: `26958051bf006c7ba490847f21dffa5f9e9f3eb5d1840a4899b9d00485816a3c`
- repair `src/decision-hook.ts` SHA-256: `eee9d69bfa8f36a5523c973ff1ca5b700ba3c4f9c18675abc0427a12573b3c8f`

To regenerate into a new private directory, use the pinned runtime and keep the existing public files untouched:

```sh
node22="${NODE22_BIN:-node}"
test "$($node22 --version)" = "v22.23.2"
$node22 benchmarks/results/2026-09-26-plugin-decisions-v1/export-live.mjs \
  --input /absolute/private/live-v1.jsonl \
  --oracle benchmarks/plugin-live-eval/oracle.json \
  --summary-out /absolute/private/regenerated-summary.json \
  --trials-out /absolute/private/regenerated-trials.json
```

This is an offline export operation. It does not launch a provider call or retry a transcript attempt.

## Reconstruct the experimental source

The source-only [`repair-source.patch`](./repair-source.patch) records the exact hook and regression-test changes used by the repaired arm. It does not update installed defaults or constitute a plugin release. Starting from a separate checkout of commit `7dfe432d7463bab7186a8dacf50924af282f9a20`, apply the patch from this results directory:

```sh
git apply --check /absolute/path/to/repair-source.patch
git apply /absolute/path/to/repair-source.patch
```

The resulting `source/jev-workflows/src/decision-hook.ts` must match the repair entry hash above. Follow the source package's normal dependency, build, and test instructions to regenerate distribution files; the live study imported source directly. The [frozen harness](../../plugin-live-eval/README.md) records all remaining input and runtime pins. A new provider run is a new cohort and must use a new output path.
