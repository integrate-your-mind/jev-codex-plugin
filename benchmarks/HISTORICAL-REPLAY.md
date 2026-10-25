# Reproduce the published historical evidence

The benchmark records in this PR describe the source frozen before the 0.5.1 cross-host release. Run the current plugin checks on the current branch with `node scripts/verify.mjs`. That verifier also runs the four portable comparison-contract test files.

The batch and explicit-outcome studies require the original 0.4.0 source, lockfile and manifest hashes. Their rejection of the current 0.5.1 source is expected. Do not regenerate their freezes to make those checks pass.

Create a durable Git worktree at the published historical revision `c548d0b09aef8d948f9932d4114ab1921ed47ef4`, on an owned verification branch. Install its lockfile dependencies with `npm ci --ignore-scripts` from `source/jev-workflows`. Use checksum-verified Node.js 22.23.2 for the historical checks. Keep that checkout and its temporary files in the owned workspace.

Set `TMPDIR` to an existing `.agent-work/test-tmp` directory inside that checkout. Set `GIT_CEILING_DIRECTORIES` to the same absolute path. This prevents `git apply` in a materialized child tree from discovering the outer worktree and silently skipping the historical patch. Git commands run from the historical repository itself can still resolve the original base commit.

For example, from the historical checkout, with the pinned Node executable first on `PATH`:

```sh
mkdir -p .agent-work/test-tmp
export TMPDIR="$PWD/.agent-work/test-tmp"
export GIT_CEILING_DIRECTORIES="$TMPDIR"
export NODE22_BIN="$(command -v node)"
/usr/bin/sandbox-exec -p '(version 1) (allow default) (deny network*)' \
  node --import ./source/jev-workflows/node_modules/tsx/dist/loader.mjs \
  --test --test-concurrency=2 \
  benchmarks/plugin-development/batch/*.test.mjs \
  benchmarks/plugin-development/experiment/*.test.mjs \
  benchmarks/plugin-development/explicit-outcomes/run.test.ts
```

The macOS sandbox denies network access. These are authored fixture and transport-contract regressions. They do not invoke Jev, a coding model or a new scored benchmark, and they do not establish a task-quality improvement. On another host, use an equivalent network-denied execution environment.

The source reconstruction, receipt exports and outcome storage checks must pass without changing the frozen manifests, patches, variants or published result rows. The dependency versions and historical source are distinct from validation of the current plugin.
