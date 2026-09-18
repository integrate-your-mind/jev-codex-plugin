---
name: classify-decision
description: Consult Jev whenever Codex classifies or chooses tools, models and reasoning effort, tasks and delegation, skills, context, strategies, priorities, outcomes, or any other user-defined categories. Use throughout a task, including before consequential selections and when new evidence changes a decision.
---

# Jev decision consultation

Consult Jev for classification and selection throughout the work. Automatic lifecycle checks complement this skill; they cannot observe private internal reasoning, every hosted tool, or perform undocumented model switches.

## Runtime selection

Prefer the `classify_decision` MCP tool when it is available. If it is absent, use this skill's bundled `scripts/jev.mjs` with Node.js 22 or later and the `classify-decision` command. Resolve the script relative to this `SKILL.md`, not the working directory. Read [standalone usage and JSON examples](references/standalone.md) before the first CLI invocation. The CLI uses the same schemas, provider, redaction, evaluation reservations and receipts, and result meanings as MCP; CLI status is a smaller readiness summary.

Standalone skills do not register MCP tools, install lifecycle hooks, switch models, or configure automation. They need no npm install. Evaluation requires Node.js 22+, local process execution, an inherited provider key, outbound HTTPS, and writable private state. Local script execution is unavailable on some cloud surfaces; report that limitation and continue ordinary work there. Installing the full plugin remains the route to MCP and automatic hooks.

For the CLI, first use local `status` if credential readiness matters. Pass one JSON object on stdin; preview is the default. When existing user authorization covers the selected evidence, add `--evaluate`. Never place credentials in arguments or JSON. Read the returned `status` and `reasonCode`: process exit 0 alone does not mean Jev assessed the request. No missing key or inconclusive answer should stop the underlying task.

## Consultation workflow

1. Identify the question, current user objective, constraints, and actual candidates. Read current tool/model availability before proposing unavailable capabilities. For model or reasoning-effort decisions, make each candidate a real supported model/effort pair with its known tradeoffs. For tasks, compare concrete next actions, dependencies or delegation choices.
2. Supply `domain` (`tool`, `model`, `task`, `skill`, `context`, `strategy`, `result`, or `general`), `question`, bounded `context`, two to twelve `candidates` with safe unique `id` and `description`, and selected evidence with stable IDs. Mark unavailable candidates `available: false`. Use `general` for any other taxonomy; do not force unrelated categories into a fixed profile.
3. Default preview makes no TypeSafe request. The host can still retain the preview output, so minimize input before invoking it. When the user has requested Jev consultation, or installed automation policy is enabled for the current workspace, use `mode: evaluate` within that authorization. Existing authorization carries forward; do not ask again for every decision. Never transmit entire transcripts, secrets, environment dumps, or unrelated documents. Send the minimum relevant context; redaction is defense in depth.
4. Use an `assessed` candidate as advice for the next authorized action. Match the returned ID to the supplied candidate; do not invent tools, model capabilities, or permissions. Apply the selected tool/model/task choice through the normal supported Codex controls only when the action is already authorized. Jev does not approve external actions or replace the user's goal.
5. On abstention, gather missing evidence if useful or continue ordinary reasoning while acknowledging uncertainty. On timeout, unavailable credentials, recursion protection or exhausted budget, continue the task; do not loop until a favorable answer arrives or silently claim Jev checked it.
6. Keep the model, rubric version, evidence IDs and receipt with substantive decisions. Use `check_completion` separately for completion claims, and independent execution/tests as the actual functionality evidence.

For a new task or changed goal, classify the task and choose the next workflow. Before choosing an execution tool, model/effort, worker or next task, consult the corresponding profile. For any user-requested classification, use the same service with their actual categories. Reuse an unchanged assessment; new material evidence warrants a new one. Do not classify Jev's own housekeeping/tool calls recursively.

When the full plugin supplies it, only call `configure_automation` when the user asks to enable, scope, change or disable automatic consultation. That local setting is distinct from host hook review/trust. Never tell the user universal hidden-decision interception is active: report verified native events and remaining unsupported paths.
