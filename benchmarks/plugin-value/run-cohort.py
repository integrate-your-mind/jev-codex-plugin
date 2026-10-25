#!/usr/bin/env python3
"""Run a frozen plugin-value schedule sequentially without selective retries.

This supervisor is deliberately small and local.  It reserves each scheduled
row durably before launch, invokes run-one.sh once, and records only source
identities and the direct Pier trial verdict.  It never reads Pier's aggregate
job result as if it were a trial result.
"""

from __future__ import annotations

import argparse
import datetime as dt
import fcntl
import hashlib
import json
import math
import os
from pathlib import Path
import re
import signal
import stat
import subprocess
import sys
import time
from typing import Any, Iterable


SCHEMA = "plugin-value-cohort-supervisor-v1"
MANIFEST_SCHEMA = "plugin-value-cohort-manifest-v1"
RESERVATION_SCHEMA = "plugin-value-row-reservation-v1"
RECEIPT_SCHEMA = "plugin-value-row-receipt-v1"
JOURNAL_SCHEMA = "plugin-value-cohort-journal-v1"
DEFAULT_DEADLINE_SECONDS = 10_800 + 1_800 + 600
MAX_JSON_BYTES = 64 * 1024 * 1024
TRIAL_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]*")
TASK_ID = re.compile(r"[a-z0-9](?:[a-z0-9-]*[a-z0-9])?")
HEX40 = re.compile(r"[0-9a-f]{40}")
HEX64 = re.compile(r"[0-9a-f]{64}")


class CohortError(RuntimeError):
    """Configuration or durable-state error."""


class BoundSourceChanged(CohortError):
    def __init__(self, component: str):
        super().__init__(f"bound {component} changed before row launch")
        self.component = component


class InterruptedRun(BaseException):
    def __init__(self, signum: int):
        super().__init__(f"interrupted by signal {signum}")
        self.signum = signum


def utc_now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat()


def canonical_bytes(value: Any) -> bytes:
    return (json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True) + "\n").encode("utf-8")


def digest_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def hash_file(path: Path) -> tuple[str, int]:
    try:
        info = path.lstat()
    except OSError as exc:
        raise CohortError(f"cannot stat required file: {path}") from exc
    if not stat.S_ISREG(info.st_mode) or path.is_symlink():
        raise CohortError(f"required path is not a regular non-symlink file: {path}")
    digest = hashlib.sha256()
    size = 0
    try:
        with path.open("rb") as source:
            while True:
                chunk = source.read(1024 * 1024)
                if not chunk:
                    break
                digest.update(chunk)
                size += len(chunk)
    except OSError as exc:
        raise CohortError(f"cannot read required file: {path}") from exc
    return digest.hexdigest(), size


