# Published schema provenance

These files are downloaded copies of the published Agent Plugins 1.0.0 schemas used by the local manifest validator. They are retained so validation is reproducible without fetching a schema at runtime.

| File | Source URL | SHA-256 |
| --- | --- | --- |
| `plugin.schema.json` | https://agent-plugins.org/schemas/1.0.0/plugin.schema.json | `0a4aad95ce337878ad38802ebf0daa3fde76abe3f65400c86bcbb1ec0b3ab883` |
| `mcp.schema.json` | https://agent-plugins.org/schemas/1.0.0/mcp.schema.json | `6539175bfcdf43085855183e86da40ea94b166547a72b47ae9a0a390516d3acb` |

Downloaded and hashed on 2026-09-17. The schemas declare JSON Schema draft 2020-12 and the canonical `$id` values above. The plugin schema requires `$schema` and `name` and rejects unknown top-level fields. The MCP schema requires `$schema` and `mcpServers`, rejects unknown top-level fields, and defines `stdio`, `streamable-http`, and `sse` server variants. The published Agent Plugins specification remains authoritative for semantic requirements that JSON Schema cannot express.
