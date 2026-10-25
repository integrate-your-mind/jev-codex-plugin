# Hook advice delivery

Jev consultations and Jev advice delivery are separate stages. Every eligible hook event keeps its existing provider consultation, durable invocation receipt, and MCP answer. The hook only controls how the advisory result is rendered into host context.

`JEV_HOOK_ADVICE_MODE` accepts `all` or `actionable`. The default is `all`, and unknown values also use `all` for compatibility.

In `all` mode, the hook preserves the existing status, confidence, reason, receipt, and advisory text. `SessionStart` always keeps the existing guidance that tells the host how to consult Jev. This mode does not add a usage quota or skip a provider call.

In `actionable` mode, the hook keeps assessed valid custom candidate selections. It also keeps assessed `reconsider` and `gather_evidence` suggestions from the current hook domain. It suppresses status-only `abstained`, `unavailable`, `skipped`, and `preview` text, and suppresses a generic fallback `proceed` result. Receipts remain durable for every consultation, including quiet results. The mode does not invent a reason or upgrade an abstention into a decision.

`SessionStart` guidance remains unchanged in both modes. The repeated `UserPromptSubmit` consultation prefix is omitted in `actionable` mode when rendering the result. Explicit MCP and CLI question answers are unaffected.

This setting changes presentation only. It does not change authorization, credential handling, policy budgets, call eligibility, retry behavior, model selection, or storage paths.
