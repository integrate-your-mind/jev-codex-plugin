# Sequential cohort supervisor

`run-cohort.py` is the source-only supervisor for the frozen plugin-value
schedule. It uses only the Python standard library. It does not supply provider
credentials, start Docker by itself, or select a model. Each executed row calls
the adjacent authenticated `run-one.sh`, which owns those runtime checks.

The default is a read-only dry run:

```sh
python3 -B benchmarks/plugin-value/run-cohort.py --dry-run
```

The dry run validates the schedule and runner hashes against
`runtime-identity.json`, validates the frozen agent and treatment fields, and
prints all scheduled rows in order. It succeeds while `executionReady` is
false so the complete planned denominator remains inspectable. It does not
create cohort evidence or invoke `run-one.sh`.

Execution is explicit and requires existing, absolute, current-user-owned
directories with no group or other permissions:

```sh
python3 -B benchmarks/plugin-value/run-cohort.py --execute \
  --jobs-dir /absolute/private/pier-jobs \
  --evidence-dir /absolute/private/cohort-evidence
```

The operator must also provide the environment required by `run-one.sh`.
Execution refuses to start unless the runtime identity has
`executionReady: true`. The jobs and evidence directories must be disjoint and
outside the public source tree.

The default per-row outer deadline is 13,200 seconds: 10,800 seconds for the
agent, 1,800 seconds for the separate verifier, and 600 seconds for setup and
receipt overhead. `--deadline-seconds` exists for synthetic tests and for an
explicitly frozen future cohort; changing it changes the cohort identity.

Immediately before each new reservation, the supervisor recomputes the bound
schedule, runtime-identity, `run-one.sh`, and supervisor hashes. A mismatch
halts the cohort before that row is reserved. It then creates an exclusive,
fsynced reservation and appends distinct `launch_requested` and
`process_started` journal events. A reservation is never treated as proof that
a child was launched or completed. Any reserved row without a durable receipt
is reported as unknown and is never rerun. Completed receipts may be resumed;
the supervisor rechecks the retained log and the sole direct Pier trial result
before advancing to the next unreserved row. A later reservation before an
earlier row is rejected.

The child runs in a new process group. Timeout or operator interruption sends
TERM and then KILL to that group if needed. On Darwin, an `EPERM` group probe
uses `/bin/ps -e -o pgid=` as an independent absence check. A present group,
empty or malformed output, or a failed query remains unverified. The timeout
or interruption receipt is still retained, with `absenceVerified: false` and
a bounded cleanup error kind. A nonzero runner exit, timeout,
missing or multiple direct trial results, non-null `exception_info`, or a
missing, boolean, nonnumeric, non-finite, fractional, or out-of-range reward
halts the cohort. This DeepSWE schedule accepts only numeric 0 and 1. Reward 0
is an ordinary scored task failure and does not stop later rows; only reward 1
increments `binaryPasses`.

Pier's job-root `result.json` contains aggregate job statistics and is never
used as the trial verdict. For the frozen one-task, one-attempt invocation, the
supervisor requires exactly one direct child directory containing
`result.json`. Public supervisor output and receipts contain only its hash,
size, finite reward, and the fact that no exception was present. Child output
is retained only in the operator's private log directory; hidden verifier text
is not copied into the journal, receipt, or console output.

The cohort manifest binds the schedule, runtime identity, `run-one.sh`, and
supervisor source hashes, plus the fixed agent, treatment, denominator, and
deadline. Editing any bound source or identity prevents resume in the same
evidence directory. The supervisor assumes its host operator and Python
runtime are trusted; it is a deterministic scheduler and evidence recorder,
not a general host sandbox.

Exit status 0 means every scheduled row has a validated direct result. Status
2 means configuration or durable-state validation failed. Status 3 means the
cohort halted with an incomplete denominator. An interruption handled during a
row returns 130 and records the row as unknown.

The offline regression suite uses a synthetic local child only:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -B \
  benchmarks/plugin-value/tests/run_cohort_test.py -v
```

These tests establish scheduler and receipt behavior. They do not establish
Docker readiness, provider access, model behavior, native plugin behavior, or
task quality.
