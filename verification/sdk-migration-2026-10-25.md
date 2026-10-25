# TypeSafe SDK migration

The provider uses the official `@typesafe-ai/sdk@0.7.0` for request serialization,
authentication, HTTP transport and response parsing. The migration retains the
0.5.1 public tool contract and both host packages. It does not publish a release.

## Compatibility contract

Codex and Claude users keep their existing plugin configuration, credential
lookup and receipt store. There is no data migration or new durable state.
The SDK receives the resolved credential, fixed TypeSafe API origin and selected
model explicitly. SDK environment defaults cannot redirect credentials or change
the model. Logging, automatic retries and request compression are disabled.

The provider's injected transport retains the 64 KiB response bound, safe
request-ID header fallback, response timestamps, HTTP status and proxy diagnostic.
It cancels error bodies before SDK parsing. Only sanitized plugin error codes
leave the provider boundary. The shared validator still checks the returned
model, exact answer IDs, distributions, Score legends, Box coordinates and
nullable usage. Existing cancellation and total timeout signals cover the SDK.

Experimental images remain opt-in. Validated base64 inputs become SDK `Image`
assets and are serialized as multipart file bytes. Their public input shape,
media limits and danger-zone opt-in headers stay the same. No new quota or
approval layer is introduced.

Acceptance requires deterministic transport tests for fixed origin/model/auth,
no retries, nullable usage, safe request IDs, HTTP errors, malformed and oversized
bodies, cancellation before and after a response, timeout, multipart image bytes
and Box validation. The repository verifier must also pass typecheck, runtime
tests, retained-build integrity and both generated host-package checks.

## Evidence and limits

The focused provider and service suite passed 34 tests on 2026-10-25. The original
header assertions assumed a lowercase JavaScript object key; the SDK emits
case-insensitive HTTP headers, so those assertions now use `Headers.get()`.
The full `node scripts/verify.mjs` verifier passed on Node 26.10.0, macOS arm64: 199 runtime tests and 17 root verification tests, typecheck, retained-build integrity, manifests and Codex/Claude package parity. Exact-head local Linux CI remains pending before push.

The full suite exposed two old test-transport assumptions: image requests were parsed as JSON instead of multipart, and one credential-rotation mock read a lowercase object key. Both fixtures now inspect the actual wire representation. The skill ZIP inspection also returns a SHA-256 digest instead of printing a bundle larger than the child-process output limit; it compares the entire archived CLI against the source bundle. Ten batch/rotation regressions and three packaging regressions passed after those repairs.

All transport tests use injected responses and a fake credential. No real Jev
request, coding trial, installation or benchmark was run. The previous live
validation of SDK 0.6.0 does not establish live validation of this revision.
Provider testing remains paused while TypeSafe credits are unavailable.

Primary references checked on 2026-10-25:

- [Official SDK source and image transport](https://github.com/typesafe-ai/typesafe-sdk-js).
- [Official SDK request options and retry defaults](https://github.com/typesafe-ai/typesafe-sdk-js/blob/main/src/types.ts).
- [TypeSafe API reference](https://docs.typesafe.ai/api).
