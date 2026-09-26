import asyncio
import base64
import csv
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import py_compile
import subprocess
import sys
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from unittest import mock


PLUGIN_VALUE_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PLUGIN_VALUE_DIR))

try:
    import pier  # noqa: F401
except ModuleNotFoundError:
    if site_packages := os.environ.get("PIER_SITE_PACKAGES"):
        sys.path.append(site_packages)

from pier.environments.docker.docker import DockerEnvironment
from pier.models.agent.context import AgentContext
from pier.models.task.config import EnvironmentConfig
from pier.models.trial.paths import TrialPaths

from runtime import (
    PINNED_CODEX_VERSION,
    PINNED_EFFORT,
    PINNED_MODEL,
    PINNED_NODE_VERSION,
    RUNTIME_MANIFEST_NAME,
    RUNTIME_MANIFEST_SCHEMA,
    RUNTIME_MOUNT,
    PluginValueCodex,
    PluginValueDockerEnvironment,
    _FROZEN_TASK_IDS,
    _load_image_identities,
    _sha256_file,
    _tree_sha256,
    _validate_private_launch_paths,
    validate_benchmark_inputs,
    validate_bootstrap_runtime,
    validate_shared_runtime,
)


IMAGE_LEDGER = PLUGIN_VALUE_DIR / "image-identities.json"
IMAGE_LEDGER_SHA256 = _sha256_file(IMAGE_LEDGER)
FIRST_TASK = "ipython-session-bundle-replay"
FIRST_TAG = (
    "public.ecr.aws/d3j8x8q7/swe-bench-202605:"
    "kh75kn07w0t92m4xxd3dy0cgp982jz6m-v1.1"
)
FIRST_PINNED = (
    "public.ecr.aws/d3j8x8q7/swe-bench-202605@"
    "sha256:ba83b5e9940114642ce64dd3644b4740c6776cba16b964964703422d3cdec4e1"
)


class FakeTaskEnvironment:
    def __init__(self, docker_image=FIRST_TAG, os_name="linux"):
        self.docker_image = docker_image
        self.os = os_name

    def model_copy(self, *, deep, update):
        assert deep is True
        return FakeTaskEnvironment(
            docker_image=update.get("docker_image", self.docker_image),
            os_name=self.os,
        )


