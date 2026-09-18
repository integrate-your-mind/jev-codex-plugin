---
name: classify-decision
description: Consult Jev whenever Codex classifies or chooses tools, models and reasoning effort, tasks and delegation, skills, context, strategies, priorities, outcomes, or any other user-defined categories. Use throughout a task, including before consequential selections and when new evidence changes a decision.
---

# Jev decision consultation

Use this plugin's `classify_decision` tool for classification and selection throughout the work. Automatic lifecycle checks complement this skill; they cannot observe private internal reasoning, every hosted tool, or perform undocumented model switches.

1. Identify the question, current user objective, constraints, and actual candidates. Read current tool/model availability before proposing unavailable capabilities. For model or reasoning-effort decisions, make each candidate a real supported model/effort pair with its known tradeoffs. For tasks, compare concrete next actions, dependencies or delegation choices.
2. Supply `domain` (`tool`, `model`, `task`, `skill`, `context`, `strategy`, `result`, or `general`), `question`, bounded `context`, two to twelve `candidates` with safe unique `id` and `description`, and selected evidence with stable IDs. Mark unavailable candidates `available: false`. Use `general` for any other taxonomy; do not force unrelated categories into a fixed profile.
3. Default preview has no egress. When the user has requested Jev consultation, or installed automation policy is enabled for the current workspace, use `mode: evaluate` within that authorization. Existing authorization carries forward; do not ask again for every decision. Never transmit entire transcripts, secrets, environment dumps, or unrelated documents. Send the minimum relevant context; redaction is defense in depth.
4. Use an `assessed` candidate as advice for the next authorized action. Match the returned ID to the supplied candidate; do not invent tools, model capabilities, or permissions. Apply the selected tool/model/task choice through the normal supported Codex controls only when the action is already authorized. Jev does not approve external actions or replace the user's goal.
5. On abstention, gather missing evidence if useful or continue ordinary reasoning while acknowledging uncertainty. On timeout, unavailable credentials, recursion protection or exhausted budget, continue the task; do not loop until a favorable answer arrives or silently claim Jev checked it.
6. Keep the model, rubric version, evidence IDs and receipt with substantive decisions. Use `check_completion` separately for completion claims, and independent execution/tests as the actual functionality evidence.

For a new task or changed goal, classify the task and choose the next workflow. Before choosing an execution tool, model/effort, worker or next task, consult the corresponding profile. For any user-requested classification, use the same service with their actual categories. Reuse an unchanged assessment; new material evidence warrants a new one. Do not classify Jev's own housekeeping/tool calls recursively.

Only call `configure_automation` when the user asks to enable, scope, change or disable automatic consultation. That local setting is distinct from host hook review/trust. Never tell the user universal hidden-decision interception is active: report verified native events and remaining unsupported paths.
