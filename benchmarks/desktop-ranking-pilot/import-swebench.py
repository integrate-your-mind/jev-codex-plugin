import argparse
import hashlib
import json
from pathlib import Path

import pyarrow.parquet as parquet


def digest(value):
    if isinstance(value, str):
        value = value.encode()
    return hashlib.sha256(value).hexdigest()


def emit(path, value):
    encoded = json.dumps(value, indent=2) + "\n"
    with path.open("x") as target:
        target.write(encoded)
    assert json.loads(path.read_text()) == value


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("artifact", type=Path)
    parser.add_argument("--repository", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    source_root = Path(__file__).resolve().parent
    source = json.loads((source_root / "swebench-verified-source.json").read_text())
    artifact_hash = digest(args.artifact.read_bytes())
    assert artifact_hash == source["expectedHash"], "Pinned catalog artifact changed"
    selection = json.loads((source_root / "selection-2026-10-28.json").read_text())
    rows = {row["instance_id"]: row for row in parquet.read_table(args.artifact).to_pylist()}
    tasks = []
    for chosen in selection["tasks"]:
        row = rows[chosen["id"]]
        tasks.append({
            "id": row["instance_id"], "repository": row["repo"], "baseRevision": row["base_commit"],
            "taskType": chosen["taskType"],
            "classification": {"kind": "bug", "reviewed": True, "evidence": chosen["evidence"]},
            "issues": [f'https://github.com/{row["repo"]}/issues/{chosen["issue"]}'],
            "referencePullRequest": f'https://github.com/{row["repo"]}/pull/{row["instance_id"].rsplit("-", 1)[1]}',
            "problemStatementHash": digest(row["problem_statement"]),
            "referencePatchHash": digest(row["patch"]), "testPatchHash": digest(row["test_patch"]),
            "graderMetadata": {"failToPassHash": digest(row["FAIL_TO_PASS"]), "passToPassHash": digest(row["PASS_TO_PASS"])},
            "graderStatus": "NOT_PREFLIGHTED",
        })
    paths = [args.repository / "benchmarks/plugin-value/task-runtime-metadata.json",
             args.repository / "benchmarks/plugin-value/heldout-selection.json"]
    runtime, heldout = [json.loads(path.read_text()) for path in paths]
    amendments = {row["taskId"]: row["effectiveValue"] for row in runtime["provenance"]["metadataAmendments"]}
    reserved = []
    for cohort, entries in [("original-frozen", runtime["tasks"]), ("heldout-reserved", heldout["tasks"])]:
        for entry in entries:
            task_id = entry.get("taskId", entry.get("id"))
            metadata = entry["metadata"]
            repository = metadata["repositoryUrl"].removeprefix("https://github.com/").removesuffix(".git")
            reserved.append({"id": task_id, "repository": repository,
                             "baseRevision": amendments.get(task_id, metadata["baseCommitHash"]),
                             "issues": [], "disposition": cohort})
    args.output.mkdir(parents=True, exist_ok=True)
    emit(args.output / "corpus-2026-10-28.json", {"schemaVersion": "desktop-pilot-corpus-v1",
         "source": {"url": source["url"], "revision": source["revision"], "artifactHash": artifact_hash},
         "tasks": tasks})
    emit(args.output / "reservations-2026-10-28.json", {"sourceHash": digest(b"".join(path.read_bytes() for path in paths)),
         "sources": [str(path.relative_to(args.repository)) for path in paths], "tasks": reserved})
    print(json.dumps({"selectedRealBugMetadata": len(tasks), "reservedOldTasks": len(reserved),
                      "artifactHash": artifact_hash, "graderPreflightAttempted": False}))


if __name__ == "__main__":
    main()
