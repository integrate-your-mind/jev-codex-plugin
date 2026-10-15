# Distribution and directory status

The public repository distributes the full local Codex plugin through a Git-backed marketplace, plus portable source, standalone skill ZIPs, and release archives. It requires Node.js 22+ and your own TypeSafe API key for evaluation. The Codex compatibility package is the marketplace default: the initial CLI 0.153.4 audit found that portable-manifest loading skipped hooks, and the generated package passed native installation and hook checks on CLI 0.155.0.

```sh
codex plugin marketplace add integrate-your-mind/jev-codex-plugin
codex plugin add jev-workflows@jev-workflows
```

Start a fresh task after installation. Ask for `jev_status`, then enable automatic consultation if desired. Review the twelve hooks through the host's trust interface. Installation alone does not authorize automatic provider requests or prove that hooks ran.

The `source/jev-workflows` directory is the complete portable source package. `plugins/jev-workflows` is generated for current Codex hosts. Other Agent Plugins clients can use the portable archive if they support local stdio MCP; hook support and environment forwarding vary by host. No universal web-host compatibility is claimed.

Version 0.3 adds three standalone skills. Each ZIP includes its instructions, reference, license, and prebuilt local CLI. These skills support decision classification, failure diagnosis, and completion checks without requiring a separately installed MCP server. They do not register MCP tools, enable automation, or install hooks. Install only the full plugin or the standalone skills to avoid duplicate skill names. Hosts that cannot run local scripts cannot use this fallback.

OpenAI's universal public Plugins Directory requires a separate review. Its current [submission documentation](https://developers.openai.com/plugins/deploy/submission) permits skills, remote MCP, or both; local MCP requires contacting OpenAI for support. The [local plugin submission guidance](https://developers.openai.com/plugins/guides/submit-claude-plugin) also calls for partner review when core value requires local execution or persistent credentials. A ZIP containing a local authenticated CLI is therefore not proof of self-serve Directory eligibility. This release is publicly installable through Git and standalone skill distribution, but is not an approved Directory listing. Directory draft preparation does not mean submission, approval, or publication.

The MIT license covers this adapter; it does not license the TypeSafe service or grant rights to OpenAI or TypeSafe trademarks. This is an independent community integration.
