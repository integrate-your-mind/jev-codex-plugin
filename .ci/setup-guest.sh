#!/usr/bin/env bash
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends docker.io ca-certificates curl git
systemctl enable --now docker
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
curl --fail --silent --show-error --location https://github.com/nektos/act/releases/download/v0.2.89/act_Linux_arm64.tar.gz --output "$work/act.tar.gz"
printf '%s  %s\n' daa8679ba9615a74d2d0cec321dc593f21948a2a11bb65862b063d8b930f4bcb "$work/act.tar.gz" | sha256sum --check -
tar -xzf "$work/act.tar.gz" -C "$work" act
install -m 755 "$work/act" /usr/local/bin/act
act --version
docker pull node@sha256:dd5847a04b0deee391fa145f1f4c6d214196668b6bcc7988ebed67249f226844
docker image inspect node@sha256:dd5847a04b0deee391fa145f1f4c6d214196668b6bcc7988ebed67249f226844 --format '{{json .RepoDigests}}'
