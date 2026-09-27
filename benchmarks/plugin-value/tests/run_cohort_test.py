#!/usr/bin/env python3
"""Offline tests for the sequential cohort supervisor."""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock
from types import SimpleNamespace


SOURCE_DIR = Path(__file__).resolve().parents[1]
SUPERVISOR = SOURCE_DIR / "run-cohort.py"
SPEC = importlib.util.spec_from_file_location("plugin_value_run_cohort", SUPERVISOR)
assert SPEC is not None and SPEC.loader is not None
RUN_COHORT = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(RUN_COHORT)


FAKE_RUNNER = r'''#!/usr/bin/env python3
import json
import os
from pathlib import Path
import subprocess
import sys
import time

arm, mode, task_id, trial_id = sys.argv[1:]
assert arm in {"baseline", "treatment"}
assert mode == "score"
calls = Path(os.environ["FAKE_CALLS"])
with calls.open("a", encoding="utf-8") as stream:
    stream.write(json.dumps({"arm": arm, "taskId": task_id, "trialId": trial_id}) + "\n")
    stream.flush()
    os.fsync(stream.fileno())
spec = json.loads(Path(os.environ["FAKE_SPEC"]).read_text(encoding="utf-8"))[trial_id]
if spec.get("spawnChild"):
    child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"])
    Path(os.environ["FAKE_CHILD_PID"]).write_text(str(child.pid), encoding="utf-8")
if spec.get("sleep"):
    time.sleep(spec["sleep"])
if spec.get("exitCode"):
    raise SystemExit(spec["exitCode"])
job = Path(os.environ["JOBS_DIR"]) / trial_id
job.mkdir()
# This aggregate reward is intentionally wrong.  The supervisor must ignore it.
(job / "result.json").write_text(json.dumps({"reward": True}) + "\n", encoding="utf-8")
trial = job / (task_id + "__synthetic")
trial.mkdir()
result = {
    "exception_info": spec.get("exception"),
    "verifier_result": {"rewards": {"reward": spec.get("reward")}},
}
(trial / "result.json").write_text(json.dumps(result) + "\n", encoding="utf-8")
if spec.get("mutatePath"):
    with Path(spec["mutatePath"]).open("a", encoding="utf-8") as stream:
        stream.write(" ")
        stream.flush()
        os.fsync(stream.fileno())
'''


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


