#!/bin/sh
set -eu
PATH=/usr/bin:/bin:/usr/sbin:/sbin
export PATH

if [ "$#" -ne 4 ]; then
  echo "usage: $0 baseline|treatment preflight|score TASK_ID JOB_NAME" >&2
  exit 2
fi

arm=$1
mode=$2
task_id=$3
job_name=$4
case "$arm" in baseline|treatment) ;; *) echo "invalid arm: $arm" >&2; exit 2 ;; esac
case "$mode" in preflight|score) ;; *) echo "invalid mode: $mode" >&2; exit 2 ;; esac
case "$task_id" in
  ''|*[!a-z0-9-]*|-*|*-) echo "invalid task id: $task_id" >&2; exit 2 ;;
esac
case "$job_name" in
  ''|[!A-Za-z0-9]*|*[!A-Za-z0-9._-]*|.|..) echo "invalid job name: $job_name" >&2; exit 2 ;;
esac

: "${PIER_RUNTIME:?set PIER_RUNTIME to the pinned Pier virtual environment}"
: "${DEEPSWE_TASKS:?set DEEPSWE_TASKS to the pinned DeepSWE tasks directory}"
: "${JOBS_DIR:?set JOBS_DIR to a private absolute output directory}"
: "${PLUGIN_VALUE_RUNTIME_BUNDLE:?set PLUGIN_VALUE_RUNTIME_BUNDLE to the frozen linux/amd64 runtime directory}"
: "${PLUGIN_VALUE_TMPDIR:?set PLUGIN_VALUE_TMPDIR to an absolute operational temporary directory}"
: "${PLUGIN_VALUE_HOST_NODE:?set PLUGIN_VALUE_HOST_NODE to the frozen host Node executable}"
: "${PLUGIN_VALUE_HOST_CODEX:?set PLUGIN_VALUE_HOST_CODEX to the frozen host Codex executable}"
: "${PLUGIN_VALUE_HOST_DOCKER:?set PLUGIN_VALUE_HOST_DOCKER to the frozen host Docker executable}"

