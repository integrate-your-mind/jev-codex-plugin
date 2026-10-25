# Native runtime amendment, 26 September 2026

Recorded at 21:12 UTC, before any synthetic native model control or scored
DeepSWE model call. The 40-row schedule, task selection, plugin revision, model,
effort, task images, time limits, and outcome rules are unchanged.

## Execution boundary

The host runs Codex app-server and the Jev plugin. It selects only the
`deep-swe` environment (`include_local=false`) at both thread and turn scope.
The task's pinned Codex exec-server runs in a digest-pinned Docker container
with no network, account credentials, Docker socket, added capabilities, or
host PID namespace. A shared, authenticated runtime is mounted read-only in
the agent container and is absent from the separate verifier.

The turn explicitly uses the supported Codex 0.155.0 policy
`{"type":"externalSandbox","networkAccess":"restricted"}`. Docker supplies
the execution boundary. The earlier attempt to layer Codex's Linux sandbox
inside Docker failed before task execution; its diagnostic receipts remain
retained. No host-wide sandbox setting or installed plugin default is changed.

This is a documented departure from an in-container model client. It keeps
reusable credentials outside the task filesystem and lets both arms use the
same native remote shell and patch tools. Merely connecting exec-server does
not establish that this works: independent native controls must pass first.

## Controls before scoring

1. Use a fresh synthetic nonce workspace, outside all benchmark tasks, for
   each arm. Require completed remote shell commands and an actual patch.
2. For treatment, require actual native Jev tool calls, persisted validated
   provider-response evidence, and completed pre/post tool hooks. Abstention
   is an acceptable advisory result; simulated responses are not controls.
3. Stop the agent container, then verify exact file contents and the complete
   entry set in a fresh offline container. Keep the oracle outside the agent
   mounts. Preserve failed controls instead of overwriting them.
4. Recheck original task repository integrity before model inference and
   verify Pier collection plus task-verifier plumbing separately. A synthetic
   workspace pass does not validate the original task image or task oracle.

The synthetic runner is supervised with an outer timeout. After completion
or interruption the operator verifies that its exact labeled containers are
absent. Its control manifest binds the driver, host runner, runtime, image
ledger, model, and effort identities. All controls remain outside the scored
denominator; `executionReady` stays false until the prerequisites pass.

## Task metadata provenance

The pinned upstream Koota task TOML contains the abbreviated base commit
`72ebef44b8e024d877250f055eea60cdfaa4506`. Resolving that exact reference in the
upstream repository yields `72ebef44b8e024d877250f055eea60cdfaa45069`.
The runtime metadata amendment retains the original value and source hash,
records the resolution evidence, and uses the full commit identity for the
pre-agent Git check. This resolves the same selected task; it does not replace
the task, modify its source TOML, or expose its solution to the agent.

The local ipython image also needed rematerialization after its task files were
observed as zero bytes. A pull of the same digest after exact task-owned cache
cleanup restored nonempty files, the expected Git HEAD, and a clean worktree.
This repair changes no image identity or scoring rule. Its retained repair
receipt SHA-256 is
`8aedc5acc77e70ed089a81a7cdb42e8560005c72ac7cb82e8d65975a933b88cf`.
The cause of the original local corruption remains unproven.
