# Relevance engine contract

The coding agent receives the same graph source cards in all three arms. `Ranker` accepts a provider-neutral `RelevanceEvaluator` over those cards and the current objective, query, graph revision, source node, and visited nodes. Its result is either one ordinal distribution per node or an unavailable reason with the attempts already made. Code validates exact levels, normalized probabilities, and an argmax choice, then sorts by expected level. This boundary prevents a provider scalar score from becoming a source-of-truth ranking.

`jev.ts` is the concrete adapter. It sends independent Choice questions in bounded redacted batches. `PROJECT_GRAPH_JEV_MODEL` selects an exact version, defaulting to `jev-1.14.0`. Returned model identity must match. The service's strict shared Score validator is unchanged. This isolated adapter selects unlimited service call and byte budgets without changing global policy. A provider outage suppresses redundant requests for 30 seconds; later requests resume normally. Every fallback stays assigned to Jev and uses the fixed cheap order.

Private attempts retain requested and returned model, nullable usage, receipt and provider request IDs, cached status, actual fetch status, and transport outcome. Cached provider responses retain their original metadata, while aggregate fetched usage and fetch counts exclude those cache hits. Rankings and attempts never appear on public cards. Unknown reported billing remains unknown.

The existing experiment specification owns authentication references, private state separation, source preservation, failure handling, and acceptance. This change adds no database, migrations, global hooks, installations, or provider framework. Fixtures exercise this contract before root freezes and authorizes any real provider calls.

## Throughput checkpoint

- Blocking first steps. Verify the existing prototype and its failing Choice types; install only local dependencies after inspecting scripts.
- Independent workstreams. The engine owner changes the evaluator and ranking modules. A child owns runtime pagination, packet uptake links, and graph/MCP fixtures in a separate worktree.
- Shared mutable state. Neither owner edits the other's files. Root receives coherent commits and the integrated exact revision.
- Smallest safe decomposition. One provider adapter and one pure ordinal validator keep changes local. Existing graph extraction, public card shapes, and global provider behavior remain intact.
