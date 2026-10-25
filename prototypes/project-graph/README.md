# Project graph prototype

This experimental component gives Codex and QQ the same read-only TypeScript project graph through one stdio MCP tool. It parses repository files and symbols with the TypeScript compiler API, records resolved imports and compiler-resolved symbol references and calls, and invalidates every node ID after a source change.

## Environment

- `PROJECT_GRAPH_ROOT` is the candidate workspace.
- `PROJECT_GRAPH_STATE` is a private directory outside that workspace.
- `PROJECT_GRAPH_ARM` is `graph`, `cheap`, or `jev`.
- `PROJECT_GRAPH_OBJECTIVE` is the organic coding objective.
- `JEV_STATE_DIRECTORY` and `JEV_API_KEY_FILE` are distinct absolute private Jev state and credential references required only by the `jev` arm. They must resolve outside the candidate workspace. The engine pins direct ordering to Jev 1.13.0 and enables the direct evaluation service without changing global policy.

The server exposes one tool named `project_graph`. Its operations are `search(query)`, `expand(nodeId, query?, cursor?)`, and `read(nodeId)`. Host-visible results contain source cards, graph and packet identities, and pagination only. Arm names, ranking scores, rationales, confidence, provider metadata, and credential paths are absent. Private `trace.jsonl` records builds, ordering, paged delivery, provider receipt and transport metadata, and monotonic component durations. A `tool_output` event is appended only after the stdio transport reports that its serialized response write succeeded.

The Jev arm asks one independent ordinal choice question per optional node. The five levels range from unrelated to essential. The engine orders nodes by the expected level computed from the validated probability vector. A provider abstention, an incomplete vector, or an invalid answer falls back to the frozen cheap order.

## Build and checks

Run these from this directory with the repository's pinned Node 22 toolchain.

```sh
npm run typecheck
npm test
```

The build writes retained standalone bundles to `dist/server.mjs` and `dist/cli.mjs`. TypeScript 5.9.3 is pinned locally because it is the current in-process compiler API used by the extractor. The build resolves the MCP and Jev dependencies from `source/jev-workflows/node_modules` and bundles every runtime dependency into both outputs.

For direct CLI inspection, set the environment above and run one of these commands.

```sh
node dist/cli.mjs search --query "credential cache isolation"
node dist/cli.mjs expand --node NODE_ID --query "call sites"
node dist/cli.mjs read --node NODE_ID
```

Create a new isolated plugin directory after building with `npm run package:plugin -- /absolute/new/path`. The packager refuses an existing destination. It does not install or modify global configuration.

The initial extractor is deliberately limited to TypeScript and JavaScript syntax that the TypeScript compiler accepts. External and unresolved imports are recorded in the private graph trace. They are not represented as source cards or claimed as semantic repository edges.
