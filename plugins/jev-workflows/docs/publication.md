# Publication and directory status

Jev Workflows has three separate distribution surfaces:

- The public GitHub repository and Git-backed Codex marketplace distribute the
  local plugin, generated compatibility package, and standalone skills.
- The OpenAI `plugins` repository is a separate proposed Codex official catalog
  contribution that requires maintainer review.
- OpenAI's universal Plugins Directory is a separate public submission, review,
  approval, and publication process shared by ChatGPT and Codex.

A public repository, prerelease, local marketplace entry, proposed catalog
change, or saved portal state does not establish universal Directory submission,
approval, or publication.

## Current portal state

A private authenticated portal read now shows the Jev Workflows App Info at
version 0.4.0 preparation state. Terms and release notes are filled, and the
portal UI accepted the exact JSON import with the App Info, five positive test
cases, and three negative test cases. The UI states that tool justifications
will be applied after an MCP server URL is entered and tools are scanned; that
URL has not been entered or scanned.

The native eight-tool test and the independent QA retest passed. A production
HTTPS MCP endpoint and demo URL are still missing. Because the implementation
depends on local execution and persistent credentials, local support requires
OpenAI partner review. No submitted, review, approved, or published Directory
status is claimed from this portal state.

## Proposed Codex official catalog contribution

The OpenAI Git-backed Codex catalog contribution is prepared as a proposed
external `git-subdir` entry for the public Jev repository's
`plugins/jev-workflows` package. It is separate from the universal Directory
portal flow. The proposal is pending maintainer review; no pull request has been
created, and it is not submitted until the final public release URL or commit is
set by the release owner.

The source package is public MIT 0.4.0 preparation. The catalog proposal does
not copy the generated runtime into OpenAI's repository and does not claim a
universal Directory approval.

## Submission paths

OpenAI's current submission documentation supports a skills-only plugin, a
remote MCP plugin, or a combination of remote MCP and skills. A local MCP server
must be deployed to a public HTTPS URL for the normal remote path; if the core
value requires local execution or persistent credentials, OpenAI's local-plugin
guidance says to contact an OpenAI partner before submitting.

Official references:

- <https://developers.openai.com/plugins/deploy/submission>
- <https://developers.openai.com/plugins/guides/submit-claude-plugin>
- <https://developers.openai.com/plugins/build/plugins>
- <https://developers.openai.com/plugins/deploy/submission-errors>
- <https://developers.openai.com/plugins/schemas/chatgpt-app-submission.v1.json>

## Current package boundary

The package currently has a local stdio MCP server, Codex-local hooks, local
state, and a user-provided TypeSafe credential. The implementation is advisory:
Jev does not grant permissions, execute selected decisions, certify deployment,
or replace independent verification. Those boundaries belong in any listing
copy, test case, and reviewer explanation.

The current source exposes eight MCP tools in `src/server.ts`: `jev_status`,
`classify_failure`, `check_completion`, `classify_decision`,
`configure_automation`, `evaluate_decisions`, `update_task_context`, and
`record_decision_outcome`. Native tool tests and an independent QA retest passed
for these surfaces. Do not invent an endpoint, OAuth flow, reviewer account,
demo credential, or publication state.

## Form and verification requirements

Before submission, prepare the customer-facing listing, verified developer or
business identity, public website/support/privacy/terms URLs, starter prompts,
country availability, release notes, and the exact positive/negative test matrix.
For remote MCP, also provide a production HTTPS endpoint, authentication and
reviewer-ready credentials where needed, domain verification, CSP if a UI is
used, and accurate `readOnlyHint`, `openWorldHint`, and `destructiveHint` values
for every tool.

The import schema requires `$schema`, `schema_version: 1`, and `tools` at the
top level. Its optional `test_cases` array requires at least five positive cases;
`negative_test_cases` requires at least three. The checked-in directory test
matrix records exactly five positive and three negative cases in
`verification/directory-test-cases-0.4.0.json`.

Submission starts review. It does not publish immediately. After approval, the
developer must perform the separate publish action before the plugin appears in
the universal directory.
