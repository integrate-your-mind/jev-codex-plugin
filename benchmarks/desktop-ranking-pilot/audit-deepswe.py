import hashlib
import json
import urllib.request
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import tomllib


REVISION = "0b9fabbb63b9104d678fe965e1632f2dd9eaa2ea"


def read(url):
    with urllib.request.urlopen(url, timeout=30) as response:
        return response.read()


def inspect(entry):
    body = read(f'https://raw.githubusercontent.com/datacurve-ai/deep-swe/{REVISION}/{entry["path"]}')
    task = tomllib.loads(body.decode())
    metadata = task["metadata"]
    return {"id": entry["path"].split("/")[1], "category": metadata.get("category"),
            "repository": metadata.get("repository_url", metadata.get("repositoryUrl")),
            "sourceBlob": entry["sha"], "sourceHash": hashlib.sha256(body).hexdigest()}


if __name__ == "__main__":
    tree = json.loads(read(f"https://api.github.com/repos/datacurve-ai/deep-swe/git/trees/{REVISION}?recursive=1"))
    assert not tree.get("truncated"), "The source tree is incomplete"
    entries = [entry for entry in tree["tree"] if entry["path"].startswith("tasks/") and entry["path"].endswith("/task.toml")]
    with ThreadPoolExecutor(max_workers=6) as pool:
        rows = list(pool.map(inspect, entries))
    result = {"schemaVersion": "desktop-pilot-deepswe-metadata-audit-v1", "revision": REVISION,
              "taskCount": len(rows), "categories": dict(Counter(row["category"] for row in rows)),
              "scope": "Pinned public task metadata only. No task, verifier, model or old cohort executed.", "tasks": rows}
    path = Path(__file__).resolve().parent / "deepswe-catalog-audit-2026-10-28.json"
    with path.open("x") as target:
        target.write(json.dumps(result, indent=2) + "\n")
    print(json.dumps({"taskCount": len(rows), "categories": result["categories"]}))
