# Verify Jev Workflows

The repository contains one shared engine and generated Codex and Claude Code packages. Both products use the name **Jev Workflows** and the stable plugin ID `jev-workflows`. The existing `jev-codex-plugin` repository URL is retained for compatibility with installed marketplaces and public links.

## Run the same checks locally and in Actions

Use Node.js 22+ and npm, then run from the repository root:

```sh
node scripts/verify.mjs
```

The command installs locked dependencies with lifecycle scripts disabled, typechecks, builds, runs the source tests, validates manifests, and checks generated package identity and byte parity. It then runs the distribution and shared-contract regression tests, including deliberate Claude identifier and display-name drift. Any failed step stops verification with a nonzero exit code.

The GitHub workflow calls this same entrypoint on Node 22. Local checks print their actual Node version, operating system and architecture. A local macOS result does not establish that the Linux Actions job ran. Neither path needs Jev or GitHub credentials or makes provider inference calls. Native host/provider QA is a separate release check recorded in [VERIFICATION.md](../VERIFICATION.md).

The dependency directory `source/jev-workflows/node_modules` is rebuildable. Remove it after a disposable verification run when no other process owns it. Built runtime bundles and generated host packages are retained release assets. The entrypoint does not regenerate the host packages, so stale committed distributions fail instead of silently being repaired.

## GitHub account locks and external results

GitHub may reject Actions before a runner starts when the repository owner's account has a billing lock. A workflow edit or runner change does not clear that account restriction. Resolve it through [GitHub's locked-account guidance](https://docs.github.com/en/billing/how-tos/troubleshooting/locked-account). Keep these infrastructure failures visible and distinguish them from failing tests.

While Actions is unavailable, a maintainer can run this entrypoint in a clean, reviewed checkout of an exact commit and publish the observed outcome with GitHub's [commit-status API](https://docs.github.com/en/rest/commits/statuses). Use a separate context such as `local-ci / Node 22 macOS`, include the actual platform in the description, and link the retained verification evidence. Publish failure on failure; do not replace or spoof the Actions `test` check. Recheck the PR head before attaching a result; a new push needs a new run.

Use only reviewed code on a personal machine. A temporary checkout is not a security sandbox. Untrusted public contributions need a disposable isolated machine without host mounts or account credentials. This repository does not install a persistent self-hosted runner, polling daemon or automatic status publisher. The hosted workflow remains configured for when account access is restored.
