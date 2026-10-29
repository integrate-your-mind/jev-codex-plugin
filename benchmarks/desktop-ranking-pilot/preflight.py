import argparse
import hashlib
import json
import os
import subprocess
import time
from pathlib import Path

def sha(value):
    return hashlib.sha256(value.encode() if isinstance(value, str) else value).hexdigest()


def run(argv, cwd=None, data=None, timeout=600):
    result = subprocess.run(argv, cwd=cwd, input=data, text=True, capture_output=True, timeout=timeout)
    if result.returncode:
        raise RuntimeError(f"Command failed {argv!r}\n{result.stdout}\n{result.stderr}")
    return result.stdout.strip()


def mutation(task):
    if task.endswith("-2931"):
        return "requests/models.py", "\nPreparedRequest.prepare_body = lambda self, data, files, json=None: setattr(self, 'body', None)\n"
    if task.endswith("-5414"):
        return "requests/models.py", "\nPreparedRequest.prepare_url = lambda self, url, params: setattr(self, 'url', url)\n"
    if task.endswith("-6028"):
        return "requests/utils.py", "\ndef prepend_scheme_if_needed(url, new_scheme):\n    return 'http://example.com'\n"
    if task.endswith("-16886"):
        return "sympy/crypto/crypto.py", "\nencode_morse = lambda msg, sep='|': '-----'\n"
    if task.endswith("-19346"):
        return "sympy/printing/repr.py", "\ndef srepr(expr, **settings):\n    return str(expr)\n"
    if task.endswith("-24562"):
        return "sympy/core/numbers.py", "\n_jev_original_new = Rational.__new__\ndef _jev_wrong_new(cls, *args, **kwargs):\n    if len(args) >= 2 and isinstance(args[0], str) and args[0] == '0.5' and args[1] == '100':\n        return _jev_original_new(cls, 1, 100)\n    return _jev_original_new(cls, *args, **kwargs)\nRational.__new__ = staticmethod(_jev_wrong_new)\n"
    raise ValueError("Unknown reviewed task")


def parse_grader_output(stdout, exit_code):
    try:
        result = json.loads(stdout.splitlines()[-1])
        expected_exit = 0 if result.get("verdict") == "pass" else 1
        if result.get("verdict") in ["pass", "fail"] and exit_code == expected_exit and isinstance(result.get("healthy"), bool):
            return result
    except (ValueError, IndexError, AttributeError):
        pass
    return {"verdict": "infrastructure-invalid", "healthy": False}


def main():
    import pyarrow.parquet as parquet

    parser = argparse.ArgumentParser()
    parser.add_argument("artifact", type=Path)
    parser.add_argument("--python", type=Path, required=True)
    parser.add_argument("--work", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    root = Path(__file__).resolve().parent
    source = json.loads((root / "swebench-verified-source.json").read_text())
    assert sha(args.artifact.read_bytes()) == source["expectedHash"]
    catalog = json.loads((root / "corpus-2026-10-28.json").read_text())
    rows = {row["instance_id"]: row for row in parquet.read_table(args.artifact).to_pylist()}
    python = args.python.absolute()
    work = args.work.resolve()
    work.mkdir(parents=True, exist_ok=True)
    logs = work / "logs" / args.output.name
    logs.mkdir(parents=True, exist_ok=True)
    args.output.mkdir(parents=True, exist_ok=True)
    runtime = {"python": run([str(python), "--version"]),
               "dependencies": run(["uv", "pip", "freeze", "--python", str(python)])}
    for task in catalog["tasks"]:
        target = args.output / f'{task["id"]}.json'
        if target.exists():
            existing = json.loads(target.read_text())
            assert existing["baseRevision"] == task["baseRevision"] and existing["graderHash"] == sha((root / "grade.py").read_bytes())
            print(f'Retained prior preflight {task["id"]}', flush=True)
            continue
        row = rows[task["id"]]
        assert sha(row["patch"]) == task["referencePatchHash"]
        mirror = work / task["repository"].replace("/", "-")
        if not mirror.exists():
            run(["git", "init", "--bare", str(mirror)])
            run(["git", "-C", str(mirror), "remote", "add", "origin", f'https://github.com/{task["repository"]}.git'])
        print(f'Preparing pinned source {task["id"]}', flush=True)
        run(["git", "-C", str(mirror), "fetch", "--depth=1", "origin", task["baseRevision"]])
        controls = {}
        for control in ["broken", "reference", "missing", "wrong"]:
            checkout = work / f'{task["id"]}-{control}'
            assert not checkout.exists(), "Reconcile an existing control worktree before retrying"
            run(["git", "-C", str(mirror), "worktree", "add", "--detach", str(checkout), task["baseRevision"]])
            assert run(["git", "-C", str(checkout), "rev-parse", "HEAD"]) == task["baseRevision"]
            try:
                if control in ["reference", "wrong"]:
                    run(["git", "apply", "--whitespace=nowarn", "-"], cwd=checkout, data=row["patch"])
                if control == "wrong":
                    path, body = mutation(task["id"])
                    with (checkout / path).open("a") as output:
                        output.write(body)
                patch = run(["git", "diff", "--binary"], cwd=checkout)
                started = time.monotonic()
                try:
                    process = subprocess.run([str(python), "-B", str(root / "grade.py"), task["id"]], cwd=checkout,
                                             text=True, capture_output=True, timeout=600,
                                             env={**os.environ, "PYTHONNOUSERSITE": "1"})
                    log = {"exitCode": process.returncode, "stdout": process.stdout, "stderr": process.stderr}
                    result = parse_grader_output(process.stdout, process.returncode)
                except subprocess.TimeoutExpired as error:
                    decode = lambda value: value.decode(errors="replace") if isinstance(value, bytes) else value or ""
                    log = {"exitCode": None, "stdout": decode(error.stdout), "stderr": decode(error.stderr), "timeout": True}
                    result = {"verdict": "infrastructure-invalid", "healthy": False}
                duration = (time.monotonic() - started) * 1000
                with (logs / f'{task["id"]}-{control}.log.json').open("x") as output:
                    output.write(json.dumps(log, indent=2) + "\n")
                controls[control] = {"verdict": result["verdict"], "healthy": result["healthy"],
                                     "durationMs": duration, "evidenceHash": sha(json.dumps(log, sort_keys=True)),
                                     "patchHash": sha(patch), "exitCode": log["exitCode"]}
                print(f'{task["id"]} {control}: {result["verdict"]}, healthy={result["healthy"]}', flush=True)
            finally:
                run(["git", "-C", str(mirror), "worktree", "remove", "--force", str(checkout)])
        receipt = {"schemaVersion": "desktop-pilot-grader-preflight-v1", "taskId": task["id"],
                   "baseRevision": task["baseRevision"], "graderHash": sha((root / "grade.py").read_bytes()),
                   "referencePatchHash": task["referencePatchHash"], "runtime": runtime,
                   "scope": "Non-model grader controls only. No coding attempt, hidden preflight, or old cohort ran.",
                   "controls": controls}
        with target.open("x") as output:
            output.write(json.dumps(receipt, indent=2) + "\n")
        assert json.loads(target.read_text()) == receipt


if __name__ == "__main__":
    main()
