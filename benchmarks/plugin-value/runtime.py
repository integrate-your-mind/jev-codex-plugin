"""Pier adapter for the paired Jev/Codex DeepSWE benchmark.

The model API and Jev plugin stay in a host-side Codex app-server.  Pier's task
container only runs Codex's unauthenticated exec-server over ``docker exec``.
This keeps reusable credentials outside the repository-under-test while
preserving the native Codex command, patch, hook, and MCP paths.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import shutil
from pathlib import Path
from typing import Any

from pier.agents.installed.base import with_prompt_template
from pier.agents.installed.codex import Codex
from pier.environments.base import BaseEnvironment
from pier.environments.docker.docker import DockerEnvironment
from pier.models.agent.context import AgentContext
from pier.models.agent.network import NetworkAllowlist


PINNED_CODEX_VERSION = "0.155.0"
PINNED_MODEL = "gpt-6-astra"
PINNED_EFFORT = "medium"
_CONTAINER_ID = re.compile(r"^[0-9a-f]{12,64}$")
_CONTAINER_USER = re.compile(r"^[A-Za-z0-9_.:-]{1,128}$")


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


class PluginValueDockerEnvironment(DockerEnvironment):
    """Pier Docker environment with a bounded container identity accessor.

    The parent class retains DeepSWE's ``network_mode: none`` override.  We do
    not publish a port or mount credentials; the host app-server reaches the
    task exec-server through an explicit ``docker exec -i`` stdio transport.
    """

    async def benchmark_container_id(self) -> str:
        result = await self._run_docker_compose_command(
            ["ps", "-q", "main"], check=True, timeout_sec=30
        )
        container_id = (result.stdout or "").strip()
        if not _CONTAINER_ID.fullmatch(container_id):
            raise RuntimeError("Pier returned an invalid main-container id")
        return container_id


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

        timeout = int(turn_timeout_ms)
        if timeout < 1_000 or timeout > 10_790_000:
            raise ValueError("turn_timeout_ms must be between 1000 and 10790000")

        self.arm = arm
        self.preflight_only = _as_bool(preflight_only, name="preflight_only")
        self.turn_timeout_ms = timeout
        self.host_runner = Path(host_runner or Path(__file__).with_name("host-runner.mjs"))
        super().__init__(
            *args,
            version=version,
            reasoning_effort=reasoning_effort,
            **kwargs,
        )

    def network_allowlist(self) -> NetworkAllowlist:
        """Keep the task container offline; transports run on the host."""

        return NetworkAllowlist()

    async def setup(self, environment: BaseEnvironment) -> None:
        await super().setup(environment)
        version_result = await environment.exec(
            "codex --version", timeout_sec=30, user=environment.default_user
        )
        observed = (version_result.stdout or "").strip()
        if version_result.return_code != 0 or observed != f"codex-cli {PINNED_CODEX_VERSION}":
            raise RuntimeError(
                f"task container Codex version mismatch: {observed or 'unavailable'}"
            )

    def _runner_environment(self) -> dict[str, str]:
        allowed = {
            "PATH",
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
        return {key: value for key, value in os.environ.items() if key in allowed}

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
        run_id = container_id[:12]
        remote_cwd = "/app"
        host_cwd = f"/tmp/deepswe-runs/{run_id}/workspace"
        docker_path = shutil.which("docker")
        node_path = shutil.which("node")
        codex_path = shutil.which("codex")
        if not docker_path or not node_path or not codex_path:
            raise RuntimeError("host node, codex, and docker executables are required")

        container_user = (
            str(environment.default_user)
            if environment.default_user is not None
            else None
        )
        if container_user is not None and not _CONTAINER_USER.fullmatch(container_user):
            raise RuntimeError("task container user has an invalid value")

        self.logs_dir.mkdir(parents=True, exist_ok=True)
        request_path = self.logs_dir / "host-runner-request.json"
        result_path = self.logs_dir / "host-runner-result.json"
        request_path.write_text(
            json.dumps(
                {
                    "schemaVersion": "plugin-value-runtime-v1",
                    "arm": self.arm,
                    "containerId": container_id,
                    "containerUser": container_user,
                    "dockerPath": str(Path(docker_path).resolve()),
                    "codexPath": str(Path(codex_path).resolve()),
                    "instruction": instruction,
                    "logsDir": str(self.logs_dir.resolve()),
                    "model": PINNED_MODEL,
                    "effort": PINNED_EFFORT,
                    "remoteCwd": remote_cwd,
                    "hostCwd": host_cwd,
                    "turnTimeoutMs": self.turn_timeout_ms,
                    "preflightOnly": self.preflight_only,
                },
                sort_keys=True,
            )
            + "\n",
            encoding="utf-8",
        )

        process = await asyncio.create_subprocess_exec(
            node_path,
            str(self.host_runner),
            "--request",
            str(request_path),
            "--result",
            str(result_path),
            cwd=str(self.logs_dir),
            env=self._runner_environment(),
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await process.communicate()
        (self.logs_dir / "host-runner.stdout").write_bytes(stdout)
        (self.logs_dir / "host-runner.stderr").write_bytes(stderr)
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
