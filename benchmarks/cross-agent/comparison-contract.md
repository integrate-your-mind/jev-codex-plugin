# Cross-agent comparison contract

`compare.mjs` reduces already-normalized trial records. It does not run agents,
grade artifacts, inspect provider logs, or infer missing measurements. A runner
for Codex, QQ, or another agent must export one frozen plan and one JSON object
per trial in JSONL.

## Minimal command

```sh
node benchmarks/cross-agent/compare.mjs \
  --plan plan.json \
  --trials trials.jsonl \
  --out comparison.json
```

The command exits nonzero for any contract violation. It writes the summary
with mode `0600`; an existing output path is rejected and never overwritten.

## Frozen plan

The plan has `schemaVersion: "jev-cross-agent-comparison-plan-v1"`, a
`comparison` object, one shared `cohort`, and a complete `trials` array. The
comparison object declares an explicit `armOrder` and `timingMetric`:

```json
{"factor":"treatment","cohortId":"cohort-1","armOrder":["control","treatment"],"timingMetric":"agent_turn_sum_ms"}
```

Pair deltas always use the declared arm order, never the order in which rows
arrive. Treatment comparisons must use `["control", "treatment"]`. Every
planned row contains:

```json
{
  "trialId": "task-1.r1.control",
  "taskId": "task-1",
  "inputHash": "sha256:immutable-input",
  "repetition": 1,
  "arm": "control",
  "plannedIdentity": {
    "agent": "codex",
    "agentVersion": "1.2.3",
    "model": "model-x",
    "provider": "provider-y",
    "effort": "medium",
    "pluginEnabled": false,
    "pluginVersion": null
  }
}
```

`cohort` is shared exactly by every trial and records
`datasetFingerprint`, `harnessFingerprint`, `imageFingerprint` (nullable when
the environment has no image identity), `environmentMode` (`native_shared` or
`container`), `resourceBudget` (`cpuMs`, `memoryBytes`, `diskBytes`, each
nullable when uncontrolled), `timeBudget` (`basis: "per_turn"` or
`"per_trial"` and nullable `valueMs`), and `networkPolicy` (`mode` plus an optional allowlist
fingerprint). The reducer rejects mixed cohort, resource, time, or network
configuration. Nullable native resource fields are explicit uncontrolled
measurements, not zero budgets.

Each task/input/repetition must have exactly two arms. The reducer rejects
duplicate, missing, unexpected, or wrongly identified trials. It also rejects
an observed plugin identity that differs from the plan. For a `treatment`
factor, arms must be `control` and `treatment`; control has
`pluginEnabled: false` and no plugin version, while treatment has
`pluginEnabled: true` and a plugin version. For an `agent` factor, agent
comparisons such as Codex versus QQ are explicitly observational.

## Normalized trial record

Each row has `schemaVersion: "jev-cross-agent-trial-v1"`, the planned identity
and an `observedIdentity` that must match it, plus the same cohort object. It
must retain outcomes independently:

```json
{
  "artifactVerifier": {"status": "passed", "passed": true},
  "agentCompletion": {"status": "completed", "completed": true},
  "timing": {"metric": "agent_turn_wall_ms", "valueMs": 4210},
  "tokens": {"input": 1200, "cachedInput": 400, "output": 180},
  "billing": {"actualBilledUsd": null, "source": "unknown"},
  "infrastructureError": null
}
```

`agent_turn_wall_ms` is wall-clock time from one agent turn dispatch to its
completion. `agent_turn_sum_ms` is the sum of those per-turn durations for a
multi-turn trial. Startup, readiness, artifact verification, and cleanup are
excluded from both. A missing timing value is `null`; it is retained in the
denominator and yields a `null` paired timing delta.

`cachedInput` is a subset of `input`, never an additional amount. The reducer
reports input, cached input, and output separately and rejects cached input
larger than input. Per-arm token summaries provide known and unknown counts,
an observed subtotal of known values, and a `total` only when every scheduled
trial has that field. Actual billed USD is nullable. `source: "unknown"` must
use `actualBilledUsd: null`; unknown is never encoded as zero. Per-arm billing
summaries use the same known/unknown and observed-subtotal versus complete-total
distinction. Infrastructure failures remain attached to their trial and are
counted separately rather than being converted into task-quality failures.

## Summary interpretation

The reducer reports scheduled and observed denominators, per-arm artifact and
agent-completion outcomes, measured timing counts, token observations, billing
known/unknown counts, infrastructure failures, and one descriptive paired row
per task/input/repetition. Pair deltas are second frozen-plan arm minus first
frozen-plan arm; null measurements produce null deltas.

With `comparison.factor: "agent"`, the claim is
`observational_agent_comparison`: it does not establish plugin causality or
model superiority. With `comparison.factor: "treatment"`, the claim is
`fixed_model_plugin_delta`: all identity fields other than plugin state are
fixed, so the result is limited to the plugin delta under this cohort. The
reducer emits no significance tests, confidence intervals, synthetic p-values,
or fabricated costs.

The complete field and version contract is in
[`record.schema.json`](./record.schema.json).
