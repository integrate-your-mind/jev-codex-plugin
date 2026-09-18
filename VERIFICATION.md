# Verification

Verification date: 2026-09-18

This report covers the public source and packaged runtime. It records the checks
below; it does not establish directory approval, provider billing, or model quality.

## Additive 0.3.0-rc.1

The 0.3.0-rc.1 source and staged public package are synchronized. The additive
design keeps the Git marketplace installation, five MCP tools, and twelve
lifecycle adapters while adding a bundled standalone CLI to each of the three skills.
The CLI commands are `status`, `classify-decision`, `classify-failure`, and
`check-completion`; these fallbacks do not require MCP.

- Canonical and staged public test suites: **106 passed, 0 failed, 0 skipped**.
- Actual Node 22.23.2 CLI, entrypoint, and extracted-package checks: **15 passed**.
- The full **106-test suite also passed on Node 22.23.2**, with no failures, cancellations, or skips. Mock transport timeout tests retain a temporary event-loop handle so the real abort timer can fire on Node 22; all timeout and receipt assertions remain intact.
- Canonical typecheck: **passed**.
- Canonical build: **passed**.
- Canonical manifest validation: **passed**.
- Distribution verifier and two drift regression tests: **passed**.
- Frozen standalone CLI SHA-256: `f0920d0fc9b6f45f82a01755c7cc4813a7cdafa7e4edd01960717a67f0efcb90`.
- Gitleaks scan: **clean** over 12.57 MB.
- Fresh native 0.3.0 personal discovery: **passed**, with twelve trusted hooks,
  unchanged global policy hash, and unlimited default caps (`null`).
- Independent QA: **completed**. Four original live evaluations comprised three
  assessed and one abstained result with four unique HTTP 200 provider IDs;
  the fixture’s subtraction operator was changed to addition, and both tests then passed. QA covered tool
  advice, assertion diagnosis, completion support, and abstention on unsupported
  deployment claims.
- A separate final-bundle completion evaluation returned
  `partially_supported` with confidence 0.88 and retained provider evidence.
  It is one additional CLI request, for five attributed CLI requests total;
  it is not an overall Jev approval or a model-accuracy result.

See the sanitized [0.3.0 standalone evidence record](verification/standalone-0.3.0.json).
The evidence does not claim hosted CI, provider billing reconciliation, or
official directory approval. A low documentation error-envelope mismatch was
corrected in the docs; runtime behavior was unchanged.

## Verified in 0.2.2

- Fresh isolated native metadata and MCP checks passed for the 0.2.2 packaged
  runtime. The server identified as version **0.2.2**, exposed all five tools,
  loaded all 12 lifecycle hooks, and completed the native command with exit
  code 0 and zero generative turns.
- The check made no provider call. The default daily call, daily byte, and
  session hook limits remained `null`.
- `configure_automation` reports `destructiveHint: true` and explicitly states
  that a newly written policy replaces the prior policy without retaining it.
  See the [sanitized 0.2.2 native metadata report](verification/native-metadata-0.2.2.json).
- This is local metadata and integration evidence. The 0.2.1 live-provider
  QA below remains a separate release record and is not attributed to 0.2.2.

## Verified in 0.2.1

- Integrated test suite: **91 passed, 0 failed, 0 skipped** in the current
  accounting and response-diagnostic run.
- Canonical source passed a clean locked dependency install, typecheck, build, all 91 tests and manifest validation. The packaged public source also passed typecheck, all 91 tests and manifest validation using that same locked dependency tree.
- TypeScript typecheck: **passed**.
- Build: **passed**.
- Manifest validation: **passed**; the packaged entrypoints and manifests agree.
- Fresh installed native MCP status: **passed** for runtime 0.2.1. It loaded all
  12 lifecycle adapters and verified reservation semantics, credential partitions,
  unknown billing and unlimited default call/byte/session settings.
- Response diagnostics: fixed validation-stage codes are retained without provider
  bodies, arbitrary field names, exception messages or credentials. Regression
  tests cover malformed bodies, schema/model/key/probability failures, the
  delimiter-collision bug, and receipt persistence.
- Distribution verifier and its two regression tests: **passed**.

- Public GitHub installation and native command run: **passed** for 0.2.1.
  All 19 installed package files matched the downloaded revision. Four correlated
  hook calls produced four validated evaluations (including an abstention) with
  retained provider IDs. The full isolated inventory held six validated responses.
  See the [0.2.1 remote-install report](verification/native-remote-install-0.2.1.json).

