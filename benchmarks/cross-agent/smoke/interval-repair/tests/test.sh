#!/bin/sh
set -u

logs_dir="${HARBOR_VERIFIER_LOG_DIR:-/logs/verifier}"
artifacts_dir="${HARBOR_ARTIFACTS_DIR:-/logs/artifacts}"
tests_dir="${HARBOR_TESTS_DIR:-/tests}"
mkdir -p "$logs_dir" || exit 1
printf '0\n' > "$logs_dir/reward.txt" || exit 1

work_dir="$(mktemp -d "${TMPDIR:-/tmp}/jev-smoke-verifier.XXXXXX")" || exit 1
cleanup() { rm -rf "$work_dir"; }
trap cleanup EXIT HUP INT TERM

if [ ! -f "$artifacts_dir/solution.mjs" ]; then
  printf '%s\n' 'missing collected solution.mjs' > "$logs_dir/grader.stderr.log"
  exit 1
fi
cp "$artifacts_dir/solution.mjs" "$work_dir/solution.mjs" || exit 1

if (cd "$work_dir" && node "$tests_dir/grade.mjs" "interval-repair")   > "$logs_dir/grader.stdout.log" 2> "$logs_dir/grader.stderr.log"; then
  printf '1\n' > "$logs_dir/reward.txt"
  exit 0
fi
exit 1
