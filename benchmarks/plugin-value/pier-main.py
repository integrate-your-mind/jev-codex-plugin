"""Isolated Pier entrypoint for the pinned plugin-value benchmark runtime."""

from __future__ import annotations

import os
from pathlib import Path
import sys
from types import ModuleType


def _load_adapter():
    site_packages = Path(os.environ["PLUGIN_VALUE_PINNED_SITE_PACKAGES"]).resolve(
        strict=True
    )
    adapter_path = Path(os.environ["PLUGIN_VALUE_ADAPTER_PATH"]).resolve(strict=True)
    sys.path.insert(0, str(site_packages))
    # The bootstrap authenticates these source bytes before this process starts.
    # Compile them directly so a timestamp-valid adjacent .pyc can never replace
    # the authenticated adapter.
    source = adapter_path.read_bytes()
    code = compile(source, str(adapter_path), "exec", dont_inherit=True)
    module = ModuleType("plugin_value_runtime")
    module.__file__ = str(adapter_path)
    module.__package__ = ""
    module.__spec__ = None
    sys.modules[module.__name__] = module
    exec(code, module.__dict__)
    return module


def main() -> None:
    runtime = _load_adapter()
    if len(sys.argv) > 1 and sys.argv[1] == "validate-inputs":
        if len(sys.argv) != 11:
            raise SystemExit(
                "validate-inputs requires tasks metadata metadata-sha task mode arm "
                "trial schedule schedule-sha"
            )
        runtime.validate_benchmark_inputs(
            tasks_dir=sys.argv[2],
            task_metadata_path=sys.argv[3],
            task_metadata_sha256=sys.argv[4],
            task_id=sys.argv[5],
            mode=sys.argv[6],
            arm=sys.argv[7],
            trial_id=sys.argv[8],
            schedule_path=sys.argv[9],
            schedule_sha256=sys.argv[10],
        )
        return
    from pier.cli.main import app

    app()


if __name__ == "__main__":
    main()
