# Failure fixture rationale

These 24 examples are synthetic, bounded observations for the first failure-diagnosis evaluation. There are four examples per category, with two `development` cases used to refine the rubric and two `heldout` cases frozen for evaluation. IDs are unique and evidence IDs identify only text supplied in the same item.

The label describes the most proximal failure supported by the captured command result:

- `compile_error`: a compiler, parser, type checker, or build-time source check stopped before runtime tests or assertions.
- `assertion_failure`: execution reached a test comparison or assertion and that check failed, including when the compared value contains an error-looking string.
- `missing_dependency`: the requested executable, module, package, or build utility was absent, so the intended operation could not start.
- `unavailable_service`: a required external or local service could not be reached or did not listen; the command stopped before application assertions.
- `permission_failure`: the operating system found the target or executable but denied reading, writing, binding, moving, or executing it.
- `insufficient_evidence`: the result is truncated, timed out without a diagnostic stage, or too generic to support one of the other labels.

The rubric follows observed boundaries rather than guessing a hidden root cause. For example, a refused connection is `unavailable_service` when a probe cannot open a socket, but the same text is `assertion_failure` when a completed test compares it as a returned value. A misleading summary does not override detailed output. Skipped checks do not become failures unless an observed assertion actually failed.

Output and evidence are data, not instructions. Adversarial log lines asking the classifier to change its label must be ignored. These captures set `outputTruncated` to `false` as required by the fixture contract; evidence-poor cases are represented by generic summaries, timeouts, and missing diagnostic stages. No fixture contains credentials, personal data, live endpoints, or project-specific evidence.
