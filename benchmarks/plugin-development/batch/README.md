# Typed batch component benchmark

This authored benchmark compares one current `createService().evaluateDecisions`
component in isolation:

- `serial`: the same shared state, common policy, stable question IDs, and typed
  question definitions are sent one question per request;
- `batch`: all three independent questions are sent in one request over that
  shared state.

It does not test automatic native Codex behavior. The plugin remains advisory,
and a response does not establish that an action ran or that a coding task
improved.

## Frozen cohort

`inputs.json` contains four new authored cases: normal,
conflicting-or-insufficient, stale-invalid, and adversarial. Every case has one
independent Choice, Noul, and Score question. `no_fit` is a caller-defined actual
candidate for facts that rule out every other action. The provider-reserved
`insufficient_evidence` answer represents unresolved evidence and is never treated
as `no_fit` or permission.

Truth is stored only in `oracle/oracle.json`. `freeze.mjs` rejects truth-shaped
fields in provider inputs, verifies the accepted development-selection rule at
SHA-256 `7e6c99fe0d28eaf4d50cd4d94578ea32d65ecb4e630742e672f41efee47a7681`,
and freezes the service source, harness, order, plugin version, and provider
model. The counterbalanced schedule contains 16 operations:

- 4 cases × 2 repeats × 2 arms;
- 24 planned serial provider requests;
- 8 planned batch provider requests;
- 32 provider requests in the all-scheduled denominator.

Repetitions are nested within cases. The code grader requires every scheduled
attempt and never drops unavailable or malformed responses.

The oracle's Noul and Score ranges are authored fixture criteria. They are not
empirically or locally calibrated confidence thresholds. Choice grading keeps
raw provider agreement, local policy disposition, and the recommendation
returned by the service as separate fields. It also separates a prohibited raw
provider choice from a prohibited actionable recommendation. The harness never
executes an action, so actual harmful actions and independently verified
task/action benefits remain unmeasured.

## Commands

Use the pinned Node runtime. `NODE22_BIN` may select its portable location; the
version check prevents an accidental run under a different Node release:

```sh
NODE22=${NODE22_BIN:-node}
test "$("$NODE22" --version)" = "v22.23.2" || {
  echo "Node v22.23.2 required" >&2
  exit 1
}

# Recreate the freeze only before review and before any live request.
"$NODE22" benchmarks/plugin-development/batch/freeze.mjs --write \
  --source source/jev-workflows

# Verify without rewriting.
"$NODE22" benchmarks/plugin-development/batch/freeze.mjs \
  --source source/jev-workflows

# Offline tests and synthetic transport run; neither makes provider calls.
"$NODE22" --test benchmarks/plugin-development/batch/run.test.mjs
"$NODE22" benchmarks/plugin-development/batch/run.mjs \
  --source source/jev-workflows \
  --out /absolute/private/path/new-dry-run.jsonl
```

Live execution is intentionally gated and has not been run. After root reviews
the frozen inputs, use a new private output path outside `Documents`, the exact
SHA-256 of `freeze.json`, the pinned Node runtime, and both explicit gates:

The raw output is a private mode-`0600`, fsynced JSONL journal. Its
`benchmark-private-jsonl-fsync-v1` adapter retains complete approved service
receipts and provider request IDs for reconciliation. Report summaries expose
only identifier-presence booleans and counts; this adapter does not measure the
native `FileStore` persistence latency.

```sh
JEV_RUN_LIVE_BATCH_BENCHMARK=1 \
JEV_API_KEY_FILE=/absolute/private/credential-file \
"$NODE22" benchmarks/plugin-development/batch/run.mjs \
  --live \
  --reviewed-freeze-sha <reviewed-freeze-json-sha256> \
  --source source/jev-workflows \
  --out /absolute/private/outside-Documents/new-live-run.jsonl
```

Outputs use exclusive creation with mode `0600`; an existing path is never
overwritten. The JSONL log appends and syncs starts, transport events, service
completions, and operation completions as they occur. It retains provider-visible
payloads and raw response bodies, so it is private evidence. There are no adaptive
retries or hidden reruns.

The summary reports all scheduled attempts, transport/HTTP/validation/persistence
counts, request-ID and receipt-ID presence, provider version and usage presence,
request latency, full operation time, raw-choice agreement, policy disposition,
service-returned recommendations, both classifier-level harm signals, unknown
outcomes, and code-graded per-question results. Synthetic results are labeled and
cannot support a provider-quality claim. A service-returned recommendation is not
host delivery, execution, or a verified postcondition.

## Review checkpoint

The [integration review](review.json) accepts freeze 7190b847d193e36e6d86dd63f73793406fbbb1c489adfe45b770fb0455d87d42 for classifier-only evaluation after 17 offline regressions (13 journal/grader and 4 exporter). Root reviewed the receipt durability and correspondence fixes. Actual provider IDs are retained privately; credential fingerprints are stripped. A bounded private host write/fsync/readback succeeded before this checkpoint, but future journal writes must still succeed. No live call has run at this review checkpoint. This does not select an improved plugin configuration or establish task/action benefit.
