"""Pier adapter for the paired Jev/Codex DeepSWE benchmark.

The model API and Jev plugin stay in a host-side Codex app-server.  Pier's task
container only runs Codex's unauthenticated exec-server over ``docker exec``.
This keeps reusable credentials outside the repository-under-test while
preserving the native Codex command, patch, hook, and MCP paths.
"""

from __future__ import annotations

import asyncio
import base64
import csv
import hashlib
import importlib.metadata
import json
import os
import platform
import re
import shlex
import shutil
import signal
import stat
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from pathlib import PurePosixPath
from typing import Any, Mapping

PINNED_CODEX_VERSION = "0.155.0"
PINNED_NODE_VERSION = "22.23.2"
PINNED_DOCKER_VERSION = "29.7.1"
PINNED_MODEL = "gpt-6-astra"
PINNED_EFFORT = "medium"
RUNTIME_MANIFEST_SCHEMA = "plugin-value-shared-runtime-v1"
RUNTIME_MOUNT = PurePosixPath("/opt/jev-codex-runtime")
RUNTIME_MANIFEST_NAME = "runtime-manifest.json"
IMAGE_LEDGER_SCHEMA = "jev-plugin-value-image-identities-v1"
_CONTAINER_ID = re.compile(r"^[0-9a-f]{12,64}$")
_CONTAINER_USER = re.compile(r"^[A-Za-z0-9_.:-]{1,128}$")
_TRIAL_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
_SHA256 = re.compile(r"^[0-9a-f]{64}$")
_SHA256_DIGEST = re.compile(r"^sha256:[0-9a-f]{64}$")
_FROZEN_TASK_IDS = frozenset(
    {
        "adaptix-name-mapping-aliases",
        "anko-default-function-arguments",
        "csstree-shorthand-expansion-compression",
        "expr-try-catch-errors",
        "fd-deterministic-multi-key-sorting",
        "geo-shapeindex-serialization",
        "ipython-session-bundle-replay",
        "katex-multicolumn-array-spans",
        "kea-atomic-signal-selectors",
        "kgateway-consistent-hash-policy",
        "koota-entity-snapshot-rollback",
        "mashumaro-flattened-dataclass-fields",
        "obsidian-linter-link-format-conversion",
        "oxvg-structural-selector-preservation",
        "query-persist-restored-query-state",
        "skrub-duration-encoding",
        "sql-formatter-bigquery-pipe-formatting",
        "task-task-graph-export",
        "testem-bail-on-test-failure",
        "yaegi-go-embed-directives",
    }
)
_KOOTA_TASK_ID = "koota-entity-snapshot-rollback"
_KOOTA_UPSTREAM_BASE_COMMIT = "72ebef44b8e024d877250f055eea60cdfaa4506"
_KOOTA_EFFECTIVE_BASE_COMMIT = "72ebef44b8e024d877250f055eea60cdfaa45069"
_KOOTA_TASK_TOML_BLOB = "e290a79944e6a2dece881820818a01cf4b34be60"
_KOOTA_TASK_TOML_SHA256 = (
    "11444ab835894c82a89dce7232632d74cc2ec15cc23047c045dfb931b22d50b1"
)
_KOOTA_COMMIT_API = (
    "https://api.github.com/repos/pmndrs/koota/commits/"
    f"{_KOOTA_UPSTREAM_BASE_COMMIT}"
)
_KOOTA_AUDIT_ISSUE = "https://github.com/datacurve-ai/deep-swe/issues/52"


@dataclass(frozen=True)
class RuntimeExecutable:
    path: PurePosixPath
    version: str
    sha256: str


@dataclass(frozen=True)
class SharedRuntimeIdentity:
    root: Path
    manifest_sha256: str
    tree_sha256: str
    codex: RuntimeExecutable
    node: RuntimeExecutable


@dataclass(frozen=True)
class TaskImageIdentity:
    task_id: str
    tagged_image: str
    pinned_image: str
    manifest_digest: str


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _json_object(path: Path, *, label: str) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ValueError(f"invalid {label}: {path}") from exc
    if not isinstance(value, dict):
        raise ValueError(f"{label} must be a JSON object")
    return value


def _absolute_path(value: str | os.PathLike[str], *, label: str) -> Path:
    path = Path(value)
    if not path.is_absolute():
        raise ValueError(f"{label} must be an absolute path")
    try:
        return path.resolve(strict=True)
    except OSError as exc:
        raise ValueError(f"{label} does not exist: {path}") from exc


def _safe_relative_path(value: Any, *, label: str) -> PurePosixPath:
    if not isinstance(value, str) or not value:
        raise ValueError(f"{label} must be a non-empty relative path")
    path = PurePosixPath(value)
    if path.is_absolute() or path == PurePosixPath(".") or ".." in path.parts:
        raise ValueError(f"{label} must stay within the runtime bundle")
    if path.as_posix() != value:
        raise ValueError(f"{label} must be a normalized POSIX path")
    return path


def _require_inside(root: Path, path: Path, *, label: str) -> Path:
    try:
        resolved = path.resolve(strict=True)
    except OSError as exc:
        raise ValueError(f"{label} does not exist: {path}") from exc
    if resolved != root and root not in resolved.parents:
        raise ValueError(f"{label} resolves outside its containing directory")
    return resolved


def _paths_overlap(left: Path, right: Path) -> bool:
    """Return whether either resolved path contains the other."""

    left = left.resolve(strict=False)
    right = right.resolve(strict=False)
    return left == right or left in right.parents or right in left.parents


def _posix_paths_overlap(left: PurePosixPath, right: PurePosixPath) -> bool:
    return left == right or left in right.parents or right in left.parents


def _tree_sha256(root: Path) -> str:
    """Hash paths, modes, symlink targets, and file bytes below ``root``.

    The manifest is excluded so it can carry the resulting tree digest.  This
    is a benchmark-specific content identity, not an OCI filesystem digest.
    """

    digest = hashlib.sha256()
    entries = sorted(root.rglob("*"), key=lambda item: item.relative_to(root).as_posix())
    for entry in entries:
        relative = entry.relative_to(root).as_posix()
        if relative == RUNTIME_MANIFEST_NAME:
            continue
        metadata = entry.lstat()
        mode = stat.S_IMODE(metadata.st_mode)
        if stat.S_ISLNK(metadata.st_mode):
            target = os.readlink(entry)
            _require_inside(root, entry, label=f"runtime symlink {relative}")
            record = f"L\0{relative}\0{mode:o}\0{target}\n"
        elif stat.S_ISDIR(metadata.st_mode):
            record = f"D\0{relative}\0{mode:o}\n"
        elif stat.S_ISREG(metadata.st_mode):
            record = f"F\0{relative}\0{mode:o}\0{_sha256_file(entry)}\n"
        else:
            raise ValueError(f"runtime bundle contains unsupported entry: {relative}")
        digest.update(record.encode("utf-8"))
    return digest.hexdigest()


def _assert_immutable_bundle(root: Path, manifest_path: Path) -> None:
    for entry in (root, manifest_path, *root.rglob("*")):
        metadata = entry.lstat()
        if stat.S_ISLNK(metadata.st_mode):
            continue
        if stat.S_IMODE(metadata.st_mode) & 0o222:
            relative = "." if entry == root else entry.relative_to(root).as_posix()
            raise ValueError(f"runtime bundle entry is writable: {relative}")


def _runtime_executable(
    root: Path,
    executables: Mapping[str, Any],
    name: str,
    expected_version: str,
) -> RuntimeExecutable:
    value = executables.get(name)
    if not isinstance(value, dict) or set(value) != {"path", "version", "sha256"}:
        raise ValueError(f"runtime manifest {name} entry has an invalid shape")
    path = _safe_relative_path(value["path"], label=f"runtime {name} path")
    version = value["version"]
    checksum = value["sha256"]
    if version != expected_version:
        raise ValueError(f"runtime {name} version must be {expected_version}")
    if not isinstance(checksum, str) or not _SHA256.fullmatch(checksum):
        raise ValueError(f"runtime {name} sha256 is invalid")

    executable_path = root.joinpath(*path.parts)
    resolved = _require_inside(root, executable_path, label=f"runtime {name}")
    if not resolved.is_file() or not os.access(executable_path, os.X_OK):
        raise ValueError(f"runtime {name} is not an executable file")
    if _sha256_file(executable_path) != checksum:
        raise ValueError(f"runtime {name} sha256 mismatch")
    return RuntimeExecutable(path=path, version=version, sha256=checksum)


