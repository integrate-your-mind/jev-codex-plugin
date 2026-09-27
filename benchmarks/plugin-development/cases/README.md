# Authored development action fixtures

These 20 offline cases cover the five development strata that remain after the
separate four-case shared-state batching cohort: concrete candidates/no-fit,
changed requirements, restart recovery, context selection, and action outcome
verification. Each stratum has one normal, conflicting-or-insufficient,
stale-invalid, and adversarial case.

These are deliberately small, transparent authored plumbing and decision-sanity
fixtures. Candidate descriptions make the relevant current, stale, destructive,
or bounded behavior explicit. Passing them can expose delivery, mapping,
freshness, restart, verification, and boundary regressions; it cannot establish
realistic coding-agent quality or improvement on held-out tasks.

`inputs.json` is a provider-facing **harness input document**. It contains
current state, candidate catalogs where the named surface would classify a
choice, and caller-report projections where the named surface would record an
outcome. Its `surface`, `event`, and `mcpMethod` fields preserve workflow
provenance. The case objects are not executable `classify_decision` or
`record_decision_outcome` MCP request bodies, and this directory has no MCP or
provider runner. The input contains no expected choice or postcondition.
`oracle.json` is never provider-visible. It names one passing harness action per
case, independent artifact postconditions, and negative controls.

Every action runs in a fresh directory created by the harness under the system
temporary directory. The harness copies only that case's `workspace/` seed and,
for restart cases, its durable `journal.json`. Action modules receive bounded
file capabilities rooted in that directory. The action worker and focused tests
run under macOS `/usr/bin/sandbox-exec` with network denied and Node's permission
model restricted to the temporary root. Their environment contains only
fixture-local HOME/TMPDIR, a fixed system PATH, and LANG; it contains no caller
credential variables. Foreign or unavailable candidate IDs are rejected before
an action module is invoked. All temporary directories are removed after each
test. The authored action modules and checker remain trusted fixture code.

The verifier ignores action return values and caller completion claims. It
checks resulting files, preserved inputs, exact journal transitions, action
counts, and synthetic secret exclusion. Every case proves that its passing
action satisfies the artifact oracle and that each frozen wrong, stale,
duplicate, unavailable, or prohibited control either is rejected without a
mutation or fails the same oracle.

The restart cases are deterministic harness fixtures at four durable states:
before send, after send before response persistence, after response persistence
before action, and after action before acknowledgement. They test recovery
decisions and resulting journal/effect state. Transitions are derived from the
seeded journal and bound transport, revision, or effect receipts. They do not
simulate power loss, provider-side idempotency, filesystem durability on every
host, or native Codex delivery.

The native-hook cases describe authored events available to a later experiment;
this catalog does not prove that an installed host automatically exposes those
events or candidates. `classify_decision` returns advisory classification, while
`record_decision_outcome` stores a caller report. The latter does not verify the
report. Independent verification in this directory belongs to the experimental
harness and is not a plugin feature.

The action-outcome cases write a `records/caller-report.json` harness projection
from the input and a separate `records/harness-verification.json` derived from
fixture evidence. This exercises the distinction between recording and checking
a report; it does not invoke or establish the plugin's actual storage schema.

Run the complete offline structural, boundary, positive-control, and
negative-control check:

```sh
node check.mjs
```

The current offline runner requires macOS with `/usr/bin/sandbox-exec` and a
Node release whose `process.allowedNodeEnvironmentFlags` includes
`--permission`. Linux CI validation is not provided by this fixture directory.

The command makes no provider call, native-host attempt, credential read,
installation, default change, or publication. A passing run establishes only
the authored offline fixture behavior described above.
It does not grade a provider response, delivery receipt, abstention, or the
separate batching stratum, and it does not bind the combined six-stratum
experiment manifest.
