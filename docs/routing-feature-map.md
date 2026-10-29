# Routing repair feature map

| User behavior | Production path | Verification |
| --- | --- | --- |
| Consult later candidates and supplied inventory pages | `src/decision.ts`, `src/routing-consultation.ts`, `src/decision-hook.ts` | `tests/routing-consultation.test.ts`, `tests/decision-hook.test.ts` |
| Preserve task facts under concurrent writers | `src/state-lock.ts`, `src/task-context.ts`, `src/store.ts` | `tests/task-context-lock.test.ts`, `tests/task-context.test.ts` |
| Resolve catalog references through existing MCP tools | `src/server.ts`, `src/routing/api.ts` | `tests/routing-api.test.ts` includes real stdio transport |
| Enforce eligible model-effort pairs and pins | `src/routing/profiles.ts`, `src/routing/api.ts` | `tests/routing-state.test.ts`, `tests/routing-api.test.ts` |
| Distinguish recommendation, delivery, application and execution | `src/routing/contracts.ts`, `src/routing/state.ts` | `tests/routing-state.test.ts`, `tests/routing-api.test.ts` |
| Avoid repeated advice on unchanged facts | `src/policy.ts`, `src/decision-hook.ts`, `src/routing-consultation.ts` | `tests/routing-consultation.test.ts`, `tests/decision-hook.test.ts` |
| Read a causally bound Claude decision without another producer | `src/claude-hook.ts`, `src/hosts/claude/` | `tests/claude-hook.test.ts`, `tests/claude-bridge.test.ts`, `tests/claude-retention.test.ts` |
| Package opt-in native Claude configuration safely | `scripts/package-claude.mjs`, `templates/claude/` | `tests/claude-package.test.ts`, installed static validator receipt |
| Qualify Codex capabilities honestly | `src/hosts/codex/qualification.ts` | `tests/desktop-qualification.test.ts`, recorded NOT_QUALIFIED receipt |
| Select next repository evidence with cheap or Jev ranking | `src/routing/evidence.ts` | `tests/routing-evidence.test.ts`; coding value not yet measured |
| Preserve all eighteen trial slots and observed-only charts | `benchmarks/desktop-ranking-pilot/` | five repository-local Node test files and real grader-control receipts |
| Compare standard Codex, cheap retrieval and the whole plugin without replacing failed attempts | `benchmarks/desktop-ranking-pilot/whole-plugin-v1/` | `controller.test.mjs`, synthetic `plot_test.py`, native attempt events and independent grader receipts; synthetic checks establish harness behavior only |
| Build both host packages from the same source | `scripts/build.mjs`, `scripts/package-host.mjs`, `scripts/package-claude.mjs` | root `scripts/verify.mjs`, byte-parity and distribution checks |

Production and source test paths in the table are relative to `source/jev-workflows/` unless prefixed with `benchmarks/` or described as root. The public tools can observe only what supported host discovery or callers actually supply. No row establishes native host actuation or coding quality without its separate runtime evidence.