def validate_shared_runtime(value: str | os.PathLike[str]) -> SharedRuntimeIdentity:
    root = _absolute_path(value, label="shared_runtime_dir")
    if not root.is_dir():
        raise ValueError("shared_runtime_dir must be a directory")
    manifest_path = root / RUNTIME_MANIFEST_NAME
    if manifest_path.is_symlink() or not manifest_path.is_file():
        raise ValueError("runtime manifest must be a regular file")
    manifest = _json_object(manifest_path, label="runtime manifest")
    expected_keys = {"schemaVersion", "platform", "treeSha256", "executables"}
    if set(manifest) != expected_keys:
        raise ValueError("runtime manifest has unexpected or missing fields")
    if manifest["schemaVersion"] != RUNTIME_MANIFEST_SCHEMA:
        raise ValueError("runtime manifest schema is not supported")
    if manifest["platform"] != "linux/amd64":
        raise ValueError("runtime bundle platform must be linux/amd64")
    tree_checksum = manifest["treeSha256"]
    if not isinstance(tree_checksum, str) or not _SHA256.fullmatch(tree_checksum):
        raise ValueError("runtime treeSha256 is invalid")
    executables = manifest["executables"]
    if not isinstance(executables, dict) or set(executables) != {"codex", "node"}:
        raise ValueError("runtime manifest must contain only codex and node executables")

    codex = _runtime_executable(root, executables, "codex", PINNED_CODEX_VERSION)
    node = _runtime_executable(root, executables, "node", PINNED_NODE_VERSION)
    observed_tree_checksum = _tree_sha256(root)
    if observed_tree_checksum != tree_checksum:
        raise ValueError("runtime bundle treeSha256 mismatch")
    _assert_immutable_bundle(root, manifest_path)
    return SharedRuntimeIdentity(
        root=root,
        manifest_sha256=_sha256_file(manifest_path),
        tree_sha256=tree_checksum,
        codex=codex,
        node=node,
    )


def _load_image_identities(
    value: str | os.PathLike[str],
    *,
    expected_sha256: str,
    require_execution_ready: bool,
) -> dict[str, TaskImageIdentity]:
    ledger_path = _absolute_path(value, label="image_identity_path")
    if not ledger_path.is_file():
        raise ValueError("image_identity_path must be a file")
    if not _SHA256.fullmatch(expected_sha256):
        raise ValueError("image_identity_sha256 is invalid")
    if _sha256_file(ledger_path) != expected_sha256:
        raise ValueError("image identity ledger sha256 mismatch")
    ledger = _json_object(ledger_path, label="image identity ledger")
    if ledger.get("schemaVersion") != IMAGE_LEDGER_SCHEMA:
        raise ValueError("image identity ledger schema is not supported")
    if not isinstance(ledger.get("executionReady"), bool):
        raise ValueError("image identity ledger executionReady must be boolean")
    if require_execution_ready and ledger["executionReady"] is not True:
        raise ValueError("image identity ledger is not ready for scored execution")
    checks = ledger.get("checks")
    required_checks = (
        "allHttp200",
        "allHeaderBodySha256Parity",
        "allSingleManifest",
        "allLinuxAmd64",
    )
    if not isinstance(checks, dict) or any(checks.get(key) is not True for key in required_checks):
        raise ValueError("image identity ledger checks are incomplete")
    images = ledger.get("images")
    if not isinstance(images, list) or len(images) != len(_FROZEN_TASK_IDS):
        raise ValueError("image identity ledger must contain exactly 20 images")

    result: dict[str, TaskImageIdentity] = {}
    manifest_digests: set[str] = set()
    ledger_root = ledger_path.parent
    for item in images:
        if not isinstance(item, dict):
            raise ValueError("image identity ledger contains a non-object entry")
        task_id = item.get("taskId")
        repository = item.get("repository")
        tag = item.get("tag")
        tagged_image = item.get("image")
        manifest_digest = item.get("manifestDigest")
        body_digest = item.get("bodySha256")
        if not isinstance(task_id, str) or task_id in result:
            raise ValueError("image identity ledger task ids must be unique strings")
        if not isinstance(repository, str) or not repository:
            raise ValueError(f"image repository is invalid for {task_id}")
        if not isinstance(tag, str) or not tag or tagged_image != f"{repository}:{tag}":
            raise ValueError(f"tagged image is inconsistent for {task_id}")
        if not isinstance(manifest_digest, str) or not _SHA256_DIGEST.fullmatch(manifest_digest):
            raise ValueError(f"manifest digest is invalid for {task_id}")
        if manifest_digest in manifest_digests:
            raise ValueError(f"manifest digest is duplicated for {task_id}")
        manifest_digests.add(manifest_digest)
        if body_digest != manifest_digest or item.get("headerBodySha256Parity") is not True:
            raise ValueError(f"manifest digest evidence is inconsistent for {task_id}")
        if (
            item.get("httpStatus") != 200
            or item.get("schemaVersion") != 2
            or item.get("mediaType")
            != "application/vnd.docker.distribution.manifest.v2+json"
        ):
            raise ValueError(f"manifest response metadata is invalid for {task_id}")
        config_digest = item.get("configDigest")
        if not isinstance(config_digest, str) or not _SHA256_DIGEST.fullmatch(config_digest):
            raise ValueError(f"config digest is invalid for {task_id}")
        if item.get("os") != "linux" or item.get("architecture") != "amd64":
            raise ValueError(f"image platform is not linux/amd64 for {task_id}")

        artifact_relative = _safe_relative_path(
            item.get("manifestArtifact"), label=f"manifest artifact for {task_id}"
        )
        artifact = ledger_root.joinpath(*artifact_relative.parts)
        _require_inside(ledger_root, artifact, label=f"manifest artifact for {task_id}")
        if f"sha256:{_sha256_file(artifact)}" != manifest_digest:
            raise ValueError(f"manifest artifact sha256 mismatch for {task_id}")
        artifact_json = _json_object(artifact, label=f"manifest artifact for {task_id}")
        config = artifact_json.get("config")
        if (
            artifact_json.get("schemaVersion") != 2
            or artifact_json.get("mediaType") != item.get("mediaType")
            or not isinstance(config, dict)
            or config.get("digest") != config_digest
        ):
            raise ValueError(f"manifest artifact metadata mismatch for {task_id}")

        result[task_id] = TaskImageIdentity(
            task_id=task_id,
            tagged_image=tagged_image,
            pinned_image=f"{repository}@{manifest_digest}",
            manifest_digest=manifest_digest,
        )

    if set(result) != _FROZEN_TASK_IDS:
        raise ValueError("image identity ledger does not match the frozen 20-task set")
    return result


def _pin_task_image(
    task_env_config: Any,
    identity: TaskImageIdentity,
    *,
    separate_verifier: bool = False,
) -> Any:
    current_image = getattr(task_env_config, "docker_image", None)
    if separate_verifier:
        # Pier intentionally passes the explicit [verifier.environment]
        # resource config here.  Its missing image means "build the exact
        # tests/Dockerfile context"; injecting the agent image would silently
        # omit hidden tests and turn the verifier into a different execution.
        if current_image is not None:
            raise ValueError(
                "separate verifier must omit docker_image so Pier can build its tests context"
            )
    elif current_image not in {identity.tagged_image, identity.pinned_image}:
        raise ValueError(
            f"task image for {identity.task_id} does not match its frozen identity"
        )
    task_os = getattr(task_env_config, "os", None)
    task_os_value = getattr(task_os, "value", task_os)
    if task_os_value != "linux":
        raise ValueError(f"task OS for {identity.task_id} must be linux")
    model_copy = getattr(task_env_config, "model_copy", None)
    if not callable(model_copy):
        raise TypeError("task environment config does not support an immutable copy")
    if separate_verifier:
        return model_copy(deep=True, update={"docker_image": None})
    return model_copy(deep=True, update={"docker_image": identity.pinned_image})


def _validate_verifier_build_context(
    environment_dir: Path, identity: TaskImageIdentity
) -> str:
    """Bind a separate verifier's opaque tests context to the frozen base image."""

    dockerfile = environment_dir / "Dockerfile"
    if not dockerfile.is_file():
        raise ValueError("separate verifier Dockerfile is missing")
    try:
        lines = dockerfile.read_text(encoding="utf-8").splitlines()
    except (OSError, UnicodeError) as exc:
        raise ValueError("separate verifier Dockerfile is unreadable") from exc
    from_images = []
    for line in lines:
        match = re.match(r"^\s*FROM\s+([^\s]+)", line, flags=re.IGNORECASE)
        if match:
            from_images.append(match.group(1))
    if len(from_images) != 1:
        raise ValueError("separate verifier Dockerfile must have exactly one FROM image")
    base_image = from_images[0]
    if base_image not in {identity.tagged_image, identity.pinned_image}:
        raise ValueError("separate verifier base image does not match its frozen identity")
    return base_image


def _rewrite_verifier_build_context(
    source_dir: Path,
    destination_dir: Path,
    *,
    pinned_base_image: str,
) -> None:
    """Copy an opaque verifier context and rewrite only its validated FROM line."""

    if destination_dir.exists():
        raise RuntimeError("verifier build context already exists")
    try:
        shutil.copytree(source_dir, destination_dir, symlinks=True)
        source_dockerfile = source_dir / "Dockerfile"
        destination_dockerfile = destination_dir / "Dockerfile"
        original = source_dockerfile.read_text(encoding="utf-8")
        match = re.search(
            r"^(\s*FROM\s+)([^\s]+)(.*)$",
            original,
            flags=re.IGNORECASE | re.MULTILINE,
        )
        if match is None:
            raise ValueError("separate verifier Dockerfile has no FROM image")
        rewritten = (
            original[: match.start(2)]
            + pinned_base_image
            + original[match.end(2) :]
        )
        destination_dockerfile.write_text(rewritten, encoding="utf-8")
        destination_dockerfile.chmod(source_dockerfile.stat().st_mode & 0o7777)
    except Exception:
        shutil.rmtree(destination_dir, ignore_errors=True)
        raise


