# QQ integration contract

The adapter runs the stable QQ binary as an isolated headless supervisor. Each
trial gets a private `XDG_DATA_HOME` below its output directory and a private
`QQ_CONFIG_CONTENT` profile. The profile fixes
`openai-codex/gpt-6-astra` at `high`, sets `jev_review: off`,
`jev_routing: false`, and `jev_approval: false`, and declares only the
`project_graph` stdio MCP server. No live QQ store, TUI, Keychain entry, or
global configuration is opened or changed.

Before provider execution, `qq mcp inspect project_graph` is run and its raw
descriptor output is retained privately. The reviewed tool is granted as
`mcp__project_graph__project_graph`; safe Node/TypeScript test and workspace
edit permissions are explicit headless grants. The adapter does not replace
QQ's approval policy or sandbox.

`runTrial` defaults to a dry preflight. A caller must explicitly pass
`authorizeProvider: true` to submit a model prompt. The receipt reports the
actual `trial` model/effort and usage from JSONL, native graph tool calls from
owned events, raw output paths, the private store path, and `cleanupRequired`.
Unknown model, effort, cost, completion, or graph delivery remains `null` or
false; requested settings are never presented as resolved evidence.

The child graph server receives workspace root, graph state, arm, objective,
and a private Jev key-file *reference* through `PROJECT_GRAPH_ROOT`,
`PROJECT_GRAPH_STATE`, `PROJECT_GRAPH_ARM`, `PROJECT_GRAPH_OBJECTIVE`, and
`JEV_API_KEY_FILE`.
Secret values are never placed in `QQ_CONFIG_CONTENT`, the child command,
receipts, or model-visible project files.
