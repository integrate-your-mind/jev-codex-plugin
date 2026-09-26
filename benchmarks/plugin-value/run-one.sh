#!/bin/sh
set -eu

if [ "$#" -ne 3 ]; then
  echo "usage: $0 baseline|treatment preflight|score JOB_NAME" >&2
  exit 2
fi

arm=$1
mode=$2
job_name=$3
case "$arm" in baseline|treatment) ;; *) echo "invalid arm: $arm" >&2; exit 2 ;; esac
case "$mode" in preflight|score) ;; *) echo "invalid mode: $mode" >&2; exit 2 ;; esac

: "${PIER_RUNTIME:?set PIER_RUNTIME to the pinned Pier virtual environment}"
: "${DEEPSWE_TASKS:?set DEEPSWE_TASKS to the pinned DeepSWE tasks directory}"
: "${JOBS_DIR:?set JOBS_DIR to a private absolute output directory}"

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
python_bin=${PYTHON_BIN:-/opt/homebrew/bin/python3.12}
site_packages="$PIER_RUNTIME/lib/python3.12/site-packages"

set -- run \
  --path "$DEEPSWE_TASKS" \
  --include-task-name ipython-session-bundle-replay \
  --agent-import-path runtime:PluginValueCodex \
  --model gpt-6-astra \
  --agent-kwarg arm="$arm" \
  --agent-kwarg version=0.155.0 \
  --agent-kwarg reasoning_effort=medium \
  --agent-kwarg preflight_only="$( [ "$mode" = preflight ] && echo true || echo false )" \
  --agent-kwarg turn_timeout_ms=10700000 \
  --environment-import-path runtime:PluginValueDockerEnvironment \
  --n-concurrent 1 \
  --n-attempts 1 \
  --max-retries 0 \
  --job-name "$job_name" \
  --jobs-dir "$JOBS_DIR" \
  --delete

if [ "$mode" = preflight ]; then
  set -- "$@" --disable-verification
fi

PYTHONPATH="$script_dir:$site_packages${PYTHONPATH:+:$PYTHONPATH}" \
  "$python_bin" "$script_dir/pier-main.py" "$@"