def _git_output(repository: Path, *arguments: str) -> str:
    git_path = shutil.which("git")
    if not git_path:
        raise ValueError("git is required to validate the frozen task checkout")
    try:
        completed = subprocess.run(
            [git_path, "-C", str(repository), *arguments],
            capture_output=True,
            text=True,
            timeout=30,
            check=False,
        )
    except subprocess.TimeoutExpired as exc:
        raise ValueError("frozen task checkout validation timed out") from exc
    if completed.returncode != 0:
        raise ValueError("frozen task checkout validation failed")
    return completed.stdout.strip()


def _validate_task_metadata_amendments(
    provenance: Mapping[str, Any], indexed_metadata: Mapping[str, Mapping[str, Any]]
) -> None:
    """Bind the one audited upstream metadata correction without rewriting its source."""

    expected_amendment = {
        "taskId": _KOOTA_TASK_ID,
        "field": "metadata.baseCommitHash",
        "kind": "expand-truncated-upstream-commit-id",
        "upstreamValue": _KOOTA_UPSTREAM_BASE_COMMIT,
        "effectiveValue": _KOOTA_EFFECTIVE_BASE_COMMIT,
        "upstreamTaskTomlBlob": _KOOTA_TASK_TOML_BLOB,
        "upstreamTaskTomlSha256": _KOOTA_TASK_TOML_SHA256,
        "resolution": {
            "repositoryCommitApi": _KOOTA_COMMIT_API,
            "upstreamAuditIssue": _KOOTA_AUDIT_ISSUE,
            "note": (
                "The pinned upstream task.toml remains unchanged and contains "
                "upstreamValue; GitHub resolves that unique truncated ID to "
                "effectiveValue."
            ),
        },
    }
    if provenance.get("metadataAmendments") != [expected_amendment]:
        raise ValueError("task runtime metadata amendment provenance is invalid")

    koota = indexed_metadata.get(_KOOTA_TASK_ID)
    koota_metadata = koota.get("metadata") if isinstance(koota, Mapping) else None
    if (
        not isinstance(koota_metadata, Mapping)
        or koota.get("taskTomlBlob") != _KOOTA_TASK_TOML_BLOB
        or koota.get("taskTomlSha256") != _KOOTA_TASK_TOML_SHA256
        or koota_metadata.get("baseCommitHashUpstream")
        != _KOOTA_UPSTREAM_BASE_COMMIT
        or koota_metadata.get("baseCommitHash") != _KOOTA_EFFECTIVE_BASE_COMMIT
    ):
        raise ValueError("Koota base-commit amendment does not match its frozen source")

    for task, task_metadata in indexed_metadata.items():
        details = task_metadata.get("metadata")
        if (
            task != _KOOTA_TASK_ID
            and isinstance(details, Mapping)
            and "baseCommitHashUpstream" in details
        ):
            raise ValueError("unexpected upstream base-commit amendment")


def validate_benchmark_inputs(
    *,
    tasks_dir: str | os.PathLike[str],
    task_metadata_path: str | os.PathLike[str],
    task_metadata_sha256: str,
    task_id: str,
    mode: str,
    arm: str,
    trial_id: str,
    schedule_path: str | os.PathLike[str] | None = None,
    schedule_sha256: str | None = None,
) -> dict[str, str]:
    """Bind a launch to the clean frozen checkout and, for score, its schedule row."""

    if mode not in {"preflight", "score"}:
        raise ValueError("mode must be preflight or score")
    if arm not in {"baseline", "treatment"}:
        raise ValueError("arm must be baseline or treatment")
    if task_id not in _FROZEN_TASK_IDS:
        raise ValueError("task is absent from the frozen 20-task set")
    if not _TRIAL_ID.fullmatch(trial_id) or trial_id in {".", ".."}:
        raise ValueError("job name must be a normalized leaf trial id")

    metadata_path = _absolute_path(task_metadata_path, label="task_metadata_path")
    if not _SHA256.fullmatch(task_metadata_sha256):
        raise ValueError("task_metadata_sha256 is invalid")
    if _sha256_file(metadata_path) != task_metadata_sha256:
        raise ValueError("task runtime metadata sha256 mismatch")
    metadata = _json_object(metadata_path, label="task runtime metadata")
    if metadata.get("schemaVersion") != "jev-deepswe-runtime-metadata-v1":
        raise ValueError("task runtime metadata schema is not supported")
    metadata_tasks = metadata.get("tasks")
    if not isinstance(metadata_tasks, list) or len(metadata_tasks) != len(_FROZEN_TASK_IDS):
        raise ValueError("task runtime metadata must contain exactly 20 tasks")
    indexed_metadata = {
        item.get("taskId"): item for item in metadata_tasks if isinstance(item, dict)
    }
    if set(indexed_metadata) != _FROZEN_TASK_IDS:
        raise ValueError("task runtime metadata does not match the frozen 20-task set")
    for frozen_task_id, frozen_task_metadata in indexed_metadata.items():
        task_details = frozen_task_metadata.get("metadata")
        base_commit = (
            task_details.get("baseCommitHash")
            if isinstance(task_details, dict)
            else None
        )
        if not isinstance(base_commit, str) or not re.fullmatch(
            r"[0-9a-f]{40}", base_commit
        ):
            raise ValueError(
                f"task runtime metadata base commit is invalid for {frozen_task_id}"
            )
    task_metadata = indexed_metadata[task_id]
    expected_base_commit = task_metadata["metadata"]["baseCommitHash"]

    task_root = _absolute_path(tasks_dir, label="DEEPSWE_TASKS")
    if not task_root.is_dir():
        raise ValueError("DEEPSWE_TASKS must be a directory")
    repository = Path(_git_output(task_root, "rev-parse", "--show-toplevel")).resolve(
        strict=True
    )
    if task_root != (repository / "tasks").resolve(strict=True):
        raise ValueError("DEEPSWE_TASKS must be the tasks directory of the frozen checkout")
    provenance = metadata.get("provenance")
    if not isinstance(provenance, dict):
        raise ValueError("task runtime metadata provenance is invalid")
    _validate_task_metadata_amendments(provenance, indexed_metadata)
    expected_commit = provenance.get("commit")
    if not isinstance(expected_commit, str) or not re.fullmatch(r"[0-9a-f]{40}", expected_commit):
        raise ValueError("task runtime metadata commit is invalid")
    if _git_output(repository, "rev-parse", "HEAD") != expected_commit:
        raise ValueError("DeepSWE checkout HEAD does not match the frozen commit")

    relative_task = f"tasks/{task_id}"
    task_directory = task_root / task_id
    if task_directory.is_symlink() or task_directory.resolve(strict=True).parent != task_root:
        raise ValueError("selected task directory is missing or redirected")
    task_toml = task_directory / "task.toml"
    if task_toml.is_symlink() or not task_toml.is_file():
        raise ValueError("selected task.toml is missing or redirected")
    if _sha256_file(task_toml) != task_metadata.get("taskTomlSha256"):
        raise ValueError("selected task.toml does not match the frozen metadata")
    if _git_output(repository, "rev-parse", f"{expected_commit}:{relative_task}") != task_metadata.get(
        "gitTree"
    ):
        raise ValueError("selected task git tree does not match the frozen metadata")
    if _git_output(
        repository, "rev-parse", f"{expected_commit}:{relative_task}/task.toml"
    ) != task_metadata.get("taskTomlBlob"):
        raise ValueError("selected task.toml blob does not match the frozen metadata")
    if _git_output(
        repository,
        "status",
        "--porcelain=v1",
        "--untracked-files=all",
        "--ignored=matching",
        "--",
        relative_task,
    ):
        raise ValueError("selected task checkout contains tracked, untracked, or ignored changes")
    tracked_flags = _git_output(repository, "ls-files", "-v", "--", relative_task)
    tracked_lines = tracked_flags.splitlines()
    if not tracked_lines or any(not line.startswith("H ") for line in tracked_lines):
        raise ValueError("selected task checkout uses assume-unchanged or skip-worktree flags")

    if mode == "score":
        if schedule_path is None or schedule_sha256 is None:
            raise ValueError("scored execution requires the frozen schedule identity")
        frozen_schedule_path = _absolute_path(schedule_path, label="schedule_path")
        if not _SHA256.fullmatch(schedule_sha256):
            raise ValueError("schedule_sha256 is invalid")
        if _sha256_file(frozen_schedule_path) != schedule_sha256:
            raise ValueError("schedule sha256 mismatch")
        schedule = _json_object(frozen_schedule_path, label="schedule")
        if (
            schedule.get("schemaVersion") != "plugin-value-schedule-v1"
            or schedule.get("datasetCommit") != expected_commit
            or schedule.get("taskCount") != 20
            or schedule.get("scheduledTrials") != 40
            or schedule.get("fixedAgent")
            != {
                "agent": "codex",
                "version": PINNED_CODEX_VERSION,
                "model": PINNED_MODEL,
                "effort": PINNED_EFFORT,
            }
        ):
            raise ValueError("schedule identity fields do not match the frozen cohort")
        trials = schedule.get("trials")
        if not isinstance(trials, list) or len(trials) != 40:
            raise ValueError("schedule must contain exactly 40 trials")
        matches = [item for item in trials if isinstance(item, dict) and item.get("trialId") == trial_id]
        if len(matches) != 1:
            raise ValueError("job name must identify exactly one frozen schedule row")
        scheduled = matches[0]
        if (
            scheduled.get("taskId") != task_id
            or scheduled.get("arm") != arm
            or scheduled.get("repetition") != 1
            or scheduled.get("taskTree") != task_metadata.get("gitTree")
            or scheduled.get("taskTomlSha256") != task_metadata.get("taskTomlSha256")
        ):
            raise ValueError("requested trial does not match its frozen schedule row")

    return {
        "taskId": task_id,
        "deepSweCommit": expected_commit,
        "taskTree": task_metadata["gitTree"],
        "taskTomlSha256": task_metadata["taskTomlSha256"],
        "baseCommitHash": expected_base_commit,
    }


