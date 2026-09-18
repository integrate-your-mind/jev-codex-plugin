# Distribution and directory status

The public repository distributes the full local Codex plugin through a Git-backed marketplace, plus portable source and release archives. It requires Node.js 22+ and your own TypeSafe API key. The Codex compatibility package is the marketplace default: the initial CLI 0.153.4 audit found that portable-manifest loading skipped hooks, and the generated package passed native installation and hook checks on CLI 0.155.0.

```sh
codex plugin marketplace add integrate-your-mind/jev-codex-plugin
codex plugin add jev-workflows@jev-workflows
```

Start a fresh task after installation. Ask for `jev_status`, then enable automatic consultation if desired. Review the twelve hooks through the host's trust interface. Installation alone does not authorize automatic provider requests or prove that hooks ran.

The `source/jev-workflows` directory is the complete portable source package. `plugins/jev-workflows` is generated for current Codex hosts. Other Agent Plugins clients can use the portable archive if they support local stdio MCP; hook support and environment forwarding vary by host. No universal web-host compatibility is claimed.

OpenAI's universal public Plugins Directory requires a separate review. Its current [submission documentation](https://developers.openai.com/plugins/deploy/submission) requires a public HTTPS MCP endpoint, or an OpenAI contact for local MCP support. This release is a local stdio server and is not an approved Directory listing. A skills-only submission would not provide this plugin's MCP and hook functionality. Directory draft preparation does not mean submission, approval, or publication.

The MIT license covers this adapter; it does not license the TypeSafe service or grant rights to OpenAI or TypeSafe trademarks. This is an independent community integration.
