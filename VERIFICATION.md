# Verification

Verification date: 2026-09-18

This report covers the public source and packaged runtime. It records the checks
below; it does not establish directory approval, provider billing, or model quality.

## Verified

- Integrated test suite: **89 passed, 0 failed, 0 skipped** in the current
  accounting-inclusive run.
- The public source also passed a clean dependency install, typecheck, build, all 89 tests and manifest validation.
- TypeScript typecheck: **passed**.
- Build: **passed**.
- Manifest validation: **passed**; the packaged entrypoints and manifests agree.
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
  HTTP 200 responses yielded three validated evaluations and one
  `unavailable/invalid_response`; all four retained provider request identifiers.
  See the [sanitized remote-install report](verification/native-remote-install.json).
- Distribution verifier and its two regression tests: **passed**. The verifier
  checks complete generated-package parity and version/marketplace consistency.

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
