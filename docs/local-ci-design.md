# Local Actions design

Owner: the existing Jev plugin root owner, branch `feat/jev-cross-host-sync`, PR 10. This extends the cross-host delivery record. Romy requested local GitHub Actions with no hosted billing on October 15.

## User journey and data

A maintainer installs the repository's pre-push hook once. Each pushed commit is verified from `git archive`, including non-HEAD branch tips, using the same `scripts/verify.mjs` entrypoint through `act`. A failed verification prevents that push. A manual command reruns an exact commit. The Actions-format workflow lives in `.ci/verify.yml`, outside GitHub's automatically scheduled workflow directory. The old hosted workflow is removed and disabled at GitHub during migration.

A run has an exact commit SHA, controller digest, start/end timestamps, exit status, platform, log and receipt. Logs and receipts live in the Git common directory under `jev-local-ci`, outside source and packages. Success is recorded only after the workflow exits zero and cleanup completes. Every invocation reruns verification; success receipts are never used as a cache. The local hook is an aid for this checkout, not a server-side merge policy. Contributors must install it or run the documented command themselves.

## Execution and state ownership

A dedicated Lima VM named `jev-plugin-ci` uses plain mode, no host mounts, no SSH agent forwarding and no inherited host environment. It does not share the private startup runner. Docker and pinned `act` live inside this VM. The controller sends an exact archive through SSH stdin, then runs Actions inside a disposable Docker container. The job receives no Docker socket, no host filesystem, no GitHub token, no Jev credentials and no provider keys. The Node image is pinned by digest. Network is available for public locked npm dependencies. The workflow uses the archived source and does not authenticate or fetch a different revision.

The VM and installed toolchain are retained as a reusable local CI dependency. Per-run source, dependency folders and containers are disposable and removed on completion or failure. The VM is stopped when the controller finishes. A local exclusive lock prevents two runs from interfering. No daemon, hosted runner registration or cloud service is required. CI happens on developer pushes, so GitHub's scheduler and account billing lock do not participate.

## Authorization, privacy and recovery

The host controller and hook are installed from reviewed source. They must not be installed from an untrusted contribution. Only reviewed maintainer commits are admitted on this reusable VM; fork PRs are not automatically executed. This is not a hardened service for arbitrary hostile workflows. The VM has no host mounts but can reach the network; stronger hostile-code/network isolation is deliberately out of scope. Publishing a GitHub commit status occurs separately on the host after verification, without placing credentials in the VM. A status must identify the exact verified SHA and honest execution environment.

The installer preserves existing hooks and refuses to overwrite a different hook or hooksPath. There are no user-data migrations or credential changes. Source remains in Git; receipts remain in the Git directory. Recovery is removing the installed hook and rebuilding only this named VM from the checked-in setup configuration. Existing logs are retained across setup. No production deployments, plugin runtime changes, unrelated workflows or billing changes are included.

## Acceptance and throughput checkpoint

1. Ground the existing shared verification command and official `act`/Lima interfaces. Completed before implementation.
2. Compare scheduler-connected self-hosted Actions with local `act`. Choose `act` to remove the locked scheduler dependency and avoid a persistent public GitHub runner.
3. Blocking first steps: inspect isolation and install the dedicated toolchain before runtime QA.
4. Independent workstreams: root owns VM setup, workflow migration and docs; the existing implementation worker owns the controller, hook installer and focused tests; the existing reviewer stays read-only.
5. Shared mutable state: one controller at a time owns the VM and per-run directory. No worker touches startup-ci or private-repository workflows.
6. Smallest safe decomposition: one reusable runner command plus one hook; no polling service or new CI platform.
7. Verify real local Actions success, deliberate failing-code rejection, stale-identity rejection, credential/mount/socket absence, cleanup and pre-push invocation. Run the full plugin checks on the final exact commit and publish/read back its separate local status.
8. Obtain independent review for the final head and update PR 10. Merge and official-store acceptance remain separate outcomes.
