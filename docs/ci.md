# Local CI for Jev Workflows

Jev Workflows uses local GitHub Actions through [`act`](https://nektosact.com/). There are no GitHub-hosted jobs. The workflow is [.ci/verify.yml](../.ci/verify.yml), outside GitHub's workflow discovery directory. It calls the same `node scripts/verify.mjs` entrypoint used during development. The previous GitHub workflow has been disabled and removed from the candidate branch.

## Install on Apple Silicon macOS

Use a reviewed checkout, Node.js 22+, Git and [Lima](https://lima-vm.io/docs/installation/). The supplied configuration creates a dedicated Linux ARM64 VM named `jev-plugin-ci`. It does not use another project's VM or Docker daemon.

```sh
limactl start --tty=false --name=jev-plugin-ci .ci/lima.yaml
limactl shell --workdir /tmp jev-plugin-ci sudo -n bash < .ci/setup-guest.sh
limactl shell --workdir /tmp jev-plugin-ci sudo -n tee /usr/local/bin/jev-local-ci-run < .ci/run-guest.sh > /dev/null
limactl shell --workdir /tmp jev-plugin-ci sudo -n chmod 755 /usr/local/bin/jev-local-ci-run
limactl stop jev-plugin-ci
node scripts/install-local-ci-hook.mjs
```

Setup installs Docker, checksum-verified `act` 0.2.89 and the digest-pinned Node 22.23.2 image inside the VM. The installer copies the reviewed controller and guest helper into the repository's Git common directory and installs a pre-push hook there. It refuses unrelated hooks or a configured `core.hooksPath`. No GitHub or Jev token is required. Updating the controller requires rerunning the installer; updating the guest helper requires copying it into the VM again. A helper hash mismatch fails verification.

## Run and inspect

```sh
node scripts/local-ci.mjs "$(git rev-parse HEAD)"
git push
```

The hook automatically verifies each distinct nondeleted commit tip being pushed, including branches other than the checked-out branch. It tests committed content from `git archive`; uncommitted files do not enter the run. A nonzero result blocks the push. Each run starts the dedicated VM and stops it when finished. Concurrent runs fail instead of sharing a mutable VM. Every invocation reruns the checks; a previous success is not a cache.

Logs and JSON receipts live beneath `$(git rev-parse --git-common-dir)/jev-local-ci`. A receipt records the exact SHA, controller identity, actual execution platform, host platform, timestamps and exit code. A new commit requires a new run. Missing setup, isolation drift, a changed helper, a failed check or cleanup failure cannot produce success.

The hook is local to this clone and its linked worktrees. Web edits, other clones and bypassed hooks do not get automatic CI. This is developer-triggered local CI, not a GitHub Actions service or a server-side merge policy. Contributors on other machines can use `act` with the checked-in workflow and a suitable Docker environment, or run `node scripts/verify.mjs` directly; the supplied isolation controller currently targets Apple Silicon macOS.

## Isolation, cleanup and recovery

[Lima plain mode](https://lima-vm.io/docs/config/plain/) disables host mounts and port forwarding. This VM also disables SSH key/agent and proxy-environment forwarding. It uses TCP SSH with `ssh.overVsock: false`; the tested Lima 2.2.1 vsock listener failed to reconnect after a VM restart. Only an exact source archive enters the guest. The job container gets no Docker socket, host directories, GitHub/Jev credentials or inherited environment. It uses bridge networking for public npm downloads, a read-only empty secrets configuration, dropped capabilities and a per-job time limit. No provider inference occurs.

Install controllers only from reviewed source. The reusable VM is for reviewed maintainer commits. Untrusted fork contributions are not automatically admitted. Network access is not a hostile-code sandbox guarantee. The VM image and toolchain are retained local dependencies; per-run archives, dependency folders, containers and job volumes are removed. The reusable `act-toolcache` Docker volume is retained with the toolchain. Run logs and receipts remain on the host. The VM is stopped after runs so it does not reserve memory while idle.

If the controller was killed before cleanup, inspect the PID in the host lock at `~/.lima/jev-plugin-ci/controller.lock` and confirm that no run remains before removing that exact stale lock. Start the dedicated VM to inspect any interrupted job before a retry. Never clear another project's lock or prune its Docker resources. Rebuild only `jev-plugin-ci` from the setup above if its integrity is uncertain. Removing the installed `pre-push` hook disables this checkout's automatic check; preserve the receipts when uninstalling.

## GitHub-visible results and costs

`act` executes locally and does not use GitHub Actions minutes or its scheduler. GitHub's existing account lock remains unchanged. A maintainer may publish the observed result for an already-pushed SHA using GitHub's [commit-status API](https://docs.github.com/en/rest/commits/statuses), with a distinct context such as `local-ci / act Linux ARM64` and a link to retained evidence. Publish failure on failure. Keep GitHub authentication on the host, outside the guest. A local status is not an official Actions run, marketplace approval or a decision-quality benchmark.

The shared entrypoint installs locked dependencies with lifecycle scripts disabled, typechecks, verifies retained bundle bytes, runs runtime tests, validates manifests and generated package parity, and runs build, distribution, contract and local-controller regressions. It fails on stale bundles instead of silently repairing them. Direct development runs create `source/jev-workflows/node_modules`; remove that owned disposable directory when no longer needed. Committed runtime bundles and host packages are retained release assets.