## Earlier native integration evidence (0.2.0)

- Installed-accounting probe: **passed**. The controlled probe observed one
  successful HTTP 200 response with a provider request identifier; the immediate
  cached repeat reused the retained result and made no second request.
- Native public-neutral run: **passed** on a real Codex host. The run loaded the
  plugin's 12-hook lifecycle and captured real command execution, output, and
  Stop evidence.
- Native final success, failure, and asynchronous scenarios: **passed**.
- Installation from the public GitHub marketplace: **passed**. The downloaded
  commit and all 19 installed package files matched the public source. A real
  Codex turn loaded all 12 adapters, exercised five lifecycle events, executed
  a command, and correlated its output with the retained Jev receipt. The four
  hook-correlated HTTP 200 responses yielded three validated evaluations and one
  `unavailable/invalid_response`; all four retained provider request identifiers.
  The full isolated receipt inventory held six HTTP 200 responses and five
  validated evaluations, including two additional validated abstentions outside
  the correlated hook subset. These are retained local counts, not billing.
  See the [sanitized remote-install report](verification/native-remote-install.json).

- Fresh native MCP status checks passed for both the installed personal package and neutral public package. They asserted reservation semantics, current/other/unknown credential partitions, and unknown provider billing.

## Hosted CI

The [initial GitHub Actions run](https://github.com/integrate-your-mind/jev-codex-plugin/actions/runs/35360672909)
was blocked by the hosting account before any test step executed. Hosted CI is
**not passed**. The local results above are separate evidence.

## Accounting boundary

The implementation now separates local pre-dispatch reservations, retained
evaluation receipts, and provider billing metadata. Cached results reuse their
original receipt and do not make a new request. The local accounting and
reconciliation limits are documented in [docs/accounting.md](source/jev-workflows/docs/accounting.md).

Provider dashboard/account billing reconciliation remains unresolved. Local
receipts and HTTP status do not establish provider billing, and this report
does not claim a root cause without provider-side corroboration.

## Native-host limitations

The native host evidence is sufficient for the scenarios above. Host stdout may
omit an exit status even when the structured runtime report records it, and the
native host did not expose an intermediate asynchronous hook event in the
observed run. These are reporting/host-observation limitations, not a claim that
those signals are universally absent.

A separate agent chat exercised the installed 0.2.1 runtime through successful,
intentionally failing, and asynchronous commands. It reproduced two failing
batch-rounding tests, applied a one-line fixture fix, and then passed all five
tests. Jev classified the assertion failure, supported the bounded local fix,
contradicted an unsupported deployment claim, and abstained on contradictory
reports. It also evaluated tool, model/effort, task, skill, context, strategy and
caller-defined decisions. These synthetic cases establish the observed behavior,
not general classification accuracy. Automatic hook feedback was observed; exact
per-command event attribution during parallel calls is not asserted.

The run made 15 explicit provider evaluations: 11 assessed and four abstained.
These are observations from these cases, not accuracy measurements. The JSON and
Markdown reports were saved and read-back verified, including 22 unique provider
request references across explicit calls and representative automatic feedback.
An automatic response later failed probability-sum validation and was reported
unavailable without blocking completion.

The earlier QA chat retained a stale approval status after its command completed.
The replacement chat ran under ordinary host policy and the user's existing QA
authorization. Transient filesystem errors affected report creation, but the
final reports were retained before disposable fixtures were removed.
See the [sanitized chat QA report](verification/chat-qa-0.2.1.json).

## Secret scan

The initial scan found five matches of the same intentional dummy token fixture
(`sk-123456789012345`) in `source/jev-workflows/tests/decision-hook.test.ts`.
Those test cases exercise redaction and contain no live credential. The exact
literal and exact public test path are allowlisted in [.gitleaks.toml](.gitleaks.toml);
the scan was rerun with that narrowly scoped rule and produced a clean result.

No private counts, request identifiers, fingerprints, account emails, home paths,
transcripts, or model accuracy/performance benchmarks are included here.

## Release status

This repository is a release candidate for the public Git marketplace. Provider
dashboard reconciliation and official directory review remain open. A public
source repository or prerelease does not establish final acceptance
or OpenAI Directory approval.