def _as_bool(value: Any, *, name: str) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        normalized = value.strip().lower()
        if normalized in {"1", "true", "yes", "on"}:
            return True
        if normalized in {"0", "false", "no", "off"}:
            return False
    raise ValueError(f"{name} must be a boolean")


def _record_digest(value: str) -> bytes:
    algorithm, encoded = value.split("=", 1)
    if algorithm != "sha256":
        raise ValueError("distribution RECORD uses a non-SHA-256 digest")
    return base64.urlsafe_b64decode(encoded + "=" * (-len(encoded) % 4))


def _validate_distribution(
    *,
    distribution_name: str,
    expected: Mapping[str, Any],
    site_packages: Path,
    runtime_root: Path,
) -> None:
    expected_version = expected.get("version")
    expected_record_sha256 = expected.get("recordSha256")
    if not isinstance(expected_version, str) or not _SHA256.fullmatch(
        str(expected_record_sha256)
    ):
        raise ValueError(f"{distribution_name} frozen identity is incomplete")
    distribution = importlib.metadata.distribution(distribution_name)
    if distribution.version != expected_version:
        raise ValueError(f"{distribution_name} version drifted")
    dist_info = Path(distribution._path).resolve(strict=True)  # type: ignore[attr-defined]
    if dist_info.parent != site_packages:
        raise ValueError(f"{distribution_name} loaded outside the pinned site-packages")
    record_path = dist_info / "RECORD"
    if _sha256_file(record_path) != expected_record_sha256:
        raise ValueError(f"{distribution_name} RECORD identity drifted")
    with record_path.open(newline="", encoding="utf-8") as handle:
        rows = list(csv.reader(handle))
    if not rows:
        raise ValueError(f"{distribution_name} RECORD is empty")
    unused_entrypoints = {
        "datacurve-pier": {"../../../bin/pier"},
        "harbor": {"../../../bin/harbor", "../../../bin/hb", "../../../bin/hr"},
    }[distribution_name]
    observed_unused_entrypoints: set[str] = set()
    for row in rows:
        if len(row) != 3:
            raise ValueError(f"{distribution_name} RECORD has an invalid row")
        relative, encoded_digest, encoded_size = row
        if relative in unused_entrypoints:
            # These console scripts are never invoked by the isolated launcher.
            # Validate their RECORD metadata without hydrating external files.
            if not encoded_digest or not encoded_size.isdigit():
                raise ValueError(f"{distribution_name} external entry point is unpinned")
            _record_digest(encoded_digest)
            observed_unused_entrypoints.add(relative)
            continue
        candidate = (site_packages / relative).resolve(strict=True)
        if not _paths_overlap(runtime_root, candidate) or runtime_root not in candidate.parents:
            raise ValueError(f"{distribution_name} RECORD escapes the pinned runtime")
        if not encoded_digest:
            if candidate != record_path or encoded_size:
                raise ValueError(f"{distribution_name} RECORD has an unhashed payload")
            continue
        _record_digest(encoded_digest)
        if not encoded_size.isdigit():
            raise ValueError(f"{distribution_name} RECORD file size is invalid")
        if site_packages not in candidate.parents:
            raise ValueError(f"{distribution_name} RECORD has an unexpected external file")
        content = candidate.read_bytes()
        if hashlib.sha256(content).digest() != _record_digest(encoded_digest):
            raise ValueError(f"{distribution_name} installed file hash drifted")
        if len(content) != int(encoded_size):
            raise ValueError(f"{distribution_name} installed file size drifted")
    if observed_unused_entrypoints != unused_entrypoints:
        raise ValueError(f"{distribution_name} RECORD entry point inventory drifted")
    expected_direct_url = expected.get("directUrl")
    if expected_direct_url is not None:
        direct_url_path = dist_info / "direct_url.json"
        if not isinstance(expected_direct_url, dict):
            raise ValueError(f"{distribution_name} direct URL identity is invalid")
        if _sha256_file(direct_url_path) != expected_direct_url.get("sha256"):
            raise ValueError(f"{distribution_name} direct URL identity drifted")
        direct_url = _json_object(direct_url_path, label=f"{distribution_name} direct URL")
        if direct_url.get("vcs_info", {}).get("commit_id") != expected_direct_url.get(
            "commit"
        ):
            raise ValueError(f"{distribution_name} source revision drifted")


def _validate_private_launch_paths(
    *,
    pier_runtime: str | os.PathLike[str],
    temporary_dir: str | os.PathLike[str],
    jobs_dir: str | os.PathLike[str],
    tasks_dir: str | os.PathLike[str],
    shared_runtime_dir: str | os.PathLike[str],
) -> None:
    private_roots: dict[str, Path] = {}
    for label, value in (("temporary directory", temporary_dir), ("jobs directory", jobs_dir)):
        supplied = Path(value)
        if supplied.is_symlink():
            raise ValueError(f"{label} must not be a symlink")
        path = _absolute_path(supplied, label=label)
        metadata = path.stat()
        if not path.is_dir() or metadata.st_uid != os.getuid() or stat.S_IMODE(metadata.st_mode) & 0o077:
            raise ValueError(f"{label} must be a private owner-only directory")
        private_roots[label] = path
    if _paths_overlap(
        private_roots["temporary directory"], private_roots["jobs directory"]
    ):
        raise ValueError("temporary directory overlaps jobs directory")
    frozen_roots = {
        "Pier runtime": _absolute_path(pier_runtime, label="PIER_RUNTIME"),
        "DeepSWE tasks": _absolute_path(tasks_dir, label="DEEPSWE_TASKS"),
        "shared runtime": _absolute_path(
            shared_runtime_dir, label="PLUGIN_VALUE_RUNTIME_BUNDLE"
        ),
    }
    for mutable_label, mutable_path in private_roots.items():
        for frozen_label, frozen_path in frozen_roots.items():
            if _paths_overlap(mutable_path, frozen_path):
                raise ValueError(f"{mutable_label} overlaps {frozen_label}")