def _reject_duplicate_pairs(pairs: Iterable[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f"duplicate JSON key: {key}")
        result[key] = value
    return result


def _reject_constant(value: str) -> None:
    raise ValueError(f"non-finite JSON number: {value}")


def decode_json(data: bytes, label: str) -> Any:
    try:
        return json.loads(
            data.decode("utf-8"),
            object_pairs_hook=_reject_duplicate_pairs,
            parse_constant=_reject_constant,
        )
    except (UnicodeDecodeError, ValueError) as exc:
        raise CohortError(f"{label} is not strict JSON") from exc


def read_json(path: Path, label: str) -> Any:
    try:
        info = path.lstat()
        if not stat.S_ISREG(info.st_mode) or path.is_symlink():
            raise CohortError(f"{label} is not a regular non-symlink file")
        if info.st_size > MAX_JSON_BYTES:
            raise CohortError(f"{label} exceeds {MAX_JSON_BYTES} bytes")
        data = path.read_bytes()
    except CohortError:
        raise
    except OSError as exc:
        raise CohortError(f"cannot read {label}: {path}") from exc
    return decode_json(data, label)


def _fsync_directory(path: Path) -> None:
    descriptor = os.open(path, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def write_exclusive(path: Path, payload: bytes) -> None:
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    try:
        descriptor = os.open(path, flags, 0o600)
    except FileExistsError as exc:
        raise CohortError(f"refusing to overwrite durable evidence: {path}") from exc
    try:
        view = memoryview(payload)
        while view:
            written = os.write(descriptor, view)
            view = view[written:]
        os.fsync(descriptor)
    except BaseException:
        os.close(descriptor)
        raise
    else:
        os.close(descriptor)
    _fsync_directory(path.parent)


def write_json_exclusive(path: Path, value: Any) -> str:
    payload = canonical_bytes(value)
    write_exclusive(path, payload)
    return digest_bytes(payload)


def ensure_private_directory(path: Path, label: str) -> Path:
    if not path.is_absolute():
        raise CohortError(f"{label} must be absolute")
    try:
        info = path.lstat()
    except OSError as exc:
        raise CohortError(f"{label} must already exist: {path}") from exc
    if path.is_symlink() or not stat.S_ISDIR(info.st_mode):
        raise CohortError(f"{label} must be a non-symlink directory")
    if hasattr(os, "getuid") and info.st_uid != os.getuid():
        raise CohortError(f"{label} must be owned by the current user")
    if stat.S_IMODE(info.st_mode) & 0o077:
        raise CohortError(f"{label} must not grant group or other permissions")
    return path.resolve(strict=True)


def make_private_directory(path: Path) -> None:
    try:
        path.mkdir(mode=0o700)
    except FileExistsError:
        info = path.lstat()
        if path.is_symlink() or not stat.S_ISDIR(info.st_mode):
            raise CohortError(f"evidence path is not a directory: {path}")
        if stat.S_IMODE(info.st_mode) & 0o077:
            raise CohortError(f"evidence directory is not private: {path}")
    _fsync_directory(path.parent)


def paths_overlap(first: Path, second: Path) -> bool:
    return first == second or first in second.parents or second in first.parents


def validate_schedule(schedule: Any) -> list[dict[str, Any]]:
    if not isinstance(schedule, dict) or schedule.get("schemaVersion") != "plugin-value-schedule-v1":
        raise CohortError("schedule schemaVersion is not plugin-value-schedule-v1")
    fixed = schedule.get("fixedAgent")
    treatment = schedule.get("treatment")
    if not isinstance(fixed, dict) or set(("agent", "version", "model", "effort")) - set(fixed):
        raise CohortError("schedule fixedAgent is incomplete")
    if not isinstance(treatment, dict) or set(("pluginSourceRevision", "pluginVersion", "allOptionalUsageCaps")) - set(treatment):
        raise CohortError("schedule treatment is incomplete")
    if treatment.get("allOptionalUsageCaps") is not None:
        raise CohortError("schedule changes the frozen no-cap treatment")
    trials = schedule.get("trials")
    if not isinstance(trials, list) or not trials:
        raise CohortError("schedule trials must be a non-empty array")
    if schedule.get("scheduledTrials") != len(trials):
        raise CohortError("schedule scheduledTrials does not equal its row count")
    task_count = schedule.get("taskCount")
    attempts = schedule.get("attemptsPerArmPerTask")
    if isinstance(task_count, bool) or not isinstance(task_count, int) or task_count <= 0:
        raise CohortError("schedule taskCount must be a positive integer")
    if isinstance(attempts, bool) or not isinstance(attempts, int) or attempts <= 0:
        raise CohortError("schedule attemptsPerArmPerTask must be a positive integer")
    if len(trials) != task_count * attempts * 2:
        raise CohortError("schedule row count does not match tasks, arms, and attempts")

    seen_trials: set[str] = set()
    arm_counts: dict[tuple[str, str], int] = {}
    task_ids: set[str] = set()
    normalized: list[dict[str, Any]] = []
    for expected_order, raw in enumerate(trials, 1):
        if not isinstance(raw, dict):
            raise CohortError(f"schedule row {expected_order} is not an object")
        row = dict(raw)
        if row.get("order") != expected_order:
            raise CohortError("schedule order is not contiguous and one-based")
        trial_id = row.get("trialId")
        task_id = row.get("taskId")
        arm = row.get("arm")
        if not isinstance(trial_id, str) or not TRIAL_ID.fullmatch(trial_id) or trial_id in {".", ".."}:
            raise CohortError(f"schedule row {expected_order} has an invalid trialId")
        if trial_id in seen_trials:
            raise CohortError(f"duplicate trialId in schedule: {trial_id}")
        if not isinstance(task_id, str) or not TASK_ID.fullmatch(task_id):
            raise CohortError(f"schedule row {expected_order} has an invalid taskId")
        if arm not in {"baseline", "treatment"}:
            raise CohortError(f"schedule row {expected_order} has an invalid arm")
        for field in ("pairIndex", "withinPairOrder", "repetition"):
            value = row.get(field)
            if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
                raise CohortError(f"schedule row {expected_order} has an invalid {field}")
        if not isinstance(row.get("taskTree"), str) or not HEX40.fullmatch(row["taskTree"]):
            raise CohortError(f"schedule row {expected_order} has an invalid taskTree")
        if not isinstance(row.get("taskTomlSha256"), str) or not HEX64.fullmatch(row["taskTomlSha256"]):
            raise CohortError(f"schedule row {expected_order} has an invalid taskTomlSha256")
        seen_trials.add(trial_id)
        task_ids.add(task_id)
        arm_counts[(task_id, arm)] = arm_counts.get((task_id, arm), 0) + 1
        normalized.append(row)
    if len(task_ids) != task_count:
        raise CohortError("schedule unique task count does not match taskCount")
    for task_id in task_ids:
        for arm in ("baseline", "treatment"):
            if arm_counts.get((task_id, arm)) != attempts:
                raise CohortError(f"schedule does not preserve {attempts} {arm} row(s) for {task_id}")
    return normalized


def validate_identity(schedule: dict[str, Any], identity: Any, schedule_hash: str, run_one_hash: str, execute: bool) -> None:
    if not isinstance(identity, dict) or identity.get("schemaVersion") != "plugin-value-runtime-identity-v1":
        raise CohortError("runtime identity schema is invalid")
    dataset = identity.get("dataset")
    runner = identity.get("runner")
    agent = identity.get("agent")
    plugin = identity.get("plugin")
    if not all(isinstance(item, dict) for item in (dataset, runner, agent, plugin)):
        raise CohortError("runtime identity is missing frozen sections")
    if dataset.get("scheduleSha256") != schedule_hash:
        raise CohortError("schedule hash does not match runtime identity")
    if dataset.get("taskCount") != schedule.get("taskCount"):
        raise CohortError("schedule taskCount does not match runtime identity")
    if runner.get("runOneSha256") != run_one_hash:
        raise CohortError("run-one source hash does not match runtime identity")
    fixed = schedule["fixedAgent"]
    if fixed.get("agent") != "codex":
        raise CohortError("schedule changes the frozen agent")
    if agent.get("cli") != f"codex-cli {fixed.get('version')}":
        raise CohortError("schedule agent version does not match runtime identity")
    if agent.get("model") != fixed.get("model") or agent.get("reasoningEffort") != fixed.get("effort"):
        raise CohortError("schedule model or effort does not match runtime identity")
    treatment = schedule["treatment"]
    if plugin.get("sourceRevision") != treatment.get("pluginSourceRevision"):
        raise CohortError("schedule treatment revision does not match runtime identity")
    identity_version = plugin.get("version")
    scheduled_version = treatment.get("pluginVersion")
    if not isinstance(identity_version, str) or not isinstance(scheduled_version, str):
        raise CohortError("plugin version identity is missing")
    if identity_version != scheduled_version and not identity_version.startswith(scheduled_version + "+"):
        raise CohortError("schedule treatment version does not match runtime identity")
    if execute and identity.get("executionReady") is not True:
        raise CohortError("runtime identity is not ready for scored execution")


def validate_runner_coupling(schedule_path: Path, identity_path: Path, run_one: Path) -> None:
    adjacent_schedule = run_one.parent / "schedule.json"
    adjacent_identity = run_one.parent / "runtime-identity.json"
    for supplied, adjacent, label in (
        (schedule_path, adjacent_schedule, "schedule"),
        (identity_path, adjacent_identity, "runtime identity"),
    ):
        supplied_hash, _ = hash_file(supplied)
        adjacent_hash, _ = hash_file(adjacent)
        if supplied_hash != adjacent_hash:
            raise CohortError(f"supplied {label} differs from the copy used by run-one")


def build_binding(
    schedule_path: Path,
    identity_path: Path,
    run_one: Path,
    supervisor: Path,
    schedule: dict[str, Any],
    identity_hash: str,
    schedule_hash: str,
    run_one_hash: str,
    supervisor_hash: str,
    deadline_seconds: float,
) -> dict[str, Any]:
    return {
        "schemaVersion": SCHEMA,
        "schedule": {"path": str(schedule_path), "sha256": schedule_hash},
        "runtimeIdentity": {"path": str(identity_path), "sha256": identity_hash},
        "runOne": {"path": str(run_one), "sha256": run_one_hash},
        "supervisor": {"path": str(supervisor), "sha256": supervisor_hash},
        "fixedAgent": schedule["fixedAgent"],
        "treatment": schedule["treatment"],
        "plannedDenominator": schedule["scheduledTrials"],
        "deadlineSecondsPerRow": deadline_seconds,
        "deadlineComponentsSeconds": {"agent": 10_800, "verifier": 1_800, "setupGrace": 600},
    }


def revalidate_binding(binding: dict[str, Any]) -> None:
    for component in ("schedule", "runtimeIdentity", "runOne", "supervisor"):
        identity = binding.get(component)
        if not isinstance(identity, dict) or not isinstance(identity.get("path"), str) or not isinstance(identity.get("sha256"), str):
            raise BoundSourceChanged(component)
        try:
            observed, _ = hash_file(Path(identity["path"]))
        except CohortError as exc:
            raise BoundSourceChanged(component) from exc
        if observed != identity["sha256"]:
            raise BoundSourceChanged(component)


class Journal:
    def __init__(self, path: Path, cohort_id: str):
        self.path = path
        self.cohort_id = cohort_id
        self.events: list[dict[str, Any]] = []
        if path.exists():
            try:
                info = path.lstat()
                if path.is_symlink() or not stat.S_ISREG(info.st_mode):
                    raise CohortError("journal is not a regular non-symlink file")
                if stat.S_IMODE(info.st_mode) & 0o077:
                    raise CohortError("journal permissions are not private")
                lines = path.read_bytes().splitlines()
            except CohortError:
                raise
            except OSError as exc:
                raise CohortError("cannot read cohort journal") from exc
            for index, line in enumerate(lines, 1):
                event = decode_json(line, f"journal line {index}")
                if not isinstance(event, dict):
                    raise CohortError(f"journal line {index} is not an object")
                if event.get("schemaVersion") != JOURNAL_SCHEMA or event.get("sequence") != index:
                    raise CohortError("journal sequence or schema is invalid")
                if event.get("cohortId") != cohort_id:
                    raise CohortError("journal belongs to a different cohort")
                self.events.append(event)

    def append(self, event_type: str, **fields: Any) -> dict[str, Any]:
        event = {
            "schemaVersion": JOURNAL_SCHEMA,
            "cohortId": self.cohort_id,
            "sequence": len(self.events) + 1,
            "recordedAt": utc_now(),
            "event": event_type,
            **fields,
        }
        payload = canonical_bytes(event)
        flags = os.O_WRONLY | os.O_APPEND | os.O_CREAT
        if hasattr(os, "O_NOFOLLOW"):
            flags |= os.O_NOFOLLOW
        descriptor = os.open(self.path, flags, 0o600)
        try:
            view = memoryview(payload)
            while view:
                written = os.write(descriptor, view)
                view = view[written:]
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
        _fsync_directory(self.path.parent)
        self.events.append(event)
        return event

    def has_receipt(self, trial_id: str, receipt_hash: str) -> bool:
        return any(
            event.get("trialId") == trial_id and event.get("receiptSha256") == receipt_hash
            for event in self.events
            if event.get("event") in {"result_recorded", "halt_recorded", "receipt_recovered"}
        )


class CohortLock:
    def __init__(self, path: Path):
        self.path = path
        self.descriptor: int | None = None

    def __enter__(self) -> "CohortLock":
        flags = os.O_RDWR | os.O_CREAT
        if hasattr(os, "O_NOFOLLOW"):
            flags |= os.O_NOFOLLOW
        self.descriptor = os.open(self.path, flags, 0o600)
        try:
            fcntl.flock(self.descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            os.close(self.descriptor)
            self.descriptor = None
            raise CohortError("another supervisor holds the cohort lock") from exc
        return self

    def __exit__(self, exc_type: Any, exc: Any, traceback: Any) -> None:
        if self.descriptor is not None:
            fcntl.flock(self.descriptor, fcntl.LOCK_UN)
            os.close(self.descriptor)
            self.descriptor = None


def reservation_name(row: dict[str, Any]) -> str:
    return f"{row['order']:04d}-{row['trialId']}.json"


def receipt_name(row: dict[str, Any]) -> str:
    return f"{row['order']:04d}-{row['trialId']}.json"


def log_name(row: dict[str, Any]) -> str:
    return f"{row['order']:04d}-{row['trialId']}.log"


def validate_existing_manifest(path: Path, binding: dict[str, Any], cohort_id: str) -> None:
    manifest = read_json(path, "cohort manifest")
    if not isinstance(manifest, dict) or manifest.get("schemaVersion") != MANIFEST_SCHEMA:
        raise CohortError("cohort manifest schema is invalid")
    if manifest.get("cohortId") != cohort_id or manifest.get("binding") != binding:
        raise CohortError("cohort manifest does not match current source and identity hashes")


def initialize_evidence(evidence_dir: Path, binding: dict[str, Any], cohort_id: str) -> None:
    manifest_path = evidence_dir / "cohort-manifest.json"
    if manifest_path.exists():
        validate_existing_manifest(manifest_path, binding, cohort_id)
    else:
        unexpected = [path.name for path in evidence_dir.iterdir() if path.name != "cohort.lock"]
        if unexpected:
            raise CohortError("refusing a non-empty evidence directory without a cohort manifest")
        manifest = {
            "schemaVersion": MANIFEST_SCHEMA,
            "cohortId": cohort_id,
            "createdAt": utc_now(),
            "binding": binding,
        }
        write_json_exclusive(manifest_path, manifest)
    for name in ("reservations", "receipts", "logs"):
        make_private_directory(evidence_dir / name)


def create_reservation(path: Path, cohort_id: str, row: dict[str, Any], binding_hash: str) -> str:
    reservation = {
        "schemaVersion": RESERVATION_SCHEMA,
        "cohortId": cohort_id,
        "bindingSha256": binding_hash,
        "reservedAt": utc_now(),
        "order": row["order"],
        "trialId": row["trialId"],
        "rowSha256": digest_bytes(canonical_bytes(row)),
        "row": row,
        "meaning": "exclusive pre-launch reservation; not a launch request or result",
    }
    return write_json_exclusive(path, reservation)


def validate_reservation(path: Path, cohort_id: str, row: dict[str, Any], binding_hash: str) -> str:
    reservation = read_json(path, "row reservation")
    expected = {
        "schemaVersion": RESERVATION_SCHEMA,
        "cohortId": cohort_id,
        "bindingSha256": binding_hash,
        "order": row["order"],
        "trialId": row["trialId"],
        "rowSha256": digest_bytes(canonical_bytes(row)),
        "row": row,
    }
    if not isinstance(reservation, dict) or any(reservation.get(key) != value for key, value in expected.items()):
        raise CohortError(f"reservation does not match scheduled row {row['trialId']}")
    digest, _ = hash_file(path)
    return digest


def find_direct_trial_result(jobs_dir: Path, trial_id: str) -> tuple[Path, dict[str, Any], str, int]:
    job_dir = jobs_dir / trial_id
    try:
        info = job_dir.lstat()
    except OSError as exc:
        raise CohortError("job did not retain its named result directory") from exc
    if job_dir.is_symlink() or not stat.S_ISDIR(info.st_mode):
        raise CohortError("job result directory is not a regular directory")
    direct_results: list[Path] = []
    try:
        children = list(job_dir.iterdir())
    except OSError as exc:
        raise CohortError("cannot inspect job result directory") from exc
    for child in children:
        if child.is_symlink():
            continue
        try:
            child_info = child.lstat()
        except OSError:
            continue
        result_path = child / "result.json"
        if stat.S_ISDIR(child_info.st_mode) and result_path.is_file() and not result_path.is_symlink():
            direct_results.append(result_path)
    if len(direct_results) != 1:
        raise CohortError("job must contain exactly one direct trial result")
    result_path = direct_results[0]
    result = read_json(result_path, "direct trial result")
    result_hash, result_size = hash_file(result_path)
    if not isinstance(result, dict):
        raise CohortError("direct trial result is not an object")
    if result.get("exception_info") is not None:
        raise CohortError("direct trial result records a process exception")
    verifier = result.get("verifier_result")
    rewards = verifier.get("rewards") if isinstance(verifier, dict) else None
    reward = rewards.get("reward") if isinstance(rewards, dict) and "reward" in rewards else None
    if isinstance(reward, bool) or not isinstance(reward, (int, float)) or not math.isfinite(reward):
        raise CohortError("direct trial reward is missing or not a finite numeric value")
    if reward not in (0, 1):
        raise CohortError("direct trial reward is not binary 0 or 1")
    return result_path, result, result_hash, result_size


def relative_private_path(path: Path, root: Path) -> str:
    try:
        return str(path.relative_to(root))
    except ValueError as exc:
        raise CohortError("evidence path escaped its private root") from exc


def process_group_exists(process_group_id: int) -> bool:
    try:
        os.killpg(process_group_id, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        # Darwin can return EPERM while a terminated process group disappears.
        # Permission denial alone is not proof of absence, so consult the OS
        # process table and fail closed if that query is unusable or still
        # contains the group.
        if sys.platform != "darwin":
            raise
        observed = subprocess.run(
            ["/bin/ps", "-e", "-o", "pgid="],
            capture_output=True,
            text=True,
            check=True,
            timeout=5,
        )
        if not isinstance(observed.stdout, str):
            raise CohortError("cannot verify process-group absence")
        groups = observed.stdout.split()
        if not groups or any(not value.isdecimal() for value in groups):
            raise CohortError("cannot verify process-group absence")
        if process_group_id in {int(value) for value in groups}:
            raise
        return False
    return True


def cleanup_error_kind(error: BaseException) -> str:
    if isinstance(error, PermissionError):
        return "permission_denied"
    if isinstance(error, subprocess.TimeoutExpired):
        return "process_table_query_timeout"
    if isinstance(error, subprocess.CalledProcessError):
        return "process_table_query_failed"
    if isinstance(error, CohortError):
        return "process_group_absence_unverified"
    if isinstance(error, OSError):
        return "process_group_cleanup_os_error"
    return "process_group_cleanup_error"


def terminate_process_group(process: subprocess.Popen[Any]) -> dict[str, Any]:
    cleanup: dict[str, Any] = {
        "attempted": True,
        "termSent": False,
        "killSent": False,
        "absenceVerified": False,
        "errorKind": None,
    }
    try:
        try:
            if process_group_exists(process.pid):
                os.killpg(process.pid, signal.SIGTERM)
                cleanup["termSent"] = True
        except ProcessLookupError:
            pass

        deadline = time.monotonic() + 5
        exists = process_group_exists(process.pid)
        while exists and time.monotonic() < deadline:
            if process.poll() is None:
                try:
                    process.wait(timeout=0.05)
                except subprocess.TimeoutExpired:
                    pass
            else:
                time.sleep(0.05)
            exists = process_group_exists(process.pid)
        if exists:
            try:
                os.killpg(process.pid, signal.SIGKILL)
                cleanup["killSent"] = True
            except ProcessLookupError:
                pass
            deadline = time.monotonic() + 5
            exists = process_group_exists(process.pid)
            while exists and time.monotonic() < deadline:
                if process.poll() is None:
                    try:
                        process.wait(timeout=0.05)
                    except subprocess.TimeoutExpired:
                        pass
                else:
                    time.sleep(0.05)
                exists = process_group_exists(process.pid)
        cleanup["absenceVerified"] = not exists
        if exists:
            cleanup["errorKind"] = "process_group_still_present"
    except (CohortError, OSError, subprocess.SubprocessError) as exc:
        cleanup["errorKind"] = cleanup_error_kind(exc)
    finally:
        if process.poll() is None:
            try:
                process.wait(timeout=1)
            except subprocess.TimeoutExpired:
                if cleanup["errorKind"] is None:
                    cleanup["errorKind"] = "parent_process_wait_timeout"
            except OSError as exc:
                if cleanup["errorKind"] is None:
                    cleanup["errorKind"] = cleanup_error_kind(exc)
    if cleanup["errorKind"] is not None:
        cleanup["absenceVerified"] = False
    return cleanup


def make_receipt(
    cohort_id: str,
    row: dict[str, Any],
    binding_hash: str,
    status_value: str,
    started_at: str,
    elapsed_seconds: float,
    exit_code: int | None,
    log_path: Path,
    evidence_dir: Path,
    *,
    failure_kind: str | None = None,
    result_path: Path | None = None,
    jobs_dir: Path | None = None,
    result_hash: str | None = None,
    result_size: int | None = None,
    reward: int | float | None = None,
    cleanup: dict[str, Any] | None = None,
) -> dict[str, Any]:
    log_hash, log_size = hash_file(log_path)
    receipt: dict[str, Any] = {
        "schemaVersion": RECEIPT_SCHEMA,
        "cohortId": cohort_id,
        "bindingSha256": binding_hash,
        "order": row["order"],
        "trialId": row["trialId"],
        "taskId": row["taskId"],
        "arm": row["arm"],
        "status": status_value,
        "startedAt": started_at,
        "finishedAt": utc_now(),
        "elapsedSeconds": elapsed_seconds,
        "process": {
            "exitCode": exit_code,
            "log": {
                "path": relative_private_path(log_path, evidence_dir),
                "sha256": log_hash,
                "sizeBytes": log_size,
            },
        },
    }
    if failure_kind is not None:
        receipt["failure"] = {"kind": failure_kind}
    if cleanup is not None:
        receipt["processGroupCleanup"] = cleanup
    if result_path is not None:
        if jobs_dir is None or result_hash is None or result_size is None or reward is None:
            raise CohortError("internal result receipt is incomplete")
        receipt["result"] = {
            "path": relative_private_path(result_path, jobs_dir),
            "sha256": result_hash,
            "sizeBytes": result_size,
            "reward": reward,
            "exceptionPresent": False,
            "source": "one direct Pier trial result; aggregate job result excluded",
        }
    return receipt


def validate_receipt(
    path: Path,
    cohort_id: str,
    row: dict[str, Any],
    binding_hash: str,
    jobs_dir: Path,
    evidence_dir: Path,
) -> tuple[dict[str, Any], str]:
    receipt = read_json(path, "row receipt")
    if not isinstance(receipt, dict) or receipt.get("schemaVersion") != RECEIPT_SCHEMA:
        raise CohortError("row receipt schema is invalid")
    expected = {
        "cohortId": cohort_id,
        "bindingSha256": binding_hash,
        "order": row["order"],
        "trialId": row["trialId"],
        "taskId": row["taskId"],
        "arm": row["arm"],
    }
    if any(receipt.get(key) != value for key, value in expected.items()):
        raise CohortError(f"receipt does not match scheduled row {row['trialId']}")
    status_value = receipt.get("status")
    if status_value not in {"completed", "infrastructure_failure", "timeout", "interrupted"}:
        raise CohortError("row receipt has an invalid status")
    process = receipt.get("process")
    log = process.get("log") if isinstance(process, dict) else None
    if not isinstance(log, dict):
        raise CohortError("row receipt has no process log identity")
    log_relative = log.get("path")
    if not isinstance(log_relative, str) or Path(log_relative).is_absolute() or ".." in Path(log_relative).parts:
        raise CohortError("row receipt log path is invalid")
    log_hash, log_size = hash_file(evidence_dir / log_relative)
    if log_hash != log.get("sha256") or log_size != log.get("sizeBytes"):
        raise CohortError("private process log changed after receipt")
    if status_value == "completed":
        result = receipt.get("result")
        if not isinstance(result, dict) or result.get("exceptionPresent") is not False:
            raise CohortError("completed receipt has no validated direct result")
        reward = result.get("reward")
        if isinstance(reward, bool) or not isinstance(reward, (int, float)) or not math.isfinite(reward):
            raise CohortError("completed receipt reward is not finite numeric")
        if reward not in (0, 1):
            raise CohortError("completed receipt reward is not binary 0 or 1")
        relative = result.get("path")
        if not isinstance(relative, str) or Path(relative).is_absolute() or ".." in Path(relative).parts:
            raise CohortError("completed receipt result path is invalid")
        result_path, current_payload, current_hash, current_size = find_direct_trial_result(jobs_dir, row["trialId"])
        if relative_private_path(result_path, jobs_dir) != relative:
            raise CohortError("completed receipt no longer identifies the sole direct trial result")
        current_reward = current_payload["verifier_result"]["rewards"]["reward"]
        if current_hash != result.get("sha256") or current_size != result.get("sizeBytes") or current_reward != reward:
            raise CohortError("completed direct trial result changed after receipt")
    else:
        failure = receipt.get("failure")
        if not isinstance(failure, dict) or not isinstance(failure.get("kind"), str):
            raise CohortError("halt receipt has no bounded failure kind")
    cleanup = receipt.get("processGroupCleanup")
    if cleanup is not None:
        if not isinstance(cleanup, dict):
            raise CohortError("row receipt process-group cleanup is invalid")
        expected_cleanup_types = {
            "attempted": bool,
            "termSent": bool,
            "killSent": bool,
            "absenceVerified": bool,
        }
        if any(not isinstance(cleanup.get(key), value_type) for key, value_type in expected_cleanup_types.items()):
            raise CohortError("row receipt process-group cleanup is incomplete")
        error_kind = cleanup.get("errorKind")
        if error_kind is not None and not isinstance(error_kind, str):
            raise CohortError("row receipt process-group cleanup error kind is invalid")
        if error_kind is not None and cleanup["absenceVerified"]:
            raise CohortError("row receipt claims verified cleanup despite a cleanup error")
    receipt_hash, _ = hash_file(path)
    return receipt, receipt_hash


def summarize(planned: int, completed: int, passes: int, failures: int, status_value: str, halt: dict[str, Any] | None = None) -> dict[str, Any]:
    return {
        "schemaVersion": SCHEMA,
        "status": status_value,
        "plannedDenominator": planned,
        "completedResults": completed,
        "binaryPasses": passes,
        "binaryFailures": failures,
        "incomplete": planned - completed,
        "halt": halt,
    }


def execute_cohort(
    rows: list[dict[str, Any]],
    binding: dict[str, Any],
    jobs_dir: Path,
    evidence_dir: Path,
    run_one: Path,
    deadline_seconds: float,
) -> tuple[dict[str, Any], int]:
    cohort_id = digest_bytes(canonical_bytes(binding))
    binding_hash = cohort_id
    with CohortLock(evidence_dir / "cohort.lock"):
        initialize_evidence(evidence_dir, binding, cohort_id)
        journal = Journal(evidence_dir / "journal.jsonl", cohort_id)
        reservation_dir = evidence_dir / "reservations"
        receipt_dir = evidence_dir / "receipts"
        log_dir = evidence_dir / "logs"

        completed = passes = failures = 0
        first_unreserved_seen = False
        for row in rows:
            reservation_path = reservation_dir / reservation_name(row)
            receipt_path = receipt_dir / receipt_name(row)
            if not reservation_path.exists():
                if receipt_path.exists():
                    raise CohortError("receipt exists without its pre-launch reservation")
                first_unreserved_seen = True
                continue
            if first_unreserved_seen:
                raise CohortError("later row is reserved before an earlier scheduled row")
            validate_reservation(reservation_path, cohort_id, row, binding_hash)
            if not receipt_path.exists():
                return summarize(
                    len(rows), completed, passes, failures, "unknown",
                    {"order": row["order"], "trialId": row["trialId"], "kind": "reserved_without_receipt"},
                ), 3
            receipt, receipt_hash = validate_receipt(receipt_path, cohort_id, row, binding_hash, jobs_dir, evidence_dir)
            if not journal.has_receipt(row["trialId"], receipt_hash):
                journal.append("receipt_recovered", order=row["order"], trialId=row["trialId"], receiptSha256=receipt_hash, status=receipt["status"])
            if receipt["status"] != "completed":
                return summarize(
                    len(rows), completed, passes, failures, "halted",
                    {"order": row["order"], "trialId": row["trialId"], "kind": receipt["status"]},
                ), 3
            reward = receipt["result"]["reward"]
            completed += 1
            if reward == 1:
                passes += 1
            else:
                failures += 1

        for row in rows[completed:]:
            reservation_path = reservation_dir / reservation_name(row)
            receipt_path = receipt_dir / receipt_name(row)
            log_path = log_dir / log_name(row)
            job_path = jobs_dir / row["trialId"]
            if reservation_path.exists():
                raise CohortError("internal resume cursor reached an existing reservation")
            if receipt_path.exists() or log_path.exists():
                return summarize(
                    len(rows), completed, passes, failures, "halted",
                    {"order": row["order"], "trialId": row["trialId"], "kind": "existing_evidence_path"},
                ), 3
            if job_path.exists():
                return summarize(
                    len(rows), completed, passes, failures, "halted",
                    {"order": row["order"], "trialId": row["trialId"], "kind": "existing_job_name"},
                ), 3
            try:
                revalidate_binding(binding)
            except BoundSourceChanged as exc:
                journal.append(
                    "cohort_halted",
                    order=row["order"],
                    trialId=row["trialId"],
                    kind="bound_source_changed",
                    component=exc.component,
                )
                return summarize(
                    len(rows), completed, passes, failures, "halted",
                    {
                        "order": row["order"],
                        "trialId": row["trialId"],
                        "kind": "bound_source_changed",
                        "component": exc.component,
                    },
                ), 3
            reservation_hash = create_reservation(reservation_path, cohort_id, row, binding_hash)
            journal.append(
                "reserved",
                order=row["order"],
                trialId=row["trialId"],
                reservationSha256=reservation_hash,
                meaning="reservation_only",
            )
            started_at = utc_now()
            start = time.monotonic()
            process: subprocess.Popen[Any] | None = None
            failure_kind: str | None = None
            status_value = "infrastructure_failure"
            exit_code: int | None = None
            result_details: tuple[Path, dict[str, Any], str, int] | None = None
            cleanup: dict[str, Any] | None = None
            with log_path.open("xb") as log:
                os.chmod(log_path, 0o600)
                argv = [str(run_one), row["arm"], "score", row["taskId"], row["trialId"]]
                journal.append("launch_requested", order=row["order"], trialId=row["trialId"])
                try:
                    environment = os.environ.copy()
                    environment["JOBS_DIR"] = str(jobs_dir)
                    process = subprocess.Popen(
                        argv,
                        cwd=run_one.parent,
                        env=environment,
                        stdin=subprocess.DEVNULL,
                        stdout=log,
                        stderr=subprocess.STDOUT,
                        start_new_session=True,
                    )
                    journal.append("process_started", order=row["order"], trialId=row["trialId"], pid=process.pid)
                    try:
                        exit_code = process.wait(timeout=deadline_seconds)
                    except subprocess.TimeoutExpired:
                        failure_kind = "deadline_exceeded"
                        status_value = "timeout"
                        cleanup = terminate_process_group(process)
                        exit_code = process.returncode
                    if failure_kind is None and exit_code != 0:
                        failure_kind = "runner_nonzero_exit"
                    if failure_kind is None:
                        try:
                            result_details = find_direct_trial_result(jobs_dir, row["trialId"])
                            status_value = "completed"
                        except CohortError as exc:
                            message = str(exc)
                            if "process exception" in message:
                                failure_kind = "trial_process_exception"
                            elif "reward" in message:
                                failure_kind = "invalid_reward"
                            elif "exactly one" in message:
                                failure_kind = "unexpected_trial_result_count"
                            else:
                                failure_kind = "invalid_trial_result"
                except InterruptedRun:
                    if process is not None:
                        cleanup = terminate_process_group(process)
                        exit_code = process.returncode
                    failure_kind = "operator_interruption"
                    status_value = "interrupted"
                except OSError:
                    if process is not None:
                        cleanup = terminate_process_group(process)
                        exit_code = process.returncode
                    failure_kind = "runner_launch_error"
            elapsed = time.monotonic() - start
            if status_value == "completed" and result_details is not None:
                result_path, result_payload, result_hash, result_size = result_details
                reward = result_payload["verifier_result"]["rewards"]["reward"]
                receipt = make_receipt(
                    cohort_id, row, binding_hash, status_value, started_at, elapsed, exit_code,
                    log_path, evidence_dir, result_path=result_path, jobs_dir=jobs_dir,
                    result_hash=result_hash, result_size=result_size, reward=reward,
                )
            else:
                receipt = make_receipt(
                    cohort_id, row, binding_hash, status_value, started_at, elapsed, exit_code,
                    log_path, evidence_dir, failure_kind=failure_kind or "unknown_infrastructure_failure",
                    cleanup=cleanup,
                )
            receipt_hash = write_json_exclusive(receipt_path, receipt)
            terminal_event = "result_recorded" if status_value == "completed" else "halt_recorded"
            journal.append(
                terminal_event,
                order=row["order"],
                trialId=row["trialId"],
                receiptSha256=receipt_hash,
                status=status_value,
            )
            if status_value != "completed":
                return summarize(
                    len(rows), completed, passes, failures, "unknown" if status_value == "interrupted" else "halted",
                    {"order": row["order"], "trialId": row["trialId"], "kind": status_value},
                ), 130 if status_value == "interrupted" else 3
            completed += 1
            if reward == 1:
                passes += 1
            else:
                failures += 1
        return summarize(len(rows), completed, passes, failures, "completed"), 0


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    source_dir = Path(__file__).resolve().parent
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--dry-run", dest="execute", action="store_false", help="validate and print all planned rows (default)")
    mode.add_argument("--execute", dest="execute", action="store_true", help="run the frozen rows sequentially")
    parser.set_defaults(execute=False)
    parser.add_argument("--schedule", type=Path, default=source_dir / "schedule.json")
    parser.add_argument("--runtime-identity", type=Path, default=source_dir / "runtime-identity.json")
    parser.add_argument("--run-one", type=Path, default=source_dir / "run-one.sh")
    parser.add_argument("--jobs-dir", type=Path, help="existing private absolute Pier jobs directory")
    parser.add_argument("--evidence-dir", type=Path, help="existing private absolute cohort evidence directory")
    parser.add_argument("--deadline-seconds", type=float, default=float(DEFAULT_DEADLINE_SECONDS))
    args = parser.parse_args(argv)
    if not math.isfinite(args.deadline_seconds) or args.deadline_seconds <= 0:
        parser.error("--deadline-seconds must be a finite positive number")
    if args.execute and (args.jobs_dir is None or args.evidence_dir is None):
        parser.error("--execute requires --jobs-dir and --evidence-dir")
    return args


def load_plan(args: argparse.Namespace) -> tuple[list[dict[str, Any]], dict[str, Any], dict[str, Any]]:
    schedule_path = args.schedule.expanduser().resolve(strict=True)
    identity_path = args.runtime_identity.expanduser().resolve(strict=True)
    run_one = args.run_one.expanduser().resolve(strict=True)
    supervisor = Path(__file__).resolve(strict=True)
    schedule_hash, _ = hash_file(schedule_path)
    identity_hash, _ = hash_file(identity_path)
    run_one_hash, _ = hash_file(run_one)
    supervisor_hash, _ = hash_file(supervisor)
    if not os.access(run_one, os.X_OK):
        raise CohortError("run-one is not executable")
    validate_runner_coupling(schedule_path, identity_path, run_one)
    schedule = read_json(schedule_path, "schedule")
    identity = read_json(identity_path, "runtime identity")
    rows = validate_schedule(schedule)
    validate_identity(schedule, identity, schedule_hash, run_one_hash, args.execute)
    binding = build_binding(
        schedule_path, identity_path, run_one, supervisor, schedule, identity_hash,
        schedule_hash, run_one_hash, supervisor_hash, args.deadline_seconds,
    )
    plan = {
        "schemaVersion": SCHEMA,
        "mode": "execute" if args.execute else "dry-run",
        "executionReady": identity.get("executionReady") is True,
        "plannedDenominator": len(rows),
        "cohortId": digest_bytes(canonical_bytes(binding)),
        "binding": binding,
        "rows": [
            {
                "order": row["order"],
                "trialId": row["trialId"],
                "taskId": row["taskId"],
                "arm": row["arm"],
                "argv": [str(run_one), row["arm"], "score", row["taskId"], row["trialId"]],
            }
            for row in rows
        ],
    }
    return rows, binding, plan


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        rows, binding, plan = load_plan(args)
        if not args.execute:
            print(json.dumps(plan, sort_keys=True, indent=2))
            return 0
        jobs_dir = ensure_private_directory(args.jobs_dir, "jobs directory")
        evidence_dir = ensure_private_directory(args.evidence_dir, "evidence directory")
        if paths_overlap(jobs_dir, evidence_dir):
            raise CohortError("jobs and evidence directories must be disjoint")
        source_dir = Path(__file__).resolve().parent
        if paths_overlap(jobs_dir, source_dir) or paths_overlap(evidence_dir, source_dir):
            raise CohortError("private execution directories must be outside the source tree")
        prior_handlers: dict[int, Any] = {}

        def interrupted(signum: int, frame: Any) -> None:
            del frame
            raise InterruptedRun(signum)

        for signum in (signal.SIGINT, signal.SIGTERM):
            prior_handlers[signum] = signal.signal(signum, interrupted)
        try:
            summary, return_code = execute_cohort(
                rows, binding, jobs_dir, evidence_dir,
                args.run_one.expanduser().resolve(strict=True), args.deadline_seconds,
            )
        finally:
            for signum, handler in prior_handlers.items():
                signal.signal(signum, handler)
        print(json.dumps(summary, sort_keys=True, indent=2))
        return return_code
    except InterruptedRun as exc:
        print(json.dumps({"schemaVersion": SCHEMA, "status": "interrupted", "signal": exc.signum}, sort_keys=True), file=sys.stderr)
        return 128 + exc.signum
    except (CohortError, OSError) as exc:
        print(f"run-cohort: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
