# Verification

Verification date: 2026-09-18

This report covers the public source and packaged runtime. It records the checks
below; it does not establish directory approval, provider billing, or model quality.

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

A separate chat QA run remains **waiting on approval** and is not counted as
completed verification.

## Secret scan

The initial scan found five matches of the same intentional dummy token fixture
(`sk-123456789012345`) in `source/jev-workflows/tests/decision-hook.test.ts`.
Those test cases exercise redaction and contain no live credential. The exact
literal and exact public test path are allowlisted in [.gitleaks.toml](.gitleaks.toml);
the scan was rerun with that narrowly scoped rule and produced a clean result.

No private counts, request identifiers, fingerprints, account emails, home paths,
transcripts, or model accuracy/performance benchmarks are included here.

## Release status

This repository is a release candidate for the public Git marketplace. Final
chat QA, provider dashboard reconciliation, and official directory review remain
open. A public source repository or prerelease does not establish final acceptance
or OpenAI Directory approval.