def validate_bootstrap_runtime(
    *,
    pier_runtime: str | os.PathLike[str],
    runtime_identity_path: str | os.PathLike[str],
    adapter_path: str | os.PathLike[str],
    launcher_path: str | os.PathLike[str],
    run_one_path: str | os.PathLike[str],
    temporary_dir: str | os.PathLike[str],
    jobs_dir: str | os.PathLike[str],
    tasks_dir: str | os.PathLike[str],
    shared_runtime_dir: str | os.PathLike[str],
) -> dict[str, str]:
    """Validate the stdlib/Pier launcher before importing any Pier package."""

    runtime_root = _absolute_path(pier_runtime, label="PIER_RUNTIME")
    identity = _json_object(
        _absolute_path(runtime_identity_path, label="runtime_identity_path"),
        label="runtime identity",
    )
    runner = identity.get("runner")
    if not isinstance(runner, dict):
        raise ValueError("runner identity is missing")
    python_identity = runner.get("python")
    if not isinstance(python_identity, dict):
        raise ValueError("Python runner identity is missing")
    if platform.python_version() != python_identity.get("version"):
        raise ValueError("benchmark Python version drifted")
    python_path = Path(os.path.realpath(sys.executable))
    if python_path != (runtime_root / "bin" / "python").resolve(strict=True):
        raise ValueError("benchmark Python did not come from PIER_RUNTIME")
    if _sha256_file(python_path) != python_identity.get("sha256"):
        raise ValueError("benchmark Python executable hash drifted")

    adapter = _absolute_path(adapter_path, label="runtime adapter")
    launcher = _absolute_path(launcher_path, label="Pier launcher")
    run_one = _absolute_path(run_one_path, label="run-one launcher")
    if _sha256_file(adapter) != runner.get("adapterSha256"):
        raise ValueError("runtime adapter hash drifted")
    if _sha256_file(launcher) != runner.get("launcherSha256"):
        raise ValueError("Pier launcher hash drifted")
    if _sha256_file(run_one) != runner.get("runOneSha256"):
        raise ValueError("run-one launcher hash drifted")

    site_packages = (runtime_root / "lib" / "python3.12" / "site-packages").resolve(
        strict=True
    )
    sys.path.insert(0, str(site_packages))
    for distribution_name, identity_key in (
        ("datacurve-pier", "pierDistribution"),
        ("harbor", "harborDistribution"),
    ):
        distribution_identity = runner.get(identity_key)
        if not isinstance(distribution_identity, dict):
            raise ValueError(f"{distribution_name} identity is missing")
        _validate_distribution(
            distribution_name=distribution_name,
            expected=distribution_identity,
            site_packages=site_packages,
            runtime_root=runtime_root,
        )

    _validate_private_launch_paths(
        pier_runtime=runtime_root,
        temporary_dir=temporary_dir,
        jobs_dir=jobs_dir,
        tasks_dir=tasks_dir,
        shared_runtime_dir=shared_runtime_dir,
    )

    return {
        "pythonSha256": python_identity["sha256"],
        "pierVersion": runner["pierDistribution"]["version"],
        "harborVersion": runner["harborDistribution"]["version"],
    }


if __name__ == "__main__":
    if len(sys.argv) != 11 or sys.argv[1] != "validate-bootstrap":
        raise SystemExit(
            "usage: runtime.py validate-bootstrap PIER_RUNTIME IDENTITY ADAPTER "
            "LAUNCHER RUN_ONE TMPDIR JOBS_DIR TASKS_DIR SHARED_RUNTIME"
        )
    validate_bootstrap_runtime(
        pier_runtime=sys.argv[2],
        runtime_identity_path=sys.argv[3],
        adapter_path=sys.argv[4],
        launcher_path=sys.argv[5],
        run_one_path=sys.argv[6],
        temporary_dir=sys.argv[7],
        jobs_dir=sys.argv[8],
        tasks_dir=sys.argv[9],
        shared_runtime_dir=sys.argv[10],
    )
    raise SystemExit(0)


from pier.agents.installed.base import with_prompt_template
from pier.agents.installed.codex import Codex
from pier.environments.base import BaseEnvironment
from pier.environments.docker.docker import DockerEnvironment
from pier.models.agent.context import AgentContext
from pier.models.agent.network import NetworkAllowlist


