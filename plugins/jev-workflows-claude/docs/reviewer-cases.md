# Reviewer Q&A cases

Use synthetic evidence and an authorized TypeSafe key. Preview first if transmission is not authorized. Assessments may abstain; record status and receipt rather than forcing a favorable answer.

| Case | Input/task | Expected observable behavior |
| --- | --- | --- |
| Tool choice | Compare text search with image inspection for a local PNG layout. | Select the available image tool or abstain; return only a listed candidate. |
| Model choice | Compare actual supported model/effort pairs for a simple bounded edit. | Consider task constraints, not invented model availability. |
| Failure diagnosis | Run a synthetic command with an intentional nonzero exit and provide its real stderr/exit. | Return a failure category with evidence identifiers or abstain. |
| Completion review | Supply a tiny bug fix and passing behavior checks. | Assess only the demonstrated local result. |
| Automatic result context | Enable hooks in a disposable workspace, run a sentinel command, finish the turn. | Post-tool receipt hashes match exposed output; Stop includes same-turn result evidence where available. |
| Unavailable candidate | Mark a desirable tool unavailable. | Never return it as an actionable selected choice. |
| Unsupported deployment | Supply passing local tests and claim public production deployment. | Do not treat local tests as deployment evidence. |
| Provider failure | Simulate timeout, malformed response, or rate limit in local tests. | Report unavailable/fail-open behavior; do not authorize actions, invent results, or retry indefinitely. |

See the release verification report for observed results, including abstentions and host limitations.
