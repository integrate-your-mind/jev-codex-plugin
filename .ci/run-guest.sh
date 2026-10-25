#!/usr/bin/env bash
set -euo pipefail
[[ $# == 1 && $1 =~ ^[a-f0-9]{40}$ ]] || { printf 'Expected an exact commit SHA\n' >&2; exit 2; }
sha=$1
work=$(mktemp -d /var/tmp/jev-ci.XXXXXXXX)
label="dev.jev.local-ci=$sha"
cleanup() {
  status=$?
  trap - EXIT
  set +e
  containers=$(docker ps -aq --filter "label=$label")
  if [[ -n "$containers" ]]; then
    volumes=$(docker inspect --format '{{range .Mounts}}{{if eq .Type "volume"}}{{println .Name}}{{end}}{{end}}' $containers)
    docker rm -fv $containers >/dev/null || status=1
    if [[ -n "$volumes" ]]; then docker volume rm $volumes >/dev/null || status=1; fi
  fi
  rm -rf -- "$work" || status=1
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
mkdir "$work/source" "$work/home"
tar --extract --file - --directory "$work/source" --no-same-owner
export HOME="$work/home"
export XDG_CONFIG_HOME="$work/home/config"
export XDG_CACHE_HOME="$work/home/cache"
cd "$work/source"
printf '{"after":"%s","ref":"refs/heads/local-ci","repository":{"full_name":"integrate-your-mind/jev-codex-plugin","default_branch":"main"}}\n' "$sha" > "$work/event.json"
printf 'Local Actions commit %s; act 0.2.89; Linux ARM64; Node 22.23.2\n' "$sha"
timeout --signal=TERM --kill-after=20s 16m act push \
  --job test --workflows .ci/verify.yml --directory "$work/source" \
  --eventpath "$work/event.json" \
  --platform jev-local=node@sha256:dd5847a04b0deee391fa145f1f4c6d214196668b6bcc7988ebed67249f226844 \
  --container-architecture linux/arm64 --pull=false --action-offline-mode \
  --container-daemon-socket=- --network bridge --container-cap-drop ALL \
  --container-options "--label $label --security-opt no-new-privileges --memory 2g --cpus 2" \
  --secret-file /dev/null --env-file /dev/null --var-file /dev/null --input-file /dev/null \
  --secret GITHUB_TOKEN= --no-cache-server --concurrent-jobs 1 \
  --action-cache-path "$work/actions" --rm