for absolute_path in "$PIER_RUNTIME" "$DEEPSWE_TASKS" "$JOBS_DIR" "$PLUGIN_VALUE_RUNTIME_BUNDLE" "$PLUGIN_VALUE_TMPDIR" "$PLUGIN_VALUE_HOST_NODE" "$PLUGIN_VALUE_HOST_CODEX" "$PLUGIN_VALUE_HOST_DOCKER"; do
  case "$absolute_path" in /*) ;; *) echo "benchmark paths must be absolute: $absolute_path" >&2; exit 2 ;; esac
done

script_dir=$(CDPATH= cd -- "$(/usr/bin/dirname "$0")" && pwd)
python_bin="$PIER_RUNTIME/bin/python"
site_packages="$PIER_RUNTIME/lib/python3.12/site-packages"
image_identity_path=${PLUGIN_VALUE_IMAGE_IDENTITY_PATH:-"$script_dir/image-identities.json"}
runtime_identity_path="$script_dir/runtime-identity.json"
task_metadata_path="$script_dir/task-runtime-metadata.json"
schedule_path="$script_dir/schedule.json"

clean_python() {
  /usr/bin/env -u PYTHONPATH -u PYTHONHOME \
    PYTHONNOUSERSITE=1 PYTHONSAFEPATH=1 "$python_bin" -I -S -B "$@"
}

case "$image_identity_path" in /*) ;; *) echo "image identity path must be absolute" >&2; exit 2 ;; esac
[ -f "$image_identity_path" ] || { echo "image identity ledger not found" >&2; exit 2; }
[ -f "$runtime_identity_path" ] || { echo "runtime identity not found" >&2; exit 2; }
[ -f "$task_metadata_path" ] || { echo "task runtime metadata not found" >&2; exit 2; }
[ -f "$schedule_path" ] || { echo "schedule not found" >&2; exit 2; }
[ -x "$python_bin" ] || { echo "pinned Pier Python not found" >&2; exit 2; }
[ -d "$PLUGIN_VALUE_RUNTIME_BUNDLE" ] || { echo "shared runtime bundle not found" >&2; exit 2; }
[ -d "$PLUGIN_VALUE_TMPDIR" ] || { echo "operational temporary directory not found" >&2; exit 2; }

clean_python "$script_dir/runtime.py" validate-bootstrap \
    "$PIER_RUNTIME" "$runtime_identity_path" "$script_dir/runtime.py" \
    "$script_dir/pier-main.py" "$script_dir/run-one.sh" \
    "$PLUGIN_VALUE_TMPDIR" "$JOBS_DIR" \
    "$DEEPSWE_TASKS" "$PLUGIN_VALUE_RUNTIME_BUNDLE"

image_identity_sha256=$(
  clean_python -c \
    'import json,sys; d=json.load(open(sys.argv[1], encoding="utf-8")); print(d["dataset"]["imageIdentityLedgerSha256"])' \
    "$runtime_identity_path"
)
task_metadata_sha256=$(
  clean_python -c \
    'import json,sys; d=json.load(open(sys.argv[1], encoding="utf-8")); print(d["dataset"]["taskRuntimeMetadataSha256"])' \
    "$runtime_identity_path"
)
schedule_sha256=$(
  clean_python -c \
    'import json,sys; d=json.load(open(sys.argv[1], encoding="utf-8")); print(d["dataset"]["scheduleSha256"])' \
    "$runtime_identity_path"
)
host_node_sha256=$(
  clean_python -c \
    'import json,sys; d=json.load(open(sys.argv[1], encoding="utf-8")); v=d["hostRuntime"]["node"].get("sha256"); isinstance(v, str) or sys.exit("host Node identity is not frozen"); print(v)' \
    "$runtime_identity_path"
)
host_codex_sha256=$(
  clean_python -c \
    'import json,sys; d=json.load(open(sys.argv[1], encoding="utf-8")); v=d["hostRuntime"]["codex"].get("sha256"); isinstance(v, str) or sys.exit("host Codex identity is not frozen"); print(v)' \
    "$runtime_identity_path"
)
host_docker_sha256=$(
  clean_python -c \
    'import json,sys; d=json.load(open(sys.argv[1], encoding="utf-8")); v=d["hostRuntime"]["docker"].get("sha256"); isinstance(v, str) or sys.exit("host Docker identity is not frozen"); print(v)' \
    "$runtime_identity_path"
)
host_runner_sha256=$(
  clean_python -c \
    'import json,sys; d=json.load(open(sys.argv[1], encoding="utf-8")); v=d["hostRuntime"]["runner"].get("sha256"); isinstance(v, str) or sys.exit("host runner identity is not frozen"); print(v)' \
    "$runtime_identity_path"
)

if [ "$mode" = score ]; then
  clean_python -c \
    'import json,sys; d=json.load(open(sys.argv[1], encoding="utf-8")); raise SystemExit(0 if d.get("executionReady") is True else "runtime identity is not ready for scored execution")' \
    "$runtime_identity_path"
fi

runtime_manifest_sha256=$(
  clean_python -c \
    'import json,sys; d=json.load(open(sys.argv[1], encoding="utf-8")); v=d["sharedRuntime"].get("manifestSha256"); isinstance(v, str) or sys.exit("runtime manifest identity is not frozen"); print(v)' \
    "$runtime_identity_path"
)
runtime_tree_sha256=$(
  clean_python -c \
    'import json,sys; d=json.load(open(sys.argv[1], encoding="utf-8")); v=d["sharedRuntime"].get("treeSha256"); isinstance(v, str) or sys.exit("runtime tree identity is not frozen"); print(v)' \
    "$runtime_identity_path"
)

launcher_root="$PLUGIN_VALUE_TMPDIR/plugin-value-launcher-$job_name-$$"
launcher_bin="$launcher_root/bin"
pycache_prefix="$launcher_root/pycache"
umask 077
/bin/mkdir "$launcher_root"
/bin/mkdir "$launcher_bin" "$pycache_prefix"
/bin/ln -s "$PLUGIN_VALUE_HOST_DOCKER" "$launcher_bin/docker"
cleanup_launcher_bin() {
  /bin/rm -f "$launcher_bin/docker"
  /bin/rmdir "$launcher_bin" 2>/dev/null || true
  /bin/rmdir "$pycache_prefix" 2>/dev/null || true
  /bin/rmdir "$launcher_root" 2>/dev/null || true
}
trap cleanup_launcher_bin 0 1 2 15
PATH="$launcher_bin:/usr/bin:/bin:/usr/sbin:/sbin"
export PATH

validated_inputs=$(PLUGIN_VALUE_PINNED_SITE_PACKAGES="$site_packages" \
PLUGIN_VALUE_ADAPTER_PATH="$script_dir/runtime.py" \
  clean_python -X "pycache_prefix=$pycache_prefix" \
    "$script_dir/pier-main.py" validate-inputs \
    "$DEEPSWE_TASKS" "$task_metadata_path" "$task_metadata_sha256" \
    "$task_id" "$mode" "$arm" "$job_name" "$schedule_path" "$schedule_sha256")
expected_base_commit=$(
  clean_python -c \
    'import json,re,sys; d=json.loads(sys.argv[1]); v=d.get("baseCommitHash"); isinstance(v,str) and re.fullmatch(r"[0-9a-f]{40}",v) or sys.exit("task base commit is not frozen"); print(v)' \
    "$validated_inputs"
)

set -- run \
  --path "$DEEPSWE_TASKS" \
  --include-task-name "$task_id" \
  --n-tasks 1 \
  --agent-import-path plugin_value_runtime:PluginValueCodex \
  --model gpt-6-astra \
  --agent-kwarg arm="$arm" \
  --agent-kwarg version=0.155.0 \
  --agent-kwarg reasoning_effort=medium \
  --agent-kwarg preflight_only="$( [ "$mode" = preflight ] && echo true || echo false )" \
  --agent-kwarg turn_timeout_ms=10700000 \
  --agent-kwarg host_node_path="$PLUGIN_VALUE_HOST_NODE" \
  --agent-kwarg host_codex_path="$PLUGIN_VALUE_HOST_CODEX" \
  --agent-kwarg host_docker_path="$PLUGIN_VALUE_HOST_DOCKER" \
  --agent-kwarg host_node_sha256="$host_node_sha256" \
  --agent-kwarg host_codex_sha256="$host_codex_sha256" \
  --agent-kwarg host_docker_sha256="$host_docker_sha256" \
  --agent-kwarg host_runner_sha256="$host_runner_sha256" \
  --environment-import-path plugin_value_runtime:PluginValueDockerEnvironment \
  --environment-kwarg shared_runtime_dir="$PLUGIN_VALUE_RUNTIME_BUNDLE" \
  --environment-kwarg runtime_manifest_sha256="$runtime_manifest_sha256" \
  --environment-kwarg runtime_tree_sha256="$runtime_tree_sha256" \
  --environment-kwarg image_identity_path="$image_identity_path" \
  --environment-kwarg image_identity_sha256="$image_identity_sha256" \
  --environment-kwarg expected_task_id="$task_id" \
  --environment-kwarg expected_base_commit="$expected_base_commit" \
  --environment-kwarg execution_mode="$mode" \
  --environment-kwarg host_docker_path="$PLUGIN_VALUE_HOST_DOCKER" \
  --environment-kwarg host_docker_sha256="$host_docker_sha256" \
  --n-concurrent 1 \
  --n-attempts 1 \
  --max-retries 0 \
  --job-name "$job_name" \
  --jobs-dir "$JOBS_DIR" \
  --delete

if [ "$mode" = preflight ]; then
  set -- "$@" --disable-verification
fi

TMPDIR="$PLUGIN_VALUE_TMPDIR" \
PLUGIN_VALUE_PINNED_SITE_PACKAGES="$site_packages" \
PLUGIN_VALUE_ADAPTER_PATH="$script_dir/runtime.py" \
  /usr/bin/env -u PYTHONPATH -u PYTHONHOME \
    PYTHONDONTWRITEBYTECODE=1 PYTHONNOUSERSITE=1 PYTHONSAFEPATH=1 \
    "$python_bin" -I -S -B -X "pycache_prefix=$pycache_prefix" \
    "$script_dir/pier-main.py" "$@"