class PluginValueDockerEnvironment(DockerEnvironment):
    """Digest-pin the task image and mount a verified runtime into agents only.

    Pier 0.3.1 passes ``mounts_json=None`` only for the agent environment and
    supplies an explicit verifier-log mount for a separate verifier.  Calling
    the parent with that value preserves its three default agent/log/artifact
    mounts; the runtime bind is appended afterwards.  The verifier receives
    neither the shared runtime nor its host path.
    """

    def __init__(
        self,
        environment_dir: Path,
        environment_name: str,
        session_id: str,
        trial_paths: Any,
        task_env_config: Any,
        *,
        shared_runtime_dir: str,
        runtime_manifest_sha256: str,
        runtime_tree_sha256: str,
        image_identity_path: str,
        image_identity_sha256: str,
        expected_task_id: str,
        expected_base_commit: str,
        execution_mode: str,
        host_docker_path: str,
        host_docker_sha256: str,
        mounts_json: list[dict[str, Any]] | None = None,
        **kwargs: Any,
    ) -> None:
        if execution_mode not in {"preflight", "score"}:
            raise ValueError("execution_mode must be preflight or score")

        is_verifier = mounts_json is not None
        if is_verifier != ("__verifier__" in session_id):
            raise RuntimeError(
                "unexpected Pier mount/session contract; refusing to expose the runtime"
            )

        self._is_benchmark_agent = not is_verifier
        self._shared_runtime: SharedRuntimeIdentity | None = None
        self._shared_runtime_source = _absolute_path(
            shared_runtime_dir, label="shared_runtime_dir"
        )
        if not self._shared_runtime_source.is_dir():
            raise ValueError("shared_runtime_dir must be a directory")
        self._task_image_identity: TaskImageIdentity | None = None
        self._verifier_base_image: str | None = None
        self._verifier_source_context: Path | None = None
        self._verifier_context_sha256: str | None = None
        self._verifier_build_context: Path | None = None
        self._verifier_build_name: str | None = None
        self._verifier_image_compose_path: Path | None = None
        self._container_identity_evidence: dict[str, str | int] | None = None
        self._container_identity_verified = False
        self._host_docker_path = _absolute_path(host_docker_path, label="host_docker_path")
        if not self._host_docker_path.is_file() or not os.access(
            self._host_docker_path, os.X_OK
        ):
            raise ValueError("host_docker_path must be an executable file")
        if not _SHA256.fullmatch(host_docker_sha256):
            raise ValueError("host_docker_sha256 is invalid")
        if _sha256_file(self._host_docker_path) != host_docker_sha256:
            raise ValueError("host Docker executable hash does not match the frozen identity")
        if environment_name != f"datacurve/{expected_task_id}":
            raise ValueError("Pier environment name does not match expected_task_id")
        if not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", expected_task_id):
            raise ValueError("expected_task_id has an invalid value")
        if not re.fullmatch(r"[0-9a-f]{40}", expected_base_commit):
            raise ValueError("expected_base_commit has an invalid value")
        self._expected_base_commit = expected_base_commit
        self._repository_identity_verified = False
        self._repository_readiness: dict[str, str] | None = None

        identities = _load_image_identities(
            image_identity_path,
            expected_sha256=image_identity_sha256,
            require_execution_ready=execution_mode == "score",
        )
        try:
            image_identity = identities[expected_task_id]
        except KeyError as exc:
            raise ValueError("expected task is absent from the image identity ledger") from exc
        self._task_image_identity = image_identity
        if is_verifier:
            self._verifier_source_context = Path(environment_dir).resolve()
            self._verifier_base_image = _validate_verifier_build_context(
                self._verifier_source_context, image_identity
            )
            self._verifier_context_sha256 = _tree_sha256(self._verifier_source_context)
        effective_task_config = _pin_task_image(
            task_env_config, image_identity, separate_verifier=is_verifier
        )

        if (Path(environment_dir) / "docker-compose.yaml").exists():
            raise RuntimeError(
                "docker-compose.yaml could override the digest-pinned main image"
            )
        if self._is_benchmark_agent:
            self._shared_runtime = validate_shared_runtime(self._shared_runtime_source)
            if not _SHA256.fullmatch(runtime_manifest_sha256):
                raise ValueError("runtime_manifest_sha256 is invalid")
            if not _SHA256.fullmatch(runtime_tree_sha256):
                raise ValueError("runtime_tree_sha256 is invalid")
            if self._shared_runtime.manifest_sha256 != runtime_manifest_sha256:
                raise ValueError("shared runtime manifest does not match the frozen identity")
            if self._shared_runtime.tree_sha256 != runtime_tree_sha256:
                raise ValueError("shared runtime tree does not match the frozen identity")

        super().__init__(
            environment_dir=environment_dir,
            environment_name=environment_name,
            session_id=session_id,
            trial_paths=trial_paths,
            task_env_config=effective_task_config,
            mounts_json=mounts_json,
            **kwargs,
        )

        for mount in self._mounts_json:
            if not isinstance(mount, dict):
                raise RuntimeError("Pier returned an invalid mount entry")
            source = mount.get("source")
            if not isinstance(source, str) or not source.startswith("/"):
                continue
            if _paths_overlap(Path(source), self._shared_runtime_source):
                if not self._is_benchmark_agent:
                    raise RuntimeError("verifier mount overlaps the shared agent runtime")
                raise RuntimeError("runtime source is already exposed by a Pier mount")
            target = mount.get("target")
            if isinstance(target, str) and target.startswith("/"):
                if _posix_paths_overlap(PurePosixPath(target), RUNTIME_MOUNT):
                    raise RuntimeError("Pier mount target overlaps the shared agent runtime")

        if self._is_benchmark_agent:
            assert self._shared_runtime is not None
            self._mounts_json.append(
                {
                    "type": "bind",
                    "source": self._shared_runtime.root.as_posix(),
                    "target": str(RUNTIME_MOUNT),
                    "read_only": True,
                    "bind": {"create_host_path": False},
                }
            )

    @property
    def shared_runtime(self) -> SharedRuntimeIdentity:
        if self._shared_runtime is None:
            raise RuntimeError("the verifier has no shared agent runtime")
        return self._shared_runtime

    @property
    def pinned_task_image(self) -> str:
        if self._task_image_identity is None:
            raise RuntimeError("the verifier has no pinned agent image")
        return self._task_image_identity.pinned_image

    def _prepare_verifier_build_context(self) -> None:
        if self._is_benchmark_agent:
            return
        if (
            self._verifier_source_context is None
            or self._verifier_base_image is None
            or self._verifier_context_sha256 is None
            or self._task_image_identity is None
        ):
            raise RuntimeError("verifier build identity was not initialized")
        if self._verifier_build_context is not None:
            return
        if _tree_sha256(self._verifier_source_context) != self._verifier_context_sha256:
            raise RuntimeError("separate verifier source context changed before build")
        trial_dir = getattr(self, "trial_paths", None)
        trial_dir = getattr(trial_dir, "trial_dir", None)
        if not isinstance(trial_dir, Path):
            raise RuntimeError("Pier did not provide a trial directory for verifier context")
        build_context = trial_dir / "verifier-build-context"
        _rewrite_verifier_build_context(
            self._verifier_source_context,
            build_context,
            pinned_base_image=self._task_image_identity.pinned_image,
        )
        if _tree_sha256(self._verifier_source_context) != self._verifier_context_sha256:
            shutil.rmtree(build_context, ignore_errors=True)
            raise RuntimeError("separate verifier source context changed during copy")
        digest_suffix = self._task_image_identity.manifest_digest.removeprefix("sha256:")[:16]
        context_suffix = self._verifier_context_sha256[:24]
        self._verifier_build_name = f"hb__verifier-{context_suffix}-{digest_suffix}:latest"
        self._verifier_build_context = build_context
        self.environment_dir = build_context
        self._env_vars.context_dir = build_context.resolve().as_posix()
        self._env_vars.main_image_name = self._verifier_build_name
        # Pinned Pier's build template does not consume MAIN_IMAGE_NAME.
        # Bind the generated image explicitly instead of accepting Compose's
        # unrelated per-project default image name.
        image_compose = trial_dir / "verifier-compose-image.json"
        image_compose.write_text(json.dumps({
            "services": {"main": {"image": self._verifier_build_name}}
        }) + "\n", encoding="utf-8")
        image_compose.chmod(0o600)
        self._verifier_image_compose_path = image_compose

    @property
    def _docker_compose_paths(self) -> list[Path]:
        paths = super()._docker_compose_paths
        if self._verifier_image_compose_path is not None:
            paths.append(self._verifier_image_compose_path)
        return paths

    def _write_verifier_identity_receipt(self) -> None:
        if self._verifier_build_context is None or self._verifier_context_sha256 is None:
            raise RuntimeError("verifier build identity is unavailable")
        trial_dir = getattr(getattr(self, "trial_paths", None), "trial_dir", None)
        if not isinstance(trial_dir, Path):
            raise RuntimeError("Pier did not provide a trial directory for verifier receipt")
        evidence = self._container_identity_evidence
        if evidence is None or self._task_image_identity is None:
            raise RuntimeError("container identity evidence is unavailable")
        payload = {
            "schemaVersion": "jev-plugin-value-verifier-runtime-identity-v1",
            "containerId": evidence["containerId"],
            "imageId": evidence["imageId"],
            "configuredImage": evidence["image"],
            "originalContextSha256": self._verifier_context_sha256,
            "copiedDockerfileSha256": _sha256_file(self._verifier_build_context / "Dockerfile"),
            "baseImageDigest": self._task_image_identity.manifest_digest,
            "runtimeMountCount": evidence["runtimeMountCount"],
        }
        receipt = trial_dir / "verifier-runtime-identity.json"
        temporary = trial_dir / ".verifier-runtime-identity.json.tmp"
        temporary.write_text(json.dumps(payload, sort_keys=True) + "\n", encoding="utf-8")
        temporary.chmod(0o600)
        os.replace(temporary, receipt)

    def _cleanup_verifier_build_context(self) -> None:
        build_context = self._verifier_build_context
        trial_dir = getattr(getattr(self, "trial_paths", None), "trial_dir", None)
        if not isinstance(build_context, Path) or not isinstance(trial_dir, Path):
            return
        expected = trial_dir / "verifier-build-context"
        if build_context == expected:
            shutil.rmtree(build_context, ignore_errors=True)
        self._verifier_build_context = None

    async def stop(self, delete: bool) -> None:
        # Preserve the digest-pinned base image for the paired controls.  The
        # copied verifier context is removed only after this exact compose
        # project reports no main container; failures retain it for diagnosis.
        await super().stop(delete=False)
        stopped = await self._run_docker_compose_command(
            ["ps", "--all", "-q", "main"], check=False, timeout_sec=30
        )
        if stopped.return_code != 0 or (stopped.stdout or "").strip():
            raise RuntimeError("verifier compose project still has a main container")
        self._cleanup_verifier_build_context()

    async def start(self, force_build: bool) -> None:
        if force_build:
            raise RuntimeError("plugin-value environments do not permit force_build")
        self._prepare_verifier_build_context()
        await super().start(force_build=force_build)
        if self._is_benchmark_agent and not self._use_prebuilt:
            raise RuntimeError("Pier did not select the pinned prebuilt task image")
        if not self._is_benchmark_agent and self._use_prebuilt:
            raise RuntimeError("Pier bypassed the separate verifier tests build context")
        await self._verify_running_container(expect_runtime=self._is_benchmark_agent)
        if self._is_benchmark_agent:
            await self._verify_repository_ready()

    async def benchmark_container_id(self) -> str:
        result = await self._run_docker_compose_command(
            ["ps", "-q", "main"], check=True, timeout_sec=30
        )
        container_id = (result.stdout or "").strip()
        if not _CONTAINER_ID.fullmatch(container_id):
            raise RuntimeError("Pier returned an invalid main-container id")
        return container_id

    async def _inspect_container(self, container_id: str) -> dict[str, Any]:
        process = await asyncio.create_subprocess_exec(
            str(self._host_docker_path),
            "container",
            "inspect",
            container_id,
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        try:
            stdout, stderr = await asyncio.wait_for(process.communicate(), timeout=30)
        except asyncio.TimeoutError as exc:
            process.kill()
            await process.communicate()
            raise RuntimeError("docker container identity check timed out") from exc
        if process.returncode != 0:
            message = stderr.decode("utf-8", errors="replace")[-500:]
            raise RuntimeError(f"docker container identity check failed: {message}")
        try:
            value = json.loads(stdout)
        except json.JSONDecodeError as exc:
            raise RuntimeError("docker returned invalid container identity JSON") from exc
        if not isinstance(value, list) or len(value) != 1 or not isinstance(value[0], dict):
            raise RuntimeError("docker returned an unexpected container identity")
        return value[0]

    async def _verify_running_container(self, *, expect_runtime: bool) -> None:
        container_id = await self.benchmark_container_id()
        inspected = await self._inspect_container(container_id)
        config = inspected.get("Config")
        if not isinstance(config, dict):
            raise RuntimeError("running task container image identity is unavailable")
        configured_image = config.get("Image")
        if expect_runtime and configured_image != self.pinned_task_image:
            raise RuntimeError("running task container is not using the digest-pinned image")
        if not expect_runtime:
            if self._verifier_build_name is None or configured_image != self._verifier_build_name:
                raise RuntimeError("verifier container image does not match its context identity")
            if self._verifier_build_context is None or self._task_image_identity is None:
                raise RuntimeError("verifier build base is not the frozen image digest")
        image_id = inspected.get("Image")
        if not isinstance(image_id, str) or not re.fullmatch(r"sha256:[0-9a-f]{64}", image_id):
            raise RuntimeError("docker did not return the verifier image identity")
        host_config = inspected.get("HostConfig")
        if not isinstance(host_config, dict) or host_config.get("NetworkMode") != "none":
            raise RuntimeError("running task container network mode must be none")
        mounts = inspected.get("Mounts")
        if not isinstance(mounts, list):
            raise RuntimeError("docker container mount identity is unavailable")
        runtime_mounts = []
        for mount in mounts:
            if not isinstance(mount, dict):
                raise RuntimeError("docker container mount identity is invalid")
            destination = mount.get("Destination")
            if isinstance(destination, str) and destination.startswith("/"):
                if _posix_paths_overlap(PurePosixPath(destination), RUNTIME_MOUNT):
                    runtime_mounts.append(mount)
        expected_count = 1 if expect_runtime else 0
        if len(runtime_mounts) != expected_count:
            raise RuntimeError("running task container has an invalid runtime mount count")
        overlapping_sources = []
        for candidate in mounts:
            source = candidate.get("Source")
            if isinstance(source, str) and source.startswith("/"):
                try:
                    overlaps = _paths_overlap(Path(source), self._shared_runtime_source)
                except OSError as exc:
                    raise RuntimeError("docker container mount source is invalid") from exc
                if overlaps:
                    overlapping_sources.append(candidate)
        if expect_runtime:
            if overlapping_sources != runtime_mounts:
                raise RuntimeError("running task container exposes an unexpected runtime source")
        elif overlapping_sources:
            raise RuntimeError("verifier container exposes the shared agent runtime")
        self._container_identity_evidence = {
            "containerId": container_id,
            "imageId": image_id,
            "image": self.pinned_task_image if expect_runtime else str(configured_image),
            "runtimeMountCount": len(runtime_mounts),
        }
        if not expect_runtime:
            self._write_verifier_identity_receipt()
            self._container_identity_verified = True
            return
        mount = runtime_mounts[0]
        source = mount.get("Source")
        if (
            mount.get("Destination") != str(RUNTIME_MOUNT)
            or mount.get("Type") != "bind"
            or mount.get("RW") is not False
            or not isinstance(source, str)
            or Path(source).resolve() != self.shared_runtime.root
        ):
            raise RuntimeError("running task container runtime mount is not the verified read-only bind")
        self._container_identity_verified = True

    @property
    def repository_readiness(self) -> dict[str, str]:
        if not self._repository_identity_verified or self._repository_readiness is None:
            raise RuntimeError("task repository identity has not been verified")
        return dict(self._repository_readiness)

    @property
    def container_identity_evidence(self) -> dict[str, str | int]:
        if not self._container_identity_verified or self._container_identity_evidence is None:
            raise RuntimeError("container identity has not been verified")
        return dict(self._container_identity_evidence)

    async def _verify_repository_ready(self) -> None:
        """Reject incomplete or dirty task repositories before agent setup."""

        base = shlex.quote(self._expected_base_commit)
        command = (
            "set -eu"
            " && head=$(/usr/bin/git -C /app rev-parse --verify 'HEAD^{commit}')"
            f" && test \"$head\" = {base}"
            f" && commit=$(/usr/bin/git -C /app rev-parse --verify {base}'^{{commit}}')"
            f" && test \"$commit\" = {base}"
            f" && tree=$(/usr/bin/git -C /app rev-parse --verify {base}'^{{tree}}')"
            " && test -n \"$tree\""
            " && test -n \"$(/usr/bin/git -C /app ls-files)\""
            f" && /usr/bin/git -C /app diff --quiet --cached {base} --"
            " && /usr/bin/git -C /app diff --quiet --"
            " && test -z \"$(/usr/bin/git -C /app status --porcelain=v1 --untracked-files=all)\""
            " && printf '%s\\n%s\\n' \"$head\" \"$tree\""
        )
        result = await self.exec(command, timeout_sec=120, user="root")
        lines = (result.stdout or "").splitlines()
        if (
            result.return_code != 0
            or len(lines) != 2
            or lines[0] != self._expected_base_commit
            or not re.fullmatch(r"[0-9a-f]{40}", lines[1])
        ):
            raise RuntimeError(
                "task repository is missing its frozen base commit, has an invalid "
                "HEAD/tree, or is not clean"
            )
        self._repository_readiness = {
            "baseCommitHash": self._expected_base_commit,
            "headCommit": lines[0],
            "headTree": lines[1],
        }
        self._repository_identity_verified = True


class PluginValueCodex(Codex):
    """Fixed-model Codex agent driven by the host-side benchmark app-server."""

    SUPPORTS_ATIF = True

    def __init__(
        self,
        *args: Any,
        arm: str,
        version: str = PINNED_CODEX_VERSION,
        reasoning_effort: str = PINNED_EFFORT,
        preflight_only: bool | str = False,
        turn_timeout_ms: int | str = 10_700_000,
        host_node_path: str,
        host_codex_path: str,
        host_docker_path: str,
        host_node_sha256: str,
        host_codex_sha256: str,
        host_docker_sha256: str,
        host_runner_sha256: str,
        host_runner: str | None = None,
        **kwargs: Any,
    ) -> None:
        if arm not in {"baseline", "treatment"}:
            raise ValueError("arm must be baseline or treatment")
        if version != PINNED_CODEX_VERSION:
            raise ValueError(f"Codex version must be {PINNED_CODEX_VERSION}")
        if reasoning_effort != PINNED_EFFORT:
            raise ValueError(f"reasoning_effort must be {PINNED_EFFORT}")
        model_name = kwargs.get("model_name")
        if model_name != PINNED_MODEL:
            raise ValueError(f"model_name must be {PINNED_MODEL}")
        if not _SHA256.fullmatch(host_node_sha256):
            raise ValueError("host_node_sha256 is invalid")
        if not _SHA256.fullmatch(host_codex_sha256):
            raise ValueError("host_codex_sha256 is invalid")
        if not _SHA256.fullmatch(host_docker_sha256):
            raise ValueError("host_docker_sha256 is invalid")
        if not _SHA256.fullmatch(host_runner_sha256):
            raise ValueError("host_runner_sha256 is invalid")

        timeout = int(turn_timeout_ms)
        if timeout < 1_000 or timeout > 10_790_000:
            raise ValueError("turn_timeout_ms must be between 1000 and 10790000")

        self.arm = arm
        self.preflight_only = _as_bool(preflight_only, name="preflight_only")
        self.turn_timeout_ms = timeout
        self.host_node_path = _absolute_path(host_node_path, label="host_node_path")
        self.host_codex_path = _absolute_path(host_codex_path, label="host_codex_path")
        self.host_docker_path = _absolute_path(host_docker_path, label="host_docker_path")
        if not self.host_node_path.is_file() or not os.access(self.host_node_path, os.X_OK):
            raise ValueError("host_node_path must be an executable file")
        if not self.host_codex_path.is_file() or not os.access(self.host_codex_path, os.X_OK):
            raise ValueError("host_codex_path must be an executable file")
        if not self.host_docker_path.is_file() or not os.access(self.host_docker_path, os.X_OK):
            raise ValueError("host_docker_path must be an executable file")
        self.host_node_sha256 = host_node_sha256
        self.host_codex_sha256 = host_codex_sha256
        self.host_docker_sha256 = host_docker_sha256
        self.host_runner_sha256 = host_runner_sha256
        self.host_runner = Path(host_runner or Path(__file__).with_name("host-runner.mjs"))
        self._host_control_dir: Path | None = None
        super().__init__(
            *args,
            version=version,
            reasoning_effort=reasoning_effort,
            **kwargs,
        )

    def network_allowlist(self) -> NetworkAllowlist:
        """Keep the task container offline; transports run on the host."""

        return NetworkAllowlist()

    def install_spec(self) -> None:
        """Use the validated read-only bundle; never build a derivative image."""

        return None

    async def setup(self, environment: BaseEnvironment) -> None:
        if not isinstance(environment, PluginValueDockerEnvironment):
            raise TypeError("PluginValueCodex requires PluginValueDockerEnvironment")
        if not environment._container_identity_verified:
            raise RuntimeError("task container identity was not verified before agent setup")
        if not environment._repository_identity_verified:
            raise RuntimeError("task repository identity was not verified before agent setup")

        runtime = environment.shared_runtime
        node_path = RUNTIME_MOUNT.joinpath(*runtime.node.path.parts)
        codex_path = RUNTIME_MOUNT.joinpath(*runtime.codex.path.parts)

        node_version = await environment.exec(
            f"{shlex.quote(str(node_path))} --version", timeout_sec=30, user="root"
        )
        if (
            node_version.return_code != 0
            or (node_version.stdout or "").strip() != f"v{PINNED_NODE_VERSION}"
        ):
            raise RuntimeError("shared runtime Node version mismatch")

        checksum_script = (
            "const fs=require('node:fs'),c=require('node:crypto');"
            "for(const p of process.argv.slice(1))"
            "console.log(c.createHash('sha256').update(fs.readFileSync(p)).digest('hex'))"
        )
        checksums = await environment.exec(
            " ".join(
                (
                    shlex.quote(str(node_path)),
                    "-e",
                    shlex.quote(checksum_script),
                    shlex.quote(str(codex_path)),
                    shlex.quote(str(node_path)),
                )
            ),
            timeout_sec=60,
            user="root",
        )
        observed_checksums = (checksums.stdout or "").splitlines()
        expected_checksums = [runtime.codex.sha256, runtime.node.sha256]
        if checksums.return_code != 0 or observed_checksums != expected_checksums:
            raise RuntimeError("shared runtime executable sha256 mismatch")

        links = await environment.exec(
            "mkdir -p /usr/local/bin /installed-agent"
            f" && ln -sfn {shlex.quote(str(node_path))} /usr/local/bin/node"
            f" && ln -sfn {shlex.quote(str(codex_path))} /usr/local/bin/codex",
            timeout_sec=30,
            user="root",
        )
        if links.return_code != 0:
            raise RuntimeError("failed to link the shared runtime into the task container")

        runtime_user = (
            str(environment.default_user)
            if environment.default_user is not None
            else "root"
        )
        if not _CONTAINER_USER.fullmatch(runtime_user):
            raise RuntimeError("task container user has an invalid value")
        runtime_directories = await environment.exec(
            "umask 077"
            " && test ! -e /installed-agent/codex-exec-home"
            " && test ! -e /installed-agent/codex-exec-launcher"
            " && mkdir /installed-agent/codex-exec-home"
            " /installed-agent/codex-exec-launcher"
            f" && chown {shlex.quote(runtime_user)}"
            " /installed-agent/codex-exec-home"
            " /installed-agent/codex-exec-launcher"
            " && chmod 700 /installed-agent/codex-exec-home"
            " /installed-agent/codex-exec-launcher",
            timeout_sec=30,
            user="root",
        )
        if runtime_directories.return_code != 0:
            raise RuntimeError("failed to create task-owned Codex runtime directories")

        codex_version = await environment.exec(
            f"{shlex.quote(str(codex_path))} --version", timeout_sec=30, user="root"
        )
        observed = (codex_version.stdout or "").strip()
        if codex_version.return_code != 0 or observed != f"codex-cli {PINNED_CODEX_VERSION}":
            raise RuntimeError(
                f"shared runtime Codex version mismatch: {observed or 'unavailable'}"
            )

    def _runner_environment(self, host_control: Path) -> dict[str, str]:
        allowed = {
            "HOME",
            "USER",
            "LOGNAME",
            "SHELL",
            "LANG",
            "LC_ALL",
            "TMPDIR",
            "CODEX_HOME",
            "TYPESAFE_API_KEY",
            "JEV_API_KEY_FILE",
            "PLUGIN_VALUE_PLUGIN_DIR",
            "PLUGIN_VALUE_SOURCE_CODEX_HOME",
        }
        environment = {key: value for key, value in os.environ.items() if key in allowed}
        environment["PATH"] = f"{host_control / 'bin'}:/usr/bin:/bin:/usr/sbin:/sbin"
        return environment

    def _prepare_host_control_dir(self) -> Path:
        """Create a control directory that is never mounted into the task."""

        host_control = self.logs_dir.parent / "host-control"
        if host_control.is_symlink():
            raise RuntimeError("host control directory must not be a symlink")
        host_control.mkdir(mode=0o700, parents=False, exist_ok=True)
        if not host_control.is_dir():
            raise RuntimeError("host control path is not a directory")
        host_control.chmod(0o700)
        resolved = host_control.resolve(strict=True)
        if resolved == self.logs_dir.resolve(strict=False):
            raise RuntimeError("host control directory overlaps task-visible agent logs")
        self._host_control_dir = resolved
        return resolved

    @staticmethod
    async def _terminate_subprocess(process: asyncio.subprocess.Process) -> None:
        def group_exists() -> bool:
            try:
                os.killpg(process.pid, 0)
            except ProcessLookupError:
                return False
            except PermissionError:
                # Darwin can report EPERM while a terminated process group is
                # disappearing. Permission denial alone is not absence: verify
                # against the OS process table and propagate it if any member
                # remains or the independent query cannot establish absence.
                if sys.platform != "darwin":
                    raise
                observed = subprocess.run(
                    ["/bin/ps", "-e", "-o", "pgid="],
                    capture_output=True, text=True, check=True, timeout=5,
                )
                groups = observed.stdout.split()
                if not groups or any(not value.isdecimal() for value in groups):
                    raise RuntimeError("cannot verify process-group absence")
                if str(process.pid) in groups:
                    raise
                return False
            return True

        try:
            if group_exists():
                os.killpg(process.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        deadline = asyncio.get_running_loop().time() + 5
        while group_exists() and asyncio.get_running_loop().time() < deadline:
            await asyncio.sleep(0.05)
        if group_exists():
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        await process.wait()

    @staticmethod
    def _cleanup_host_transients(host_control: Path) -> None:
        """Remove exact secret-bearing paths even if the JS runner is killed."""

        for name in ("runtime-home", "workspace"):
            path = host_control / name
            try:
                metadata = path.lstat()
            except FileNotFoundError:
                continue
            if stat.S_ISDIR(metadata.st_mode) and not stat.S_ISLNK(metadata.st_mode):
                shutil.rmtree(path)
            else:
                path.unlink()

    @with_prompt_template
    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        del context  # Pier populates it from the copied Codex session post-run.
        if not isinstance(environment, PluginValueDockerEnvironment):
            raise TypeError(
                "PluginValueCodex requires PluginValueDockerEnvironment"
            )
        if not self.host_runner.is_file():
            raise FileNotFoundError(f"host runner not found: {self.host_runner}")

        container_id = await environment.benchmark_container_id()
        container_user = (
            str(environment.default_user)
            if environment.default_user is not None
            else None
        )
        if container_user is not None and not _CONTAINER_USER.fullmatch(container_user):
            raise RuntimeError("task container user has an invalid value")

        self.logs_dir.mkdir(parents=True, exist_ok=True)
        host_control = self._prepare_host_control_dir()
        host_cwd = str(host_control / "workspace")
        remote_cwd = host_cwd
        runtime_home = str(host_control / "runtime-home")
        request_path = host_control / "host-runner-request.json"
        result_path = host_control / "host-runner-result.json"
        if request_path.exists() or result_path.exists():
            raise RuntimeError("host control request/result already exists")
        resolved_node_path = self.host_node_path
        resolved_codex_path = self.host_codex_path
        resolved_docker_path = self.host_docker_path
        if _sha256_file(resolved_node_path) != self.host_node_sha256:
            raise RuntimeError("host Node executable hash does not match the frozen identity")
        if _sha256_file(resolved_codex_path) != self.host_codex_sha256:
            raise RuntimeError("host Codex executable hash does not match the frozen identity")
        if _sha256_file(resolved_docker_path) != self.host_docker_sha256:
            raise RuntimeError("host Docker executable hash does not match the frozen identity")
        try:
            host_runner_bytes = self.host_runner.read_bytes()
        except OSError as exc:
            raise RuntimeError("host runner could not be read") from exc
        if hashlib.sha256(host_runner_bytes).hexdigest() != self.host_runner_sha256:
            raise RuntimeError("host runner hash does not match the frozen identity")
        runner_copy = host_control / "host-runner.mjs"
        runner_copy.write_bytes(host_runner_bytes)
        runner_copy.chmod(0o500)
        controlled_bin = host_control / "bin"
        controlled_bin.mkdir(mode=0o700)
        controlled_node = controlled_bin / "node"
        controlled_node.symlink_to(resolved_node_path)
        if controlled_node.resolve(strict=True) != resolved_node_path:
            raise RuntimeError("controlled plugin Node path does not resolve to the pinned binary")
        request_path.write_text(
            json.dumps(
                {
                    "schemaVersion": "plugin-value-runtime-v1",
                    "arm": self.arm,
                    "containerId": container_id,
                    "containerUser": container_user,
                    "dockerPath": str(resolved_docker_path),
                    "dockerSha256": self.host_docker_sha256,
                    "nodePath": str(resolved_node_path),
                    "nodeSha256": self.host_node_sha256,
                    "codexPath": str(resolved_codex_path),
                    "codexSha256": self.host_codex_sha256,
                    "instruction": instruction,
                    "logsDir": str(host_control),
                    "model": PINNED_MODEL,
                    "effort": PINNED_EFFORT,
                    "remoteCwd": remote_cwd,
                    "hostCwd": host_cwd,
                    "runtimeHome": runtime_home,
                    "turnTimeoutMs": self.turn_timeout_ms,
                    "preflightOnly": self.preflight_only,
                },
                sort_keys=True,
            )
            + "\n",
            encoding="utf-8",
        )

        try:
            process = await asyncio.create_subprocess_exec(
                str(resolved_node_path),
                str(runner_copy),
                "--request",
                str(request_path),
                "--result",
                str(result_path),
                cwd=str(host_control),
                env=self._runner_environment(host_control),
                stdin=asyncio.subprocess.DEVNULL,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                start_new_session=True,
            )
            try:
                stdout, stderr = await process.communicate()
            except asyncio.CancelledError:
                cleanup = asyncio.create_task(self._terminate_subprocess(process))
                try:
                    await asyncio.shield(cleanup)
                except asyncio.CancelledError:
                    await cleanup
                raise
            except BaseException:
                await self._terminate_subprocess(process)
                raise
            (host_control / "host-runner.stdout").write_bytes(stdout)
            (host_control / "host-runner.stderr").write_bytes(stderr)
            if process.returncode != 0:
                message = stderr.decode("utf-8", errors="replace")[-2_000:]
                raise RuntimeError(
                    f"host Codex app-server runner failed ({process.returncode}): {message}"
                )
            if not result_path.is_file():
                raise RuntimeError("host runner produced no result receipt")
            result = json.loads(result_path.read_text(encoding="utf-8"))
            if result.get("status") != "passed":
                raise RuntimeError("host runner did not report a passed execution")
        finally:
            self._cleanup_host_transients(host_control)

    def populate_context_post_run(self, context: AgentContext) -> None:
        """Parse only host-controlled session evidence into Pier metrics."""

        if self._host_control_dir is None:
            self.logger.debug("No host-controlled Codex evidence directory found")
            return
        task_visible_logs = self.logs_dir
        try:
            self.logs_dir = self._host_control_dir
            super().populate_context_post_run(context)
        finally:
            self.logs_dir = task_visible_logs