class RuntimeFixture(unittest.TestCase):
    def setUp(self):
        self.temp = TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def build_runtime(self):
        runtime_root = self.root / "runtime"
        bin_dir = runtime_root / "bin"
        bin_dir.mkdir(parents=True)
        codex = bin_dir / "codex"
        node = bin_dir / "node"
        codex.write_text("#!/bin/sh\necho codex-cli 0.155.0\n", encoding="utf-8")
        node.write_text("#!/bin/sh\necho v22.23.2\n", encoding="utf-8")
        codex.chmod(0o555)
        node.chmod(0o555)
        bin_dir.chmod(0o555)

        manifest = {
            "schemaVersion": RUNTIME_MANIFEST_SCHEMA,
            "platform": "linux/amd64",
            "treeSha256": _tree_sha256(runtime_root),
            "executables": {
                "codex": {
                    "path": "bin/codex",
                    "version": PINNED_CODEX_VERSION,
                    "sha256": _sha256_file(codex),
                },
                "node": {
                    "path": "bin/node",
                    "version": PINNED_NODE_VERSION,
                    "sha256": _sha256_file(node),
                },
            },
        }
        manifest_path = runtime_root / RUNTIME_MANIFEST_NAME
        manifest_path.write_text(json.dumps(manifest, sort_keys=True) + "\n", encoding="utf-8")
        manifest_path.chmod(0o444)
        runtime_root.chmod(0o555)

        def thaw():
            for path in sorted(runtime_root.rglob("*"), reverse=True):
                if not path.is_symlink():
                    path.chmod(0o755 if path.is_dir() else 0o644)
            runtime_root.chmod(0o755)

        self.addCleanup(thaw)
        return runtime_root

    def build_host_executables(self):
        host = self.root / "host"
        host.mkdir(exist_ok=True)
        node = host / "node"
        codex = host / "codex"
        docker = host / "docker"
        for path in (node, codex, docker):
            if path.exists():
                path.chmod(0o700)
        node.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
        codex.write_text("#!/bin/sh\necho codex-cli 0.155.0\n", encoding="utf-8")
        docker.write_text(
            "#!/bin/sh\necho 'Docker version 29.7.1, build fixture'\n",
            encoding="utf-8",
        )
        node.chmod(0o500)
        codex.chmod(0o500)
        docker.chmod(0o500)
        return node, codex, docker

    def git(self, repository, *arguments):
        completed = subprocess.run(
            ["git", "-C", str(repository), *arguments],
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(completed.returncode, 0, completed.stderr)
        return completed.stdout.strip()

    def build_frozen_tasks(self):
        repository = self.root / "deep-swe"
        tasks = repository / "tasks"
        tasks.mkdir(parents=True)
        for task_id in sorted(_FROZEN_TASK_IDS):
            task = tasks / task_id
            task.mkdir()
            (task / "task.toml").write_text(
                f'[task]\nid = "{task_id}"\n', encoding="utf-8"
            )
        self.git(repository, "init", "-q")
        self.git(repository, "config", "user.email", "benchmark@example.invalid")
        self.git(repository, "config", "user.name", "Benchmark Fixture")
        self.git(repository, "add", "tasks")
        self.git(repository, "commit", "-qm", "fixture")
        commit = self.git(repository, "rev-parse", "HEAD")
        metadata_tasks = []
        for task_id in sorted(_FROZEN_TASK_IDS):
            task_toml = tasks / task_id / "task.toml"
            metadata_tasks.append(
                {
                    "taskId": task_id,
                    "gitTree": self.git(repository, "rev-parse", f"HEAD:tasks/{task_id}"),
                    "taskTomlBlob": self.git(
                        repository, "rev-parse", f"HEAD:tasks/{task_id}/task.toml"
                    ),
                    "taskTomlSha256": _sha256_file(task_toml),
                }
            )
        metadata = {
            "schemaVersion": "jev-deepswe-runtime-metadata-v1",
            "provenance": {"commit": commit},
            "tasks": metadata_tasks,
        }
        metadata_path = self.root / "task-runtime-metadata.json"
        metadata_path.write_text(json.dumps(metadata) + "\n", encoding="utf-8")
        trials = []
        indexed = {item["taskId"]: item for item in metadata_tasks}
        for pair_index, task_id in enumerate(sorted(_FROZEN_TASK_IDS), 1):
            for within_pair, arm in enumerate(("baseline", "treatment"), 1):
                trials.append(
                    {
                        "order": len(trials) + 1,
                        "pairIndex": pair_index,
                        "withinPairOrder": within_pair,
                        "trialId": f"{task_id}.r1.{arm}",
                        "taskId": task_id,
                        "repetition": 1,
                        "arm": arm,
                        "taskTree": indexed[task_id]["gitTree"],
                        "taskTomlSha256": indexed[task_id]["taskTomlSha256"],
                    }
                )
        schedule = {
            "schemaVersion": "plugin-value-schedule-v1",
            "datasetCommit": commit,
            "taskCount": 20,
            "scheduledTrials": 40,
            "fixedAgent": {
                "agent": "codex",
                "version": PINNED_CODEX_VERSION,
                "model": PINNED_MODEL,
                "effort": PINNED_EFFORT,
            },
            "trials": trials,
        }
        schedule_path = self.root / "schedule.json"
        schedule_path.write_text(json.dumps(schedule) + "\n", encoding="utf-8")
        return tasks, metadata_path, schedule_path


class SharedRuntimeTests(RuntimeFixture):
    def test_valid_bundle_has_fixed_versions_and_digests(self):
        root = self.build_runtime()
        identity = validate_shared_runtime(root)
        self.assertEqual(identity.root, root.resolve())
        self.assertEqual(identity.codex.version, PINNED_CODEX_VERSION)
        self.assertEqual(identity.node.version, PINNED_NODE_VERSION)
        self.assertEqual(identity.tree_sha256, _tree_sha256(root))

    def test_bundle_tampering_fails_closed(self):
        root = self.build_runtime()
        codex = root / "bin" / "codex"
        codex.chmod(0o755)
        codex.write_text("#!/bin/sh\necho changed\n", encoding="utf-8")
        codex.chmod(0o555)
        with self.assertRaisesRegex(ValueError, "sha256 mismatch"):
            validate_shared_runtime(root)

    def test_writable_bundle_fails_closed(self):
        root = self.build_runtime()
        root.chmod(0o755)
        with self.assertRaisesRegex(ValueError, "writable"):
            validate_shared_runtime(root)


class BootstrapIntegrityTests(RuntimeFixture):
    @staticmethod
    def _record_hash(content):
        encoded = base64.urlsafe_b64encode(hashlib.sha256(content).digest()).rstrip(b"=")
        return "sha256=" + encoded.decode("ascii")

    def _build_distribution(self, site_packages, name, version, package, entrypoints):
        package_dir = site_packages / package
        package_dir.mkdir()
        payload = package_dir / "__init__.py"
        payload.write_bytes(f'VERSION = "{version}"\n'.encode())
        dist_info = site_packages / f"{name.replace('-', '_')}-{version}.dist-info"
        dist_info.mkdir()
        metadata = dist_info / "METADATA"
        metadata.write_text(
            f"Metadata-Version: 2.1\nName: {name}\nVersion: {version}\n",
            encoding="utf-8",
        )
        direct_url = None
        if name == "datacurve-pier":
            direct_url = dist_info / "direct_url.json"
            direct_url.write_text(
                json.dumps({"vcs_info": {"commit_id": "fixture-commit"}}) + "\n",
                encoding="utf-8",
            )
        rows = []
        for path in (payload, metadata, direct_url):
            if path is None:
                continue
            content = path.read_bytes()
            rows.append(
                [
                    path.relative_to(site_packages).as_posix(),
                    self._record_hash(content),
                    str(len(content)),
                ]
            )
        for relative in entrypoints:
            rows.append([relative, self._record_hash(b"unused fixture"), "14"])
        record = dist_info / "RECORD"
        rows.append([record.relative_to(site_packages).as_posix(), "", ""])
        buffer = io.StringIO(newline="")
        csv.writer(buffer, lineterminator="\n").writerows(rows)
        record.write_text(buffer.getvalue(), encoding="utf-8")
        identity = {
            "version": version,
            "recordSha256": _sha256_file(record),
        }
        if direct_url is not None:
            identity["directUrl"] = {
                "commit": "fixture-commit",
                "sha256": _sha256_file(direct_url),
            }
        return payload, identity

    def test_real_bootstrap_authenticates_distribution_payloads_and_launchers(self):
        runtime = self.root / "pier-runtime"
        site_packages = runtime / "lib" / "python3.12" / "site-packages"
        (runtime / "bin").mkdir(parents=True)
        site_packages.mkdir(parents=True)
        (runtime / "bin" / "python").symlink_to(Path(sys.executable).resolve())
        pier_payload, pier_identity = self._build_distribution(
            site_packages,
            "datacurve-pier",
            "0.3.1",
            "pier",
            ["../../../bin/pier"],
        )
        _, harbor_identity = self._build_distribution(
            site_packages,
            "harbor",
            "0.20.0",
            "harbor",
            ["../../../bin/harbor", "../../../bin/hb", "../../../bin/hr"],
        )
        adapter = self.root / "runtime.py"
        launcher = self.root / "pier-main.py"
        run_one = self.root / "run-one.sh"
        for path, content in (
            (adapter, "adapter fixture\n"),
            (launcher, "launcher fixture\n"),
            (run_one, "run-one fixture\n"),
        ):
            path.write_text(content, encoding="utf-8")
        temporary = self.root / "temporary"
        jobs = self.root / "jobs"
        tasks = self.root / "tasks"
        shared = self.root / "shared"
        for path in (temporary, jobs, tasks, shared):
            path.mkdir(mode=0o700)
        identity = self.root / "runtime-identity.json"
        identity.write_text(
            json.dumps(
                {
                    "runner": {
                        "python": {
                            "version": ".".join(map(str, sys.version_info[:3])),
                            "sha256": _sha256_file(Path(sys.executable).resolve()),
                        },
                        "adapterSha256": _sha256_file(adapter),
                        "launcherSha256": _sha256_file(launcher),
                        "runOneSha256": _sha256_file(run_one),
                        "pierDistribution": pier_identity,
                        "harborDistribution": harbor_identity,
                    }
                }
            ),
            encoding="utf-8",
        )
        parameters = dict(
            pier_runtime=runtime,
            runtime_identity_path=identity,
            adapter_path=adapter,
            launcher_path=launcher,
            run_one_path=run_one,
            temporary_dir=temporary,
            jobs_dir=jobs,
            tasks_dir=tasks,
            shared_runtime_dir=shared,
        )
        old_path = list(sys.path)
        try:
            self.assertEqual(
                validate_bootstrap_runtime(**parameters)["pierVersion"], "0.3.1"
            )
            pier_payload.write_text('VERSION = "tampered"\n', encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "installed file (hash|size) drifted"):
                validate_bootstrap_runtime(**parameters)
        finally:
            sys.path[:] = old_path

    def test_launcher_executes_authenticated_source_instead_of_adjacent_pyc(self):
        site_packages = self.root / "site-packages"
        site_packages.mkdir()
        adapter = self.root / "runtime.py"
        malicious = "VALUE = 'evil'\n"
        authenticated = "VALUE = 'safe'\n"
        self.assertEqual(len(malicious), len(authenticated))
        adapter.write_text(malicious, encoding="utf-8")
        metadata = adapter.stat()
        py_compile.compile(str(adapter), doraise=True)
        adapter.write_text(authenticated, encoding="utf-8")
        os.utime(adapter, ns=(metadata.st_atime_ns, metadata.st_mtime_ns))

        spec = importlib.util.spec_from_file_location("pyc_control", adapter)
        assert spec is not None and spec.loader is not None
        pyc_control = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(pyc_control)
        self.assertEqual(pyc_control.VALUE, "evil")

        namespace = {"__name__": "pinned_launcher_fixture"}
        launcher = PLUGIN_VALUE_DIR / "pier-main.py"
        exec(compile(launcher.read_bytes(), str(launcher), "exec"), namespace)
        with mock.patch.dict(
            os.environ,
            {
                "PLUGIN_VALUE_PINNED_SITE_PACKAGES": str(site_packages),
                "PLUGIN_VALUE_ADAPTER_PATH": str(adapter),
            },
        ):
            module = namespace["_load_adapter"]()
        self.assertEqual(module.VALUE, "safe")
        sys.modules.pop("plugin_value_runtime", None)

    def test_temporary_directory_must_be_private_and_disjoint(self):
        jobs = self.root / "jobs"
        tasks = self.root / "tasks"
        runtime = self.root / "runtime-root"
        pier = self.root / "pier-runtime"
        temporary = self.root / "temporary"
        for path in (jobs, tasks, runtime, pier, temporary):
            path.mkdir()
            path.chmod(0o700)
        _validate_private_launch_paths(
            pier_runtime=pier,
            temporary_dir=temporary,
            jobs_dir=jobs,
            tasks_dir=tasks,
            shared_runtime_dir=runtime,
        )
        nested = jobs / "tmp"
        nested.mkdir(mode=0o700)
        with self.assertRaisesRegex(ValueError, "overlaps jobs directory"):
            _validate_private_launch_paths(
                pier_runtime=pier,
                temporary_dir=nested,
                jobs_dir=jobs,
                tasks_dir=tasks,
                shared_runtime_dir=runtime,
            )
        temporary.chmod(0o755)
        with self.assertRaisesRegex(ValueError, "private owner-only"):
            _validate_private_launch_paths(
                pier_runtime=pier,
                temporary_dir=temporary,
                jobs_dir=jobs,
                tasks_dir=tasks,
                shared_runtime_dir=runtime,
            )

        jobs.chmod(0o700)
        frozen_jobs = tasks / "jobs"
        frozen_jobs.mkdir(mode=0o700)
        separate_temporary = self.root / "temporary-private"
        separate_temporary.mkdir(mode=0o700)
        with self.assertRaisesRegex(ValueError, "jobs directory overlaps DeepSWE tasks"):
            _validate_private_launch_paths(
                pier_runtime=pier,
                temporary_dir=separate_temporary,
                jobs_dir=frozen_jobs,
                tasks_dir=tasks,
                shared_runtime_dir=runtime,
            )


class ImageIdentityTests(unittest.TestCase):
    def test_full_frozen_ledger_resolves_digest_only_references(self):
        identities = _load_image_identities(
            IMAGE_LEDGER,
            expected_sha256=IMAGE_LEDGER_SHA256,
            require_execution_ready=False,
        )
        self.assertEqual(len(identities), 20)
        self.assertEqual(identities[FIRST_TASK].pinned_image, FIRST_PINNED)
        self.assertNotIn(":kh", identities[FIRST_TASK].pinned_image)

    def test_ledger_hash_and_readiness_fail_closed(self):
        with self.assertRaisesRegex(ValueError, "ledger sha256 mismatch"):
            _load_image_identities(
                IMAGE_LEDGER,
                expected_sha256="0" * 64,
                require_execution_ready=False,
            )
        with self.assertRaisesRegex(ValueError, "not ready for scored"):
            _load_image_identities(
                IMAGE_LEDGER,
                expected_sha256=IMAGE_LEDGER_SHA256,
                require_execution_ready=True,
            )


class BenchmarkInputTests(RuntimeFixture):
    def test_clean_frozen_task_and_exact_schedule_row_are_required(self):
        tasks, metadata, schedule = self.build_frozen_tasks()
        trial_id = f"{FIRST_TASK}.r1.baseline"
        result = validate_benchmark_inputs(
            tasks_dir=tasks,
            task_metadata_path=metadata,
            task_metadata_sha256=_sha256_file(metadata),
            task_id=FIRST_TASK,
            mode="score",
            arm="baseline",
            trial_id=trial_id,
            schedule_path=schedule,
            schedule_sha256=_sha256_file(schedule),
        )
        self.assertEqual(result["taskId"], FIRST_TASK)
        with self.assertRaisesRegex(ValueError, "frozen schedule row"):
            validate_benchmark_inputs(
                tasks_dir=tasks,
                task_metadata_path=metadata,
                task_metadata_sha256=_sha256_file(metadata),
                task_id=FIRST_TASK,
                mode="score",
                arm="treatment",
                trial_id=trial_id,
                schedule_path=schedule,
                schedule_sha256=_sha256_file(schedule),
            )

    def test_task_tampering_and_skip_worktree_flags_fail_closed(self):
        tasks, metadata, schedule = self.build_frozen_tasks()
        task_toml = tasks / FIRST_TASK / "task.toml"
        original = task_toml.read_text(encoding="utf-8")
        task_toml.write_text(original + "# changed\n", encoding="utf-8")
        arguments = {
            "tasks_dir": tasks,
            "task_metadata_path": metadata,
            "task_metadata_sha256": _sha256_file(metadata),
            "task_id": FIRST_TASK,
            "mode": "preflight",
            "arm": "baseline",
            "trial_id": "unit-preflight",
            "schedule_path": schedule,
            "schedule_sha256": _sha256_file(schedule),
        }
        with self.assertRaisesRegex(ValueError, "task.toml"):
            validate_benchmark_inputs(**arguments)
        task_toml.write_text(original, encoding="utf-8")
        self.git(tasks.parent, "update-index", "--skip-worktree", f"tasks/{FIRST_TASK}/task.toml")
        with self.assertRaisesRegex(ValueError, "skip-worktree"):
            validate_benchmark_inputs(**arguments)

    def test_trial_id_must_be_a_leaf(self):
        tasks, metadata, schedule = self.build_frozen_tasks()
        with self.assertRaisesRegex(ValueError, "normalized leaf"):
            validate_benchmark_inputs(
                tasks_dir=tasks,
                task_metadata_path=metadata,
                task_metadata_sha256=_sha256_file(metadata),
                task_id=FIRST_TASK,
                mode="preflight",
                arm="baseline",
                trial_id="../../escape",
                schedule_path=schedule,
                schedule_sha256=_sha256_file(schedule),
            )


class EnvironmentMountTests(RuntimeFixture):
    @staticmethod
    def fake_docker_init(
        instance,
        *,
        task_env_config,
        mounts_json=None,
        **kwargs,
    ):
        del kwargs
        instance.task_env_config = task_env_config
        instance._use_prebuilt = False
        instance._mounts_json = (
            [
                {"type": "bind", "source": "/host/verifier", "target": "/logs/verifier"},
                {"type": "bind", "source": "/host/agent", "target": "/logs/agent"},
                {"type": "bind", "source": "/host/artifacts", "target": "/logs/artifacts"},
            ]
            if mounts_json is None
            else list(mounts_json)
        )

    def make_environment(self, runtime_root, task_config, **overrides):
        _, _, docker = self.build_host_executables()
        try:
            runtime_identity = validate_shared_runtime(runtime_root)
            manifest_sha256 = runtime_identity.manifest_sha256
            tree_sha256 = runtime_identity.tree_sha256
        except ValueError:
            manifest_sha256 = "0" * 64
            tree_sha256 = "0" * 64
        values = {
            "environment_dir": self.root / "environment",
            "environment_name": FIRST_TASK,
            "session_id": "trial-agent",
            "trial_paths": object(),
            "task_env_config": task_config,
            "shared_runtime_dir": str(runtime_root),
            "runtime_manifest_sha256": manifest_sha256,
            "runtime_tree_sha256": tree_sha256,
            "image_identity_path": str(IMAGE_LEDGER),
            "image_identity_sha256": IMAGE_LEDGER_SHA256,
            "expected_task_id": FIRST_TASK,
            "execution_mode": "preflight",
            "host_docker_path": str(docker),
            "host_docker_sha256": _sha256_file(docker),
            "mounts_json": None,
        }
        values.update(overrides)
        with mock.patch.object(DockerEnvironment, "__init__", self.fake_docker_init):
            return PluginValueDockerEnvironment(**values)

    def test_agent_retains_default_mounts_and_gets_one_read_only_runtime(self):
        runtime_root = self.build_runtime()
        original = FakeTaskEnvironment()
        environment = self.make_environment(runtime_root, original)
        self.assertEqual(original.docker_image, FIRST_TAG)
        self.assertEqual(environment.task_env_config.docker_image, FIRST_PINNED)
        self.assertEqual(len(environment._mounts_json), 4)
        runtime_mount = environment._mounts_json[-1]
        self.assertEqual(runtime_mount["target"], str(RUNTIME_MOUNT))
        self.assertEqual(runtime_mount["source"], str(runtime_root.resolve()))
        self.assertIs(runtime_mount["read_only"], True)
        self.assertEqual(runtime_mount["bind"], {"create_host_path": False})

    def test_constructor_matches_pinned_pier_types_without_docker(self):
        runtime_root = self.build_runtime()
        _, _, docker = self.build_host_executables()
        trial_paths = TrialPaths(self.root / "trial")
        trial_paths.mkdir()
        environment_dir = self.root / "environment"
        environment_dir.mkdir()
        (environment_dir / "Dockerfile").write_text("FROM scratch\n", encoding="utf-8")
        environment = PluginValueDockerEnvironment(
            environment_dir=environment_dir,
            environment_name=FIRST_TASK,
            session_id="actual-pier-agent",
            trial_paths=trial_paths,
            task_env_config=EnvironmentConfig(
                docker_image=FIRST_TAG,
                os="linux",
                network_mode="no-network",
            ),
            shared_runtime_dir=str(runtime_root),
            runtime_manifest_sha256=validate_shared_runtime(runtime_root).manifest_sha256,
            runtime_tree_sha256=validate_shared_runtime(runtime_root).tree_sha256,
            image_identity_path=str(IMAGE_LEDGER),
            image_identity_sha256=IMAGE_LEDGER_SHA256,
            expected_task_id=FIRST_TASK,
            execution_mode="preflight",
            host_docker_path=str(docker),
            host_docker_sha256=_sha256_file(docker),
            mounts_json=None,
            agent_install_spec=None,
        )
        self.assertEqual(environment.task_env_config.docker_image, FIRST_PINNED)
        self.assertEqual(len(environment._mounts_json), 4)

    def test_verifier_keeps_only_its_explicit_mount_and_never_mounts_bundle(self):
        runtime_root = self.build_runtime()
        verifier_mounts = [
            {"type": "bind", "source": "/host/verifier", "target": "/logs/verifier"}
        ]
        environment = self.make_environment(
            runtime_root,
            FakeTaskEnvironment(),
            session_id="trial__verifier__trial",
            mounts_json=verifier_mounts,
        )
        self.assertEqual(environment._mounts_json, verifier_mounts)
        self.assertEqual(environment.task_env_config.docker_image, FIRST_PINNED)
        self.assertFalse(
            any(mount.get("target") == str(RUNTIME_MOUNT) for mount in environment._mounts_json)
        )

    def test_verifier_rejects_runtime_source_alias_and_nested_target_overlay(self):
        runtime_root = self.build_runtime()
        alias = self.root / "runtime-alias"
        alias.symlink_to(runtime_root, target_is_directory=True)
        with self.assertRaisesRegex(RuntimeError, "overlaps the shared agent runtime"):
            self.make_environment(
                runtime_root,
                FakeTaskEnvironment(),
                session_id="trial__verifier__trial",
                mounts_json=[
                    {"type": "bind", "source": str(alias), "target": "/logs/verifier"}
                ],
            )
        with self.assertRaisesRegex(RuntimeError, "target overlaps"):
            self.make_environment(
                runtime_root,
                FakeTaskEnvironment(),
                session_id="trial__verifier__trial",
                mounts_json=[
                    {"type": "bind", "source": "/host/agent", "target": "/logs/agent"},
                    {
                        "type": "bind",
                        "source": "/host/overlay",
                        "target": str(RUNTIME_MOUNT / "lib"),
                    },
                ],
            )

    def test_mount_contract_and_source_tag_mismatches_fail_closed(self):
        runtime_root = self.build_runtime()
        with self.assertRaisesRegex(RuntimeError, "mount/session contract"):
            self.make_environment(
                runtime_root,
                FakeTaskEnvironment(),
                mounts_json=[{"type": "bind", "source": "/x", "target": "/y"}],
            )
        with self.assertRaisesRegex(ValueError, "does not match its frozen identity"):
            self.make_environment(runtime_root, FakeTaskEnvironment("example.invalid:latest"))
        with self.assertRaisesRegex(ValueError, "manifest does not match"):
            self.make_environment(
                runtime_root,
                FakeTaskEnvironment(),
                runtime_manifest_sha256="0" * 64,
            )
        with self.assertRaisesRegex(ValueError, "absent from the image identity ledger"):
            self.make_environment(
                runtime_root,
                FakeTaskEnvironment(),
                environment_name="missing-frozen-task",
                expected_task_id="missing-frozen-task",
            )

    def test_container_inspection_proves_agent_mount_and_verifier_absence(self):
        identity = validate_shared_runtime(self.build_runtime())
        image_identity = _load_image_identities(
            IMAGE_LEDGER,
            expected_sha256=IMAGE_LEDGER_SHA256,
            require_execution_ready=False,
        )[FIRST_TASK]
        environment = object.__new__(PluginValueDockerEnvironment)
        environment._shared_runtime = identity
        environment._shared_runtime_source = identity.root
        environment._task_image_identity = image_identity
        environment._container_identity_verified = False
        environment.benchmark_container_id = mock.AsyncMock(return_value="a" * 64)
        environment._inspect_container = mock.AsyncMock(
            return_value={
                "Config": {"Image": FIRST_PINNED},
                "HostConfig": {"NetworkMode": "none"},
                "Mounts": [
                    {
                        "Type": "bind",
                        "Source": str(identity.root),
                        "Destination": str(RUNTIME_MOUNT),
                        "RW": False,
                    }
                ],
            }
        )
        asyncio.run(environment._verify_running_container(expect_runtime=True))
        self.assertTrue(environment._container_identity_verified)

        environment._container_identity_verified = False
        environment._inspect_container = mock.AsyncMock(
            return_value={
                "Config": {"Image": FIRST_PINNED},
                "HostConfig": {"NetworkMode": "none"},
                "Mounts": [],
            }
        )
        asyncio.run(environment._verify_running_container(expect_runtime=False))
        self.assertTrue(environment._container_identity_verified)

        environment._container_identity_verified = False
        environment._inspect_container = mock.AsyncMock(
            return_value={
                "Config": {"Image": FIRST_PINNED},
                "HostConfig": {"NetworkMode": "bridge"},
                "Mounts": [],
            }
        )
        with self.assertRaisesRegex(RuntimeError, "network mode"):
            asyncio.run(environment._verify_running_container(expect_runtime=False))


class PluginValueCodexTests(RuntimeFixture):
    def make_agent(self, **overrides):
        node, codex, docker = self.build_host_executables()
        host_runner = PLUGIN_VALUE_DIR / "host-runner.mjs"
        values = {
            "logs_dir": self.root / "logs",
            "model_name": PINNED_MODEL,
            "arm": "baseline",
            "version": PINNED_CODEX_VERSION,
            "reasoning_effort": PINNED_EFFORT,
            "host_node_path": str(node),
            "host_codex_path": str(codex),
            "host_docker_path": str(docker),
            "host_node_sha256": _sha256_file(node),
            "host_codex_sha256": _sha256_file(codex),
            "host_docker_sha256": _sha256_file(docker),
            "host_runner_sha256": _sha256_file(host_runner),
        }
        values.update(overrides)
        return PluginValueCodex(**values)

    def test_task_network_allowlist_is_empty_and_install_is_disabled(self):
        agent = self.make_agent()
        self.assertEqual(agent.network_allowlist().domains, [])
        self.assertIsNone(agent.install_spec())

    def test_fixed_model_and_version_are_enforced(self):
        with self.assertRaisesRegex(ValueError, "model_name"):
            self.make_agent(model_name="other")
        with self.assertRaisesRegex(ValueError, "Codex version"):
            self.make_agent(version="0.154.0")
        with self.assertRaisesRegex(ValueError, "reasoning_effort"):
            self.make_agent(reasoning_effort="high")

    def test_preflight_boolean_is_strict(self):
        self.assertTrue(self.make_agent(preflight_only="true").preflight_only)
        with self.assertRaisesRegex(ValueError, "preflight_only"):
            self.make_agent(preflight_only="sometimes")

    def test_setup_uses_only_verified_mounted_executables(self):
        identity = validate_shared_runtime(self.build_runtime())
        environment = object.__new__(PluginValueDockerEnvironment)
        environment._container_identity_verified = True
        environment._shared_runtime = identity
        environment.default_user = "agent"

        async def execute(command, **kwargs):
            self.assertEqual(kwargs["user"], "root")
            if command.endswith("node --version"):
                return SimpleNamespace(return_code=0, stdout=f"v{PINNED_NODE_VERSION}\n")
            if "createHash" in command:
                return SimpleNamespace(
                    return_code=0,
                    stdout=f"{identity.codex.sha256}\n{identity.node.sha256}\n",
                )
            if command.startswith("mkdir -p"):
                return SimpleNamespace(return_code=0, stdout="")
            if command.startswith("umask 077"):
                self.assertIn("/installed-agent/codex-exec-home", command)
                return SimpleNamespace(return_code=0, stdout="")
            if command.endswith("codex --version"):
                return SimpleNamespace(
                    return_code=0, stdout=f"codex-cli {PINNED_CODEX_VERSION}\n"
                )
            raise AssertionError(f"unexpected setup command: {command}")

        environment.exec = mock.AsyncMock(side_effect=execute)
        asyncio.run(self.make_agent().setup(environment))
        self.assertEqual(environment.exec.await_count, 5)

    def test_host_transient_cleanup_removes_only_known_paths(self):
        host_control = self.root / "host-control"
        host_control.mkdir()
        keep = host_control / "runtime-evidence.json"
        keep.write_text("keep", encoding="utf-8")
        for name in ("runtime-home", "workspace"):
            path = host_control / name
            path.mkdir()
            (path / "secret").write_text("sensitive", encoding="utf-8")
        PluginValueCodex._cleanup_host_transients(host_control)
        self.assertFalse((host_control / "runtime-home").exists())
        self.assertFalse((host_control / "workspace").exists())
        self.assertTrue(keep.is_file())

    def test_host_runner_control_files_never_enter_task_visible_agent_logs(self):
        agent_logs = self.root / "trial" / "agent"
        agent = self.make_agent(logs_dir=agent_logs)
        node = agent.host_node_path
        node.chmod(0o700)
        node.write_text(
            "#!/bin/sh\n"
            "shift\n"
            "while [ \"$#\" -gt 0 ]; do\n"
            "  case \"$1\" in\n"
            "    --request) request=$2; shift 2 ;;\n"
            "    --result) result=$2; shift 2 ;;\n"
            "    *) exit 9 ;;\n"
            "  esac\n"
            "done\n"
            "test -f \"$request\" || exit 10\n"
            "printf '%s\\n' '{\"status\":\"passed\",\"schemaVersion\":\"plugin-value-runtime-v1\"}' > \"$result\"\n",
            encoding="utf-8",
        )
        node.chmod(0o500)
        agent.host_node_sha256 = _sha256_file(node)
        environment = object.__new__(PluginValueDockerEnvironment)
        environment.default_user = "agent"
        environment.benchmark_container_id = mock.AsyncMock(return_value="a" * 64)
        asyncio.run(agent.run("repair the repository", environment, AgentContext()))
        host_control = agent_logs.parent / "host-control"
        request = json.loads(
            (host_control / "host-runner-request.json").read_text(encoding="utf-8")
        )
        self.assertEqual(request["logsDir"], str(host_control.resolve()))
        self.assertEqual(list(agent_logs.iterdir()), [])
        self.assertTrue((host_control / "host-runner-result.json").is_file())

    def test_cancellation_terminates_the_entire_host_process_group(self):
        agent = self.make_agent()

        async def exercise():
            process = await asyncio.create_subprocess_exec(
                "/bin/sh",
                "-c",
                "sleep 60 & echo $!; wait",
                start_new_session=True,
                stdout=asyncio.subprocess.PIPE,
            )
            assert process.stdout is not None
            child_pid = int((await process.stdout.readline()).decode().strip())
            await agent._terminate_subprocess(process)
            for _ in range(20):
                try:
                    os.kill(child_pid, 0)
                except ProcessLookupError:
                    return
                await asyncio.sleep(0.05)
            self.fail("child process survived process-group termination")

        asyncio.run(exercise())


class RunOneScriptTests(RuntimeFixture):
    def build_script_environment(self, runtime_root, capture):
        node, codex, docker = self.build_host_executables()
        pier = self.root / "pier"
        (pier / "bin").mkdir(parents=True)
        fake_python = pier / "bin" / "python"
        runtime_identity = validate_shared_runtime(runtime_root)
        fake_python.write_text(
            "#!/bin/sh\n"
            "while :; do\n"
            "  case \"${1:-}\" in\n"
            "    -I|-S|-B) shift ;;\n"
            "    -X) shift 2 ;;\n"
            "    *) break ;;\n"
            "  esac\n"
            "done\n"
            "case \"${1:-}\" in\n"
            "  *runtime.py) exit 0 ;;\n"
            "  -c)\n"
            "    code=$2\n"
            "    case \"$code\" in\n"
            "      *executionReady*) echo 'runtime identity is not ready for scored execution' >&2; exit 1 ;;\n"
            f"      *imageIdentityLedgerSha256*) echo {IMAGE_LEDGER_SHA256} ;;\n"
            f"      *taskRuntimeMetadataSha256*) echo {_sha256_file(PLUGIN_VALUE_DIR / 'task-runtime-metadata.json')} ;;\n"
            f"      *scheduleSha256*) echo {_sha256_file(PLUGIN_VALUE_DIR / 'schedule.json')} ;;\n"
            "      *hostRuntime*node*) echo " + "a" * 64 + " ;;\n"
            "      *hostRuntime*codex*) echo " + "b" * 64 + " ;;\n"
            "      *hostRuntime*docker*) echo " + "c" * 64 + " ;;\n"
            "      *hostRuntime*runner*) echo " + "d" * 64 + " ;;\n"
            f"      *manifestSha256*) echo {runtime_identity.manifest_sha256} ;;\n"
            f"      *treeSha256*) echo {runtime_identity.tree_sha256} ;;\n"
            "      *) exit 3 ;;\n"
            "    esac ;;\n"
            "  *pier-main.py)\n"
            "    shift\n"
            "    if [ \"${1:-}\" = validate-inputs ]; then exit 0; fi\n"
            f"    {sys.executable} -c 'import json,os,sys; json.dump(sys.argv[1:], open(os.environ[\"CAPTURE\"], \"w\"))' \"$@\" ;;\n"
            "  *) exit 4 ;;\n"
            "esac\n",
            encoding="utf-8",
        )
        fake_python.chmod(0o500)
        for directory in ("tasks", "jobs", "tmp"):
            path = self.root / directory
            path.mkdir(exist_ok=True)
            path.chmod(0o700)
        return {
            **os.environ,
            "PIER_RUNTIME": str(pier),
            "DEEPSWE_TASKS": str(self.root / "tasks"),
            "JOBS_DIR": str(self.root / "jobs"),
            "PLUGIN_VALUE_RUNTIME_BUNDLE": str(runtime_root),
            "PLUGIN_VALUE_TMPDIR": str(self.root / "tmp"),
            "PLUGIN_VALUE_HOST_NODE": str(node),
            "PLUGIN_VALUE_HOST_CODEX": str(codex),
            "PLUGIN_VALUE_HOST_DOCKER": str(docker),
            "CAPTURE": str(capture),
        }

    def test_exact_task_and_runtime_identity_are_passed_to_pier(self):
        runtime_root = self.build_runtime()
        runtime_identity = validate_shared_runtime(runtime_root)
        capture = self.root / "args.json"
        env = self.build_script_environment(runtime_root, capture)
        completed = subprocess.run(
            [
                "sh",
                str(PLUGIN_VALUE_DIR / "run-one.sh"),
                "baseline",
                "preflight",
                FIRST_TASK,
                "unit-preflight",
            ],
            env=env,
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(completed.returncode, 0, completed.stderr)
        arguments = json.loads(capture.read_text(encoding="utf-8"))
        self.assertIn(FIRST_TASK, arguments)
        self.assertIn("shared_runtime_dir=" + str(runtime_root), arguments)
        self.assertIn(
            "runtime_manifest_sha256=" + runtime_identity.manifest_sha256, arguments
        )
        self.assertIn("runtime_tree_sha256=" + runtime_identity.tree_sha256, arguments)
        self.assertIn("image_identity_path=" + str(IMAGE_LEDGER), arguments)
        self.assertIn("image_identity_sha256=" + IMAGE_LEDGER_SHA256, arguments)
        self.assertIn("expected_task_id=" + FIRST_TASK, arguments)
        self.assertIn("execution_mode=preflight", arguments)
        task_option = arguments.index("--include-task-name")
        self.assertEqual(arguments[task_option + 1], FIRST_TASK)
        self.assertEqual(arguments.count("--n-tasks"), 1)

    def test_ambient_path_cannot_replace_shell_helpers(self):
        runtime_root = self.build_runtime()
        capture = self.root / "args.json"
        env = self.build_script_environment(runtime_root, capture)
        poison = self.root / "poison"
        poison.mkdir()
        sentinel = self.root / "poison-used"
        for name in ("dirname", "env"):
            helper = poison / name
            helper.write_text(
                f"#!/bin/sh\nprintf used > {sentinel}\nexit 99\n",
                encoding="utf-8",
            )
            helper.chmod(0o700)
        env["PATH"] = f"{poison}:/usr/bin:/bin"
        completed = subprocess.run(
            [
                "/bin/sh",
                str(PLUGIN_VALUE_DIR / "run-one.sh"),
                "baseline",
                "preflight",
                FIRST_TASK,
                "unit-path",
            ],
            env=env,
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertFalse(sentinel.exists())

    def test_task_globs_are_rejected_before_execution(self):
        completed = subprocess.run(
            ["sh", str(PLUGIN_VALUE_DIR / "run-one.sh"), "baseline", "preflight", "*", "job"],
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(completed.returncode, 2)
        self.assertIn("invalid task id", completed.stderr)

    def test_score_mode_stays_blocked_while_runtime_identity_is_pending(self):
        runtime_root = self.build_runtime()
        env = self.build_script_environment(runtime_root, self.root / "unused.json")
        completed = subprocess.run(
            [
                "sh",
                str(PLUGIN_VALUE_DIR / "run-one.sh"),
                "baseline",
                "score",
                FIRST_TASK,
                "unit-score",
            ],
            env=env,
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertNotEqual(completed.returncode, 0)
        self.assertIn("runtime identity is not ready", completed.stderr)

    def test_job_path_traversal_is_rejected_before_environment_access(self):
        completed = subprocess.run(
            [
                "sh",
                str(PLUGIN_VALUE_DIR / "run-one.sh"),
                "baseline",
                "preflight",
                FIRST_TASK,
                "../../escape",
            ],
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(completed.returncode, 2)
        self.assertIn("invalid job name", completed.stderr)


if __name__ == "__main__":
    unittest.main()