class Fixture:
    def __init__(self, root: Path, *, ready: bool = True, tasks: int = 1):
        self.root = root
        self.root.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.root.chmod(0o700)
        self.source = root / "source"
        self.jobs = root / "jobs"
        self.evidence = root / "evidence"
        for directory in (self.source, self.jobs, self.evidence):
            directory.mkdir(mode=0o700)
            directory.chmod(0o700)
        self.run_one = self.source / "run-one.sh"
        self.schedule_path = self.source / "schedule.json"
        self.identity_path = self.source / "runtime-identity.json"
        self.spec_path = root / "fake-spec.json"
        self.calls_path = root / "calls.jsonl"
        self.child_pid_path = root / "child.pid"
        self.run_one.write_text(FAKE_RUNNER, encoding="utf-8")
        self.run_one.chmod(0o700)
        self.rows = []
        order = 0
        for task_number in range(1, tasks + 1):
            task_id = f"task-{task_number}"
            for arm in ("baseline", "treatment"):
                order += 1
                self.rows.append(
                    {
                        "order": order,
                        "pairIndex": task_number,
                        "withinPairOrder": 1 if arm == "baseline" else 2,
                        "trialId": f"{task_id}.r1.{arm}",
                        "taskId": task_id,
                        "repetition": 1,
                        "arm": arm,
                        "taskTree": f"{task_number:040x}",
                        "taskTomlSha256": f"{task_number:064x}",
                    }
                )
        self.schedule = {
            "schemaVersion": "plugin-value-schedule-v1",
            "taskCount": tasks,
            "scheduledTrials": len(self.rows),
            "attemptsPerArmPerTask": 1,
            "fixedAgent": {"agent": "codex", "version": "0.155.0", "model": "gpt-6-astra", "effort": "medium"},
            "treatment": {"pluginSourceRevision": "a" * 40, "pluginVersion": "0.4.0", "allOptionalUsageCaps": None},
            "trials": self.rows,
        }
        self.schedule_path.write_text(json.dumps(self.schedule, sort_keys=True) + "\n", encoding="utf-8")
        self.identity = {
            "schemaVersion": "plugin-value-runtime-identity-v1",
            "executionReady": ready,
            "agent": {"cli": "codex-cli 0.155.0", "model": "gpt-6-astra", "reasoningEffort": "medium"},
            "dataset": {"scheduleSha256": sha256(self.schedule_path), "taskCount": tasks},
            "runner": {"runOneSha256": sha256(self.run_one)},
            "plugin": {"sourceRevision": "a" * 40, "version": "0.4.0+test"},
        }
        self.identity_path.write_text(json.dumps(self.identity, sort_keys=True) + "\n", encoding="utf-8")
        self.set_spec({row["trialId"]: {"reward": 1} for row in self.rows})

    def set_spec(self, value: dict[str, object]) -> None:
        self.spec_path.write_text(json.dumps(value) + "\n", encoding="utf-8")

    def environment(self) -> dict[str, str]:
        environment = os.environ.copy()
        environment.update(
            {
                "FAKE_SPEC": str(self.spec_path),
                "FAKE_CALLS": str(self.calls_path),
                "FAKE_CHILD_PID": str(self.child_pid_path),
            }
        )
        return environment

    def command(self, *extra: str, execute: bool = True, deadline: float = 3.0) -> list[str]:
        command = [
            sys.executable,
            str(SUPERVISOR),
            "--schedule",
            str(self.schedule_path),
            "--runtime-identity",
            str(self.identity_path),
            "--run-one",
            str(self.run_one),
            "--deadline-seconds",
            str(deadline),
        ]
        if execute:
            command.extend(["--execute", "--jobs-dir", str(self.jobs), "--evidence-dir", str(self.evidence)])
        else:
            command.append("--dry-run")
        command.extend(extra)
        return command

    def run(self, *extra: str, execute: bool = True, deadline: float = 3.0) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            self.command(*extra, execute=execute, deadline=deadline),
            env=self.environment(),
            text=True,
            capture_output=True,
            timeout=15,
        )

    def calls(self) -> list[dict[str, str]]:
        if not self.calls_path.exists():
            return []
        return [json.loads(line) for line in self.calls_path.read_text(encoding="utf-8").splitlines()]


class RunCohortTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory(prefix="run-cohort-test-")
        self.addCleanup(self.temporary.cleanup)
        self.fixture = Fixture(Path(self.temporary.name))

    def test_dry_run_reports_full_denominator_when_execution_is_not_ready(self) -> None:
        fixture = Fixture(Path(self.temporary.name) / "not-ready", ready=False, tasks=2)
        result = fixture.run(execute=False)
        self.assertEqual(result.returncode, 0, result.stderr)
        plan = json.loads(result.stdout)
        self.assertFalse(plan["executionReady"])
        self.assertEqual(plan["plannedDenominator"], 4)
        self.assertEqual([row["trialId"] for row in plan["rows"]], [row["trialId"] for row in fixture.rows])
        self.assertEqual(plan["rows"][0]["argv"][-1], fixture.rows[0]["trialId"])
        self.assertEqual(fixture.calls(), [])

    def test_execute_rejects_not_ready_before_creating_evidence(self) -> None:
        fixture = Fixture(Path(self.temporary.name) / "not-ready-execute", ready=False)
        result = fixture.run()
        self.assertEqual(result.returncode, 2)
        self.assertIn("not ready for scored execution", result.stderr)
        self.assertEqual(list(fixture.evidence.iterdir()), [])
        self.assertEqual(fixture.calls(), [])

    def test_schedule_hash_mismatch_is_rejected_before_execution(self) -> None:
        self.fixture.schedule["trials"][0]["taskTree"] = "f" * 40
        self.fixture.schedule_path.write_text(json.dumps(self.fixture.schedule, sort_keys=True) + "\n", encoding="utf-8")
        result = self.fixture.run(execute=False)
        self.assertEqual(result.returncode, 2)
        self.assertIn("schedule hash does not match runtime identity", result.stderr)
        self.assertEqual(self.fixture.calls(), [])

    def test_zero_reward_is_an_ordinary_result_and_does_not_stop_progression(self) -> None:
        first, second = self.fixture.rows
        self.fixture.set_spec({first["trialId"]: {"reward": 0}, second["trialId"]: {"reward": 1}})
        result = self.fixture.run()
        self.assertEqual(result.returncode, 0, result.stderr)
        summary = json.loads(result.stdout)
        self.assertEqual(summary["status"], "completed")
        self.assertEqual(summary["completedResults"], 2)
        self.assertEqual(summary["binaryPasses"], 1)
        self.assertEqual(summary["binaryFailures"], 1)
        self.assertEqual([call["trialId"] for call in self.fixture.calls()], [first["trialId"], second["trialId"]])
        events = [json.loads(line) for line in (self.fixture.evidence / "journal.jsonl").read_text().splitlines()]
        self.assertEqual([event["sequence"] for event in events], list(range(1, len(events) + 1)))
        self.assertEqual(sum(event["event"] == "reserved" for event in events), 2)
        self.assertTrue(all(event.get("meaning") == "reservation_only" for event in events if event["event"] == "reserved"))

    def test_existing_job_name_is_never_overwritten_or_reserved(self) -> None:
        first = self.fixture.rows[0]
        existing = self.fixture.jobs / first["trialId"]
        existing.mkdir()
        marker = existing / "preserve.txt"
        marker.write_text("keep\n", encoding="utf-8")
        result = self.fixture.run()
        self.assertEqual(result.returncode, 3, result.stderr)
        summary = json.loads(result.stdout)
        self.assertEqual(summary["halt"]["kind"], "existing_job_name")
        self.assertEqual(marker.read_text(encoding="utf-8"), "keep\n")
        self.assertEqual(self.fixture.calls(), [])
        reservation = self.fixture.evidence / "reservations" / RUN_COHORT.reservation_name(first)
        self.assertFalse(reservation.exists())

    def test_boolean_reward_halts_and_leaves_remaining_denominator_unstarted(self) -> None:
        first, second = self.fixture.rows
        self.fixture.set_spec({first["trialId"]: {"reward": True}, second["trialId"]: {"reward": 1}})
        result = self.fixture.run()
        self.assertEqual(result.returncode, 3, result.stderr)
        summary = json.loads(result.stdout)
        self.assertEqual(summary["status"], "halted")
        self.assertEqual(summary["completedResults"], 0)
        self.assertEqual(summary["incomplete"], 2)
        self.assertEqual([call["trialId"] for call in self.fixture.calls()], [first["trialId"]])
        receipt = json.loads((self.fixture.evidence / "receipts" / RUN_COHORT.receipt_name(first)).read_text())
        self.assertEqual(receipt["status"], "infrastructure_failure")
        self.assertEqual(receipt["failure"]["kind"], "invalid_reward")
        self.assertFalse((self.fixture.evidence / "reservations" / RUN_COHORT.reservation_name(second)).exists())

    def test_unknown_reward_is_not_converted_to_a_task_failure(self) -> None:
        first, second = self.fixture.rows
        self.fixture.set_spec({first["trialId"]: {"reward": None}, second["trialId"]: {"reward": 1}})
        result = self.fixture.run()
        self.assertEqual(result.returncode, 3, result.stderr)
        receipt = json.loads((self.fixture.evidence / "receipts" / RUN_COHORT.receipt_name(first)).read_text())
        self.assertEqual(receipt["status"], "infrastructure_failure")
        self.assertEqual(receipt["failure"]["kind"], "invalid_reward")
        self.assertEqual(self.fixture.calls(), [{"arm": first["arm"], "taskId": first["taskId"], "trialId": first["trialId"]}])

    def test_fractional_reward_is_not_converted_to_a_verified_pass(self) -> None:
        first, second = self.fixture.rows
        self.fixture.set_spec({first["trialId"]: {"reward": 0.5}, second["trialId"]: {"reward": 1}})
        result = self.fixture.run()
        self.assertEqual(result.returncode, 3, result.stderr)
        summary = json.loads(result.stdout)
        self.assertEqual(summary["completedResults"], 0)
        self.assertEqual(summary["binaryPasses"], 0)
        receipt = json.loads((self.fixture.evidence / "receipts" / RUN_COHORT.receipt_name(first)).read_text())
        self.assertEqual(receipt["failure"]["kind"], "invalid_reward")
        self.assertEqual([call["trialId"] for call in self.fixture.calls()], [first["trialId"]])

    def test_bound_source_mutation_between_rows_halts_before_next_reservation(self) -> None:
        first, second = self.fixture.rows
        self.fixture.set_spec(
            {
                first["trialId"]: {"reward": 1, "mutatePath": str(self.fixture.schedule_path)},
                second["trialId"]: {"reward": 1},
            }
        )
        result = self.fixture.run()
        self.assertEqual(result.returncode, 3, result.stderr)
        summary = json.loads(result.stdout)
        self.assertEqual(summary["completedResults"], 1)
        self.assertEqual(summary["incomplete"], 1)
        self.assertEqual(summary["halt"]["kind"], "bound_source_changed")
        self.assertEqual(summary["halt"]["component"], "schedule")
        self.assertEqual([call["trialId"] for call in self.fixture.calls()], [first["trialId"]])
        self.assertFalse((self.fixture.evidence / "reservations" / RUN_COHORT.reservation_name(second)).exists())
        events = [json.loads(line) for line in (self.fixture.evidence / "journal.jsonl").read_text().splitlines()]
        self.assertEqual(events[-1]["event"], "cohort_halted")
        self.assertEqual(events[-1]["component"], "schedule")

    def test_trial_exception_halts_without_copying_exception_contents(self) -> None:
        first, second = self.fixture.rows
        sentinel = "hidden-verifier-exception-sentinel"
        self.fixture.set_spec(
            {
                first["trialId"]: {"reward": 1, "exception": {"message": sentinel}},
                second["trialId"]: {"reward": 1},
            }
        )
        result = self.fixture.run()
        self.assertEqual(result.returncode, 3, result.stderr)
        receipt_path = self.fixture.evidence / "receipts" / RUN_COHORT.receipt_name(first)
        receipt_text = receipt_path.read_text(encoding="utf-8")
        receipt = json.loads(receipt_text)
        self.assertEqual(receipt["failure"]["kind"], "trial_process_exception")
        self.assertNotIn(sentinel, receipt_text)
        self.assertNotIn(sentinel, result.stdout)
        self.assertEqual([call["trialId"] for call in self.fixture.calls()], [first["trialId"]])

    def test_completed_prefix_resumes_without_rerunning_reserved_row(self) -> None:
        first, second = self.fixture.rows
        deadline = 3.0
        args = argparse.Namespace(
            execute=True,
            schedule=self.fixture.schedule_path,
            runtime_identity=self.fixture.identity_path,
            run_one=self.fixture.run_one,
            deadline_seconds=deadline,
        )
        rows, binding, _ = RUN_COHORT.load_plan(args)
        cohort_id = RUN_COHORT.digest_bytes(RUN_COHORT.canonical_bytes(binding))
        RUN_COHORT.initialize_evidence(self.fixture.evidence, binding, cohort_id)
        journal = RUN_COHORT.Journal(self.fixture.evidence / "journal.jsonl", cohort_id)
        reservation_path = self.fixture.evidence / "reservations" / RUN_COHORT.reservation_name(first)
        reservation_hash = RUN_COHORT.create_reservation(reservation_path, cohort_id, first, cohort_id)
        journal.append(
            "reserved",
            order=first["order"],
            trialId=first["trialId"],
            reservationSha256=reservation_hash,
            meaning="reservation_only",
        )
        seed_log = self.fixture.evidence / "logs" / RUN_COHORT.log_name(first)
        environment = self.fixture.environment()
        environment["JOBS_DIR"] = str(self.fixture.jobs)
        with seed_log.open("xb") as log:
            seeded = subprocess.run(
                [str(self.fixture.run_one), first["arm"], "score", first["taskId"], first["trialId"]],
                env=environment,
                stdout=log,
                stderr=subprocess.STDOUT,
                check=False,
            )
        self.assertEqual(seeded.returncode, 0)
        result_path, result_payload, result_hash, result_size = RUN_COHORT.find_direct_trial_result(self.fixture.jobs, first["trialId"])
        reward = result_payload["verifier_result"]["rewards"]["reward"]
        receipt = RUN_COHORT.make_receipt(
            cohort_id,
            first,
            cohort_id,
            "completed",
            RUN_COHORT.utc_now(),
            0.0,
            0,
            seed_log,
            self.fixture.evidence,
            result_path=result_path,
            jobs_dir=self.fixture.jobs,
            result_hash=result_hash,
            result_size=result_size,
            reward=reward,
        )
        receipt_path = self.fixture.evidence / "receipts" / RUN_COHORT.receipt_name(first)
        receipt_hash = RUN_COHORT.write_json_exclusive(receipt_path, receipt)
        journal.append(
            "result_recorded",
            order=first["order"],
            trialId=first["trialId"],
            receiptSha256=receipt_hash,
            status="completed",
        )

        resumed = self.fixture.run(deadline=deadline)
        self.assertEqual(resumed.returncode, 0, resumed.stderr)
        self.assertEqual(json.loads(resumed.stdout)["completedResults"], 2)
        self.assertEqual([call["trialId"] for call in self.fixture.calls()], [first["trialId"], second["trialId"]])
        again = self.fixture.run(deadline=deadline)
        self.assertEqual(again.returncode, 0, again.stderr)
        self.assertEqual([call["trialId"] for call in self.fixture.calls()], [first["trialId"], second["trialId"]])

    def test_reserved_row_without_receipt_reports_unknown_and_is_not_rerun(self) -> None:
        first = self.fixture.rows[0]
        args = argparse.Namespace(
            execute=True,
            schedule=self.fixture.schedule_path,
            runtime_identity=self.fixture.identity_path,
            run_one=self.fixture.run_one,
            deadline_seconds=3.0,
        )
        _, binding, _ = RUN_COHORT.load_plan(args)
        cohort_id = RUN_COHORT.digest_bytes(RUN_COHORT.canonical_bytes(binding))
        RUN_COHORT.initialize_evidence(self.fixture.evidence, binding, cohort_id)
        RUN_COHORT.create_reservation(
            self.fixture.evidence / "reservations" / RUN_COHORT.reservation_name(first),
            cohort_id,
            first,
            cohort_id,
        )
        result = self.fixture.run()
        self.assertEqual(result.returncode, 3, result.stderr)
        summary = json.loads(result.stdout)
        self.assertEqual(summary["status"], "unknown")
        self.assertEqual(summary["halt"]["kind"], "reserved_without_receipt")
        self.assertEqual(self.fixture.calls(), [])

    def test_darwin_permission_probe_requires_process_table_proof_of_absence(self) -> None:
        with mock.patch.object(RUN_COHORT.sys, "platform", "darwin"), mock.patch.object(
            RUN_COHORT.os, "killpg", side_effect=PermissionError(1, "Operation not permitted")
        ), mock.patch.object(RUN_COHORT.subprocess, "run") as ps:
            ps.return_value = SimpleNamespace(stdout="1\n42\n")
            self.assertFalse(RUN_COHORT.process_group_exists(424242))
            ps.return_value = SimpleNamespace(stdout="1\n424242\n")
            with self.assertRaises(PermissionError):
                RUN_COHORT.process_group_exists(424242)

    def test_darwin_process_table_uncertainty_is_never_treated_as_absence(self) -> None:
        for output in ("", "1\nnot-a-pgid\n"):
            with self.subTest(output=output), mock.patch.object(RUN_COHORT.sys, "platform", "darwin"), mock.patch.object(
                RUN_COHORT.os, "killpg", side_effect=PermissionError(1, "Operation not permitted")
            ), mock.patch.object(RUN_COHORT.subprocess, "run", return_value=SimpleNamespace(stdout=output)):
                with self.assertRaises(RUN_COHORT.CohortError):
                    RUN_COHORT.process_group_exists(424242)
        query_failure = subprocess.CalledProcessError(1, ["/bin/ps"])
        with mock.patch.object(RUN_COHORT.sys, "platform", "darwin"), mock.patch.object(
            RUN_COHORT.os, "killpg", side_effect=PermissionError(1, "Operation not permitted")
        ), mock.patch.object(RUN_COHORT.subprocess, "run", side_effect=query_failure):
            with self.assertRaises(subprocess.CalledProcessError):
                RUN_COHORT.process_group_exists(424242)

    def test_timeout_receipt_survives_cleanup_probe_failure_without_claiming_absence(self) -> None:
        first, second = self.fixture.rows
        self.fixture.set_spec(
            {
                first["trialId"]: {"reward": 1, "sleep": 60},
                second["trialId"]: {"reward": 1},
            }
        )
        args = argparse.Namespace(
            execute=True,
            schedule=self.fixture.schedule_path,
            runtime_identity=self.fixture.identity_path,
            run_one=self.fixture.run_one,
            deadline_seconds=0.2,
        )
        rows, binding, _ = RUN_COHORT.load_plan(args)
        with mock.patch.dict(os.environ, self.fixture.environment(), clear=False), mock.patch.object(
            RUN_COHORT,
            "process_group_exists",
            side_effect=[True, PermissionError(1, "Operation not permitted")],
        ):
            summary, return_code = RUN_COHORT.execute_cohort(
                rows,
                binding,
                self.fixture.jobs,
                self.fixture.evidence,
                self.fixture.run_one,
                0.2,
            )
        self.assertEqual(return_code, 3)
        self.assertEqual(summary["halt"]["kind"], "timeout")
        receipt = json.loads((self.fixture.evidence / "receipts" / RUN_COHORT.receipt_name(first)).read_text())
        self.assertEqual(receipt["status"], "timeout")
        cleanup = receipt["processGroupCleanup"]
        self.assertTrue(cleanup["termSent"])
        self.assertFalse(cleanup["absenceVerified"])
        self.assertEqual(cleanup["errorKind"], "permission_denied")
        self.assertFalse((self.fixture.evidence / "reservations" / RUN_COHORT.reservation_name(second)).exists())

    def test_timeout_terminates_the_child_process_group_and_records_receipt(self) -> None:
        first, second = self.fixture.rows
        self.fixture.set_spec(
            {
                first["trialId"]: {"reward": 1, "spawnChild": True, "sleep": 60},
                second["trialId"]: {"reward": 1},
            }
        )
        result = self.fixture.run(deadline=0.2)
        self.assertEqual(result.returncode, 3, result.stderr)
        summary = json.loads(result.stdout)
        self.assertEqual(summary["halt"]["kind"], "timeout")
        receipt = json.loads((self.fixture.evidence / "receipts" / RUN_COHORT.receipt_name(first)).read_text())
        self.assertEqual(receipt["status"], "timeout")
        self.assertEqual(receipt["failure"]["kind"], "deadline_exceeded")
        self.assertTrue(receipt["processGroupCleanup"]["absenceVerified"])
        self.assertIsNone(receipt["processGroupCleanup"]["errorKind"])
        self.assertEqual([call["trialId"] for call in self.fixture.calls()], [first["trialId"]])
        child_pid = int(self.fixture.child_pid_path.read_text(encoding="utf-8"))
        for _ in range(100):
            try:
                os.kill(child_pid, 0)
            except ProcessLookupError:
                break
            time.sleep(0.02)
        else:
            self.fail("timeout left the synthetic grandchild process alive")


if __name__ == "__main__":
    unittest.main()
