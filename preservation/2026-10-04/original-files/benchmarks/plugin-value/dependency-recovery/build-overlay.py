#!/usr/bin/env python3
"""Build an authenticated exact-file dependency overlay.

The builder is deliberately inert until ``--build`` is supplied and a frozen
source-layer audit with schema v2 is present.  It creates one tar overlay and
one ADD instruction; it never copies an unlisted path or installs packages.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import stat
import subprocess
import tarfile
import urllib.request
from pathlib import Path, PurePosixPath
from typing import Any


REPOSITORY = "d3j8x8q7/swe-bench-202605"
DEFAULT_BASE = "jev-plugin-value-recovery/ipython-session-bundle-replay:pygments-pluggy-v5-ba83b5e9"
DEFAULT_WORK = Path("/Volumes/JevPythonTmp/dependency-recovery-v1-work")
SITE_ROOT = "usr/local/lib/python3.12/site-packages"
SCHEMA = "jev-plugin-value-source-layer-proof-v2"
HEX64 = re.compile(r"^[0-9a-f]{64}$")


def canonical(value: object) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":")).encode()


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def run(args: list[str], *, cwd: Path | None = None) -> subprocess.CompletedProcess[str]:
    return subprocess.run(args, cwd=cwd, text=True, capture_output=True, check=False)


def safe_path(path: str, *, allow_directory: bool = False) -> str:
    normalized = str(PurePosixPath(path.lstrip("/")))
    if normalized in ("", ".") or normalized.startswith("../") or "/../" in normalized:
        raise ValueError(f"unsafe path: {path!r}")
    if normalized != SITE_ROOT and not normalized.startswith(SITE_ROOT + "/"):
        raise ValueError(f"path outside site-packages: {path!r}")
    if not allow_directory and normalized.endswith("/"):
        raise ValueError(f"directory where file expected: {path!r}")
    return normalized.rstrip("/")


def digest_field(value: Any, label: str) -> str:
    if not isinstance(value, str):
        raise ValueError(f"{label} must be a string")
    digest = value.removeprefix("sha256:")
    if not HEX64.fullmatch(digest):
        raise ValueError(f"{label} is not a SHA256 digest")
    return digest


def metadata(entry: dict[str, Any], path: str) -> dict[str, Any]:
    kind = entry.get("type", entry.get("kind", "regular"))
    if kind not in ("regular", "file"):
        raise ValueError(f"{path}: audit entry is not a regular file")
    result = {
        "path": safe_path(path),
        "type": "regular",
        "size": int(entry["size"] if "size" in entry else entry["bytes"]),
        "sha256": digest_field(entry["sha256"], f"{path}.sha256"),
        "mode": int(str(entry["mode"]), 8) if isinstance(entry["mode"], str) else int(entry["mode"]),
        "uid": int(entry.get("uid", 0)),
        "gid": int(entry.get("gid", 0)),
    }
    if result["size"] < 0 or result["mode"] & ~0o7777 or result["uid"] < 0 or result["gid"] < 0:
        raise ValueError(f"{path}: invalid file metadata")
    return result


def directory_metadata(entry: dict[str, Any], path: str) -> dict[str, Any]:
    normalized = safe_path(path, allow_directory=True)
    kind = entry.get("type", entry.get("kind", "directory"))
    if kind not in ("directory", "dir"):
        raise ValueError(f"{path}: audit entry is not a directory")
    mode = int(str(entry["mode"]), 8) if isinstance(entry["mode"], str) else int(entry["mode"])
    result = {
        "path": normalized,
        "type": "directory",
        "mode": mode,
        "uid": int(entry.get("uid", 0)),
        "gid": int(entry.get("gid", 0)),
        "sourceLayerDigest": digest_field(entry.get("sourceLayerDigest", entry.get("layerDigest")), f"{path}.sourceLayerDigest"),
    }
    if mode & ~0o7777 or result["uid"] < 0 or result["gid"] < 0:
        raise ValueError(f"{path}: invalid directory metadata")
    return result


def inventory_metadata(entry: dict[str, Any]) -> dict[str, Any]:
    path = safe_path(str(entry.get("path", "")), allow_directory=True)
    kind = entry.get("type", entry.get("kind"))
    if kind in ("directory", "dir"):
        mode = int(str(entry["mode"]), 8) if isinstance(entry["mode"], str) else int(entry["mode"])
        return {
            "path": path,
            "type": "directory",
            "mode": mode,
            "uid": int(entry.get("uid", 0)),
            "gid": int(entry.get("gid", 0)),
            "size": 0,
            "sha256": None,
        }
    return metadata(entry, path)


def normalize_inventory(raw: Any, label: str) -> dict[str, dict[str, Any]]:
    if not isinstance(raw, list) or not raw:
        raise RuntimeError(f"{label} must be a nonempty full inventory list")
    result: dict[str, dict[str, Any]] = {}
    for entry in raw:
        if not isinstance(entry, dict):
            raise RuntimeError(f"{label} contains a malformed entry")
        item = inventory_metadata(entry)
        if item["path"] in result and result[item["path"]] != item:
            raise RuntimeError(f"{label} contains conflicting duplicate {item['path']}")
        result[item["path"]] = item
    return result


def load_audit(path: Path, base_ref: str) -> dict[str, Any]:
    if not path.is_file():
        raise RuntimeError(f"source-layer audit is not present: {path}")
    audit = json.loads(path.read_text(encoding="utf-8"))
    if audit.get("schemaVersion") != SCHEMA:
        raise RuntimeError(f"expected {SCHEMA}; refusing unversioned or v1 audit")
    for key in ("repository", "manifestDigest", "configDigest", "sourceLayers", "mismatches"):
        if key not in audit:
            raise RuntimeError(f"audit missing required field: {key}")
    if audit["repository"] != REPOSITORY:
        raise RuntimeError("audit repository does not match pinned registry")
    digest_field(audit["manifestDigest"], "manifestDigest")
    digest_field(audit["configDigest"], "configDigest")
    if not isinstance(audit["sourceLayers"], list) or not audit["sourceLayers"]:
        raise RuntimeError("audit sourceLayers must be a nonempty list")
    layer_digests: set[str] = set()
    for layer in audit["sourceLayers"]:
        digest = digest_field(layer.get("digest"), "sourceLayer.digest")
        if digest in layer_digests:
            raise RuntimeError("duplicate source layer digest")
        layer_digests.add(digest)
        if int(layer.get("index", -1)) < 0:
            raise RuntimeError("source layer index is invalid")
        size = int(layer.get("contentLength", layer.get("size", -1)))
        if size <= 0:
            raise RuntimeError("source layer size is invalid")
        digest_field(layer.get("compressedSha256", digest), "sourceLayer.compressedSha256")

    mismatches = audit["mismatches"]
    if not isinstance(mismatches, list) or not mismatches:
        raise RuntimeError("audit has no mismatched dependency files")
    normalized: dict[str, dict[str, Any]] = {}
    for raw in mismatches:
        if not isinstance(raw, dict):
            raise RuntimeError("audit mismatch is not an object")
        path_value = raw.get("path")
        if not isinstance(path_value, str):
            raise RuntimeError("audit mismatch has no path")
        path_value = safe_path(path_value)
        expected = raw.get("source", raw.get("expected", raw))
        if not isinstance(expected, dict):
            raise RuntimeError(f"{path_value}: missing source metadata")
        file_meta = metadata(expected, path_value)
        layer_digest = raw.get("sourceLayerDigest", raw.get("layerDigest"))
        file_meta["sourceLayerDigest"] = digest_field(layer_digest, f"{path_value}.sourceLayerDigest")
        if file_meta["sourceLayerDigest"] not in layer_digests:
            raise RuntimeError(f"{path_value}: source layer is not declared")
        if path_value in normalized and normalized[path_value] != file_meta:
            raise RuntimeError(f"duplicate mismatch path with conflicting metadata: {path_value}")
        normalized[path_value] = file_meta
    if len(normalized) != len(mismatches):
        raise RuntimeError("audit contains duplicate mismatch paths")

    declared_count = audit.get("mismatchCount", audit.get("mismatchesCount"))
    if declared_count is not None and int(declared_count) != len(normalized):
        raise RuntimeError("audit mismatch count does not match entries")
    expected_base = audit.get("baseImageRef", audit.get("sourceImageRef", base_ref))
    if expected_base != base_ref and audit.get("baseImageId") is not None:
        raise RuntimeError("audit base image reference differs from requested base")
    audit["normalizedMismatches"] = sorted(normalized.values(), key=lambda item: item["path"])
    source_raw = audit.get("sourceInventory", audit.get("sourceEntries"))
    base_raw = audit.get("baseInventory", audit.get("baseEntries"))
    if source_raw is None or base_raw is None:
        raise RuntimeError("audit must provide complete sourceInventory and baseInventory")
    source_inventory = normalize_inventory(source_raw, "sourceInventory")
    base_inventory = normalize_inventory(base_raw, "baseInventory")
    if len(source_inventory) != 15422 or len(base_inventory) != 15422:
        raise RuntimeError("full inventory must contain exactly 15422 entries")
    if set(source_inventory) != set(base_inventory):
        raise RuntimeError("base/source inventories have different path sets")
    derived = sorted(path for path in source_inventory if source_inventory[path] != base_inventory[path])
    declared = sorted(item["path"] for item in audit["normalizedMismatches"])
    if derived != declared:
        raise RuntimeError("mismatches do not equal the exact base/source inventory difference")
    audit["normalizedSourceInventory"] = source_inventory
    audit["normalizedBaseInventory"] = base_inventory
    source_inventory_hash = sha256_bytes(canonical(sorted(source_inventory.values(), key=lambda item: item["path"])))
    base_inventory_hash = sha256_bytes(canonical(sorted(base_inventory.values(), key=lambda item: item["path"])))
    for key, computed in (("sourceInventorySha256", source_inventory_hash), ("baseInventorySha256", base_inventory_hash), ("filesystemInventorySha256", source_inventory_hash)):
        if key in audit and digest_field(audit[key], key) != computed:
            raise RuntimeError(f"audit {key} does not match normalized inventory")
    declared_source_count = audit.get("sourceEntryCount", audit.get("sourceInventoryCount"))
    if declared_source_count is not None and int(declared_source_count) != len(source_inventory):
        raise RuntimeError("source inventory count does not match entries")
    raw_directories = audit.get("ancestorDirectories", audit.get("directories"))
    if not isinstance(raw_directories, list):
        raise RuntimeError("audit must provide immutable ancestorDirectories metadata")
    directories: dict[str, dict[str, Any]] = {}
    for raw in raw_directories:
        if not isinstance(raw, dict) or not isinstance(raw.get("path"), str):
            raise RuntimeError("ancestor directory entry is malformed")
        item = directory_metadata(raw, raw["path"])
        if item["path"] in directories and directories[item["path"]] != item:
            raise RuntimeError(f"duplicate ancestor directory: {item['path']}")
        directories[item["path"]] = item
    expected_parents = {
        parent
        for item in normalized.values()
        for parent in PurePosixPath(item["path"]).parents
        if str(parent) == SITE_ROOT or str(parent).startswith(SITE_ROOT + "/")
    }
    if not expected_parents.issubset(directories):
        missing = sorted(expected_parents - directories)
        raise RuntimeError(f"audit omitted ancestor directory metadata: {missing[:3]}")
    audit["normalizedDirectories"] = sorted(directories.values(), key=lambda item: (item["path"].count("/"), item["path"]))
    return audit


def registry_token() -> str:
    url = f"https://public.ecr.aws/token/?scope=repository:{REPOSITORY}:pull&service=public.ecr.aws"
    with urllib.request.urlopen(url, timeout=30) as response:
        return json.load(response)["token"]


def registry_get(token: str, path: str, accept: str | None = None):
    headers = {"Authorization": f"Bearer {token}"}
    if accept:
        headers["Accept"] = accept
    request = urllib.request.Request(f"https://public.ecr.aws/v2/{REPOSITORY}/{path}", headers=headers)
    return urllib.request.urlopen(request, timeout=180)


class HashReader:
    def __init__(self, source):
        self.source = source
        self.digest = hashlib.sha256()

    def read(self, size: int = -1) -> bytes:
        data = self.source.read(size)
        self.digest.update(data)
        return data

    def __getattr__(self, name: str):
        return getattr(self.source, name)


def add_tar_entry(archive: tarfile.TarFile, source: tarfile.TarInfo, data: bytes | None = None) -> None:
    # Registry hardlinks/symlinks are deliberately excluded from this repair.
    if not source.isfile() and not source.isdir():
        raise RuntimeError(f"source layer contains non-regular selected member: {source.name}")
    info = tarfile.TarInfo(source.name.lstrip("./"))
    info.mode = source.mode
    info.uid = source.uid
    info.gid = source.gid
    info.mtime = source.mtime
    info.type = tarfile.DIRTYPE if source.isdir() else tarfile.REGTYPE
    info.size = 0 if source.isdir() else len(data or b"")
    archive.addfile(info, None if source.isdir() else __import__("io").BytesIO(data or b""))


def build_plan(audit: dict[str, Any], base_ref: str, work: Path) -> dict[str, Any]:
    files = audit["normalizedMismatches"]
    parents = audit["normalizedDirectories"]
    return {
        "schemaVersion": "jev-plugin-value-dependency-overlay-plan-v1",
        "baseImageRef": base_ref,
        "sourceManifestDigest": audit["manifestDigest"],
        "sourceConfigDigest": audit["configDigest"],
        "mismatchCount": len(files),
        "mismatchBytes": sum(item["size"] for item in files),
        "sourceEntryCount": len(audit["normalizedSourceInventory"]),
        "baseEntryCount": len(audit["normalizedBaseInventory"]),
        "sourceInventorySha256": sha256_bytes(canonical(sorted(audit["normalizedSourceInventory"].values(), key=lambda item: item["path"]))),
        "baseInventorySha256": sha256_bytes(canonical(sorted(audit["normalizedBaseInventory"].values(), key=lambda item: item["path"]))),
        "ancestorDirectoryCount": len(parents),
        "workDirectory": str(work),
        "mode": "build-only-after-v2-audit",
    }


def config_projection(image: dict[str, Any]) -> dict[str, Any]:
    config = image.get("Config", {})
    keys = ("Env", "Cmd", "Entrypoint", "WorkingDir", "User", "ExposedPorts", "Volumes", "Labels", "StopSignal", "Healthcheck", "Shell")
    return {key: config.get(key) for key in keys}


def verify_overlay_tar(path: Path, selected: dict[str, dict[str, Any]]) -> None:
    with tarfile.open(path, mode="r") as archive:
        names = [member.name for member in archive]
    expected = sorted(selected)
    if sorted(names) != expected:
        raise RuntimeError("overlay tar paths differ from the exact repair set")


def verify_result_image(image_ref: str, audit: dict[str, Any], work: Path, base_image: dict[str, Any]) -> dict[str, Any]:
    expected = sorted(audit["normalizedSourceInventory"].values(), key=lambda item: item["path"])
    expected_path = work / "expected-source-inventory.json"
    expected_path.write_text(json.dumps(expected, sort_keys=True) + "\n", encoding="utf-8")
    probe = r'''
import hashlib,json,pathlib,stat,subprocess
root=pathlib.Path("/usr/local/lib/python3.12/site-packages")
items=[]
for path in [root,*sorted(root.rglob("*"))]:
 info=path.lstat(); rel=str(path)
 if stat.S_ISDIR(info.st_mode):
  items.append({"path":rel,"type":"directory","mode":info.st_mode&0o7777,"uid":info.st_uid,"gid":info.st_gid,"size":0,"sha256":None})
 elif stat.S_ISREG(info.st_mode):
  data=path.read_bytes(); items.append({"path":rel,"type":"regular","mode":info.st_mode&0o7777,"uid":info.st_uid,"gid":info.st_gid,"size":len(data),"sha256":hashlib.sha256(data).hexdigest()})
 else: raise RuntimeError("non-regular filesystem entry: "+rel)
expected=json.loads(pathlib.Path("/tmp/expected-source-inventory.json").read_text())
expected=[dict(item,path=("/"+item["path"].lstrip("/") if item["path"].lstrip("/").startswith("usr/local/lib/python3.12/site-packages") else "/usr/local/lib/python3.12/site-packages/"+item["path"].lstrip("/"))) for item in expected]
expected.sort(key=lambda item:item["path"]); items.sort(key=lambda item:item["path"])
git=subprocess.run(["git","-C","/app","rev-parse","HEAD"],text=True,capture_output=True)
pytest=subprocess.run(["python3","-B","-m","pytest","--version"],text=True,capture_output=True)
print(json.dumps({"inventory":items,"inventoryMatches":items==expected,"gitHead":git.stdout.strip() if git.returncode==0 else None,"pytestReturnCode":pytest.returncode,"pytestVersion":pytest.stdout.strip()[:120]},sort_keys=True))
'''
    result = run([
        "docker", "run", "--rm", "--platform", "linux/amd64", "--network", "none",
        "--mount", f"type=bind,src={expected_path},dst=/tmp/expected-source-inventory.json,readonly",
        "--entrypoint", "python3", image_ref, "-B", "-c", probe,
    ])
    expected_path.unlink()
    if result.returncode:
        raise RuntimeError(f"full inventory probe failed: {result.returncode}")
    observed = json.loads(result.stdout)
    if not observed.get("inventoryMatches"):
        raise RuntimeError("result image full site-packages inventory differs from source inventory")
    if observed.get("pytestReturnCode") != 0:
        raise RuntimeError("pytest functional import check failed")
    expected_head = audit.get("gitHead")
    if expected_head and observed.get("gitHead") != expected_head:
        raise RuntimeError("result image Git HEAD differs from frozen audit")
    return {
        "sourceInventorySha256": sha256_bytes(canonical(expected)),
        "resultInventoryCount": len(observed["inventory"]),
        "gitHead": observed.get("gitHead"),
        "pytestReturnCode": observed.get("pytestReturnCode"),
        "pytestVersion": observed.get("pytestVersion"),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--audit", type=Path, required=True)
    parser.add_argument("--base-image", default=DEFAULT_BASE)
    parser.add_argument("--work-dir", type=Path, default=DEFAULT_WORK)
    parser.add_argument("--plan", action="store_true")
    parser.add_argument("--build", action="store_true")
    parser.add_argument("--tag", default="jev-plugin-value-recovery/ipython-session-bundle-replay:dependency-overlay-v1")
    args = parser.parse_args()
    if args.plan == args.build:
        raise SystemExit("choose exactly one of --plan or --build")
    audit = load_audit(args.audit, args.base_image)
    plan = build_plan(audit, args.base_image, args.work_dir)
    if args.plan:
        print(json.dumps(plan, indent=2, sort_keys=True))
        return

    # This path is intentionally guarded by the explicit --build flag.
    if args.work_dir.exists():
        raise RuntimeError(f"owned work directory already exists: {args.work_dir}")
    args.work_dir.mkdir(parents=True)
    try:
        inspect = run(["docker", "image", "inspect", args.base_image])
        if inspect.returncode != 0:
            raise RuntimeError("pinned base image is unavailable")
        base_image = json.loads(inspect.stdout)[0]
        expected_id = audit.get("baseImageId")
        if expected_id and base_image["Id"] != expected_id:
            raise RuntimeError("base image ID differs from frozen audit")
        token = registry_token()
        manifest = None
        with registry_get(token, f"manifests/{audit['manifestDigest']}", "application/vnd.docker.distribution.manifest.v2+json") as response:
            manifest = json.load(response)
        if manifest.get("config", {}).get("digest") != audit["configDigest"]:
            raise RuntimeError("registry config digest differs from audit")

        selected = {item["path"]: item for item in audit["normalizedMismatches"]}
        selected.update({item["path"]: item for item in audit["normalizedDirectories"]})
        context = args.work_dir / "context"
        context.mkdir()
        repair_root = context / "repair"
        repair_root.mkdir()
        overlay_path = context / "dependency-overlay.tar"
        written: dict[str, dict[str, Any]] = {}
        with overlay_path.open("wb") as raw:
            with tarfile.open(fileobj=raw, mode="w") as output:
                for layer in audit["sourceLayers"]:
                    digest = digest_field(layer["digest"], "sourceLayer.digest")
                    wanted = {path: item for path, item in selected.items() if item["sourceLayerDigest"] == digest}
                    if not wanted:
                        continue
                    layer_path = args.work_dir / f"{digest}.tar.gz"
                    with registry_get(token, f"blobs/sha256:{digest}") as response, layer_path.open("wb") as layer_file:
                        for block in iter(lambda: response.read(1024 * 1024), b""):
                            layer_file.write(block)
                    if sha256_file(layer_path) != digest:
                        raise RuntimeError(f"source blob digest mismatch: {digest}")
                    with tarfile.open(layer_path, mode="r:gz") as source_archive:
                        for member in source_archive:
                            name = member.name.lstrip("./")
                            if name not in wanted:
                                continue
                            item = wanted[name]
                            if item["type"] == "directory":
                                if not member.isdir():
                                    raise RuntimeError(f"selected ancestor is not a directory: {name}")
                                data = None
                            else:
                                if not member.isfile():
                                    raise RuntimeError(f"selected dependency is not regular: {name}")
                                data = source_archive.extractfile(member).read()
                                if len(data) != item["size"] or sha256_bytes(data) != item["sha256"]:
                                    raise RuntimeError(f"source bytes differ from immutable audit: {name}")
                            if member.mode != item["mode"] or member.uid != item["uid"] or member.gid != item["gid"]:
                                raise RuntimeError(f"source metadata differs from immutable audit: {name}")
                            add_tar_entry(output, member, data)
                            relative = name.removeprefix(SITE_ROOT + "/")
                            repair_path = repair_root / relative
                            if item["type"] == "directory":
                                repair_path.mkdir(parents=True, exist_ok=True)
                                os.chmod(repair_path, item["mode"])
                            else:
                                repair_path.parent.mkdir(parents=True, exist_ok=True)
                                repair_path.write_bytes(data or b"")
                                os.chmod(repair_path, item["mode"])
                            written[name] = item
                    layer_path.unlink()
        if set(written) != set(selected):
            raise RuntimeError("source layers did not contain every audited dependency")
        verify_overlay_tar(overlay_path, selected)
        dockerfile = context / "Dockerfile"
        dockerfile.write_text(
            f"FROM {args.base_image}\nCOPY --chown=0:0 repair/ /usr/local/lib/python3.12/site-packages/\n",
            encoding="utf-8",
        )
        built = run(["docker", "build", "--platform", "linux/amd64", "--pull=false", "--tag", args.tag, "."], cwd=context)
        if built.returncode:
            raise RuntimeError(f"overlay build failed: {built.returncode}")
        output = json.loads(run(["docker", "image", "inspect", args.tag]).stdout)[0]
        base_layers = base_image.get("RootFS", {}).get("Layers", [])
        output_layers = output.get("RootFS", {}).get("Layers", [])
        if output_layers[: len(base_layers)] != base_layers or len(output_layers) != len(base_layers) + 1:
            raise RuntimeError("result rootfs is not base rootfs plus exactly one repair layer")
        base_config = config_projection(base_image)
        output_config = config_projection(output)
        if base_config != output_config:
            raise RuntimeError("result runtime config projection differs from base")
        verification = verify_result_image(args.tag, audit, args.work_dir, base_image)
        repair_items = sorted(selected.values(), key=lambda item: item["path"])
        repair_proof = {
            "schemaVersion": "jev-plugin-value-dependency-repair-proof-v1",
            "paths": repair_items,
            "pathCount": len(repair_items),
            "fileCount": len(audit["normalizedMismatches"]),
            "directoryCount": len(audit["normalizedDirectories"]),
            "byteCount": sum(item["size"] for item in audit["normalizedMismatches"]),
            "overlaySha256": sha256_file(overlay_path),
        }
        proof_path = ROOT / "dependency-overlay-proof-v1.json"
        proof_path.write_text(json.dumps(repair_proof, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        recipe_path = ROOT / "dependency-overlay-recipe-v1.json"
        recipe = {
            "schemaVersion": "jev-plugin-value-dependency-recipe-v1",
            "dockerfile": dockerfile.read_text(encoding="utf-8"),
            "dockerfileSha256": sha256_file(dockerfile),
            "baseImageRef": args.base_image,
            "repairRoot": "repair/",
            "copyInstruction": "COPY --chown=0:0 repair/ /usr/local/lib/python3.12/site-packages/",
            "repairProof": proof_path.name,
            "repairProofSha256": sha256_file(proof_path),
        }
        recipe_path.write_text(json.dumps(recipe, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        source_inventory_hash = sha256_bytes(canonical(sorted(audit["normalizedSourceInventory"].values(), key=lambda item: item["path"])))
        base_inventory_hash = sha256_bytes(canonical(sorted(audit["normalizedBaseInventory"].values(), key=lambda item: item["path"])))
        receipt = {
            "schemaVersion": "jev-plugin-value-dependency-overlay-receipt-v1",
            "executionReady": False,
            "baseImageRef": args.base_image,
            "baseImageId": base_image["Id"],
            "baseRootfsDiffIds": base_layers,
            "effectiveImageRef": args.tag,
            "effectiveImageId": output["Id"],
            "rootfsDiffIds": output.get("RootFS", {}).get("Layers", []),
            "sourceManifestDigest": audit["manifestDigest"],
            "sourceConfigDigest": audit["configDigest"],
            "sourceAuditArtifact": args.audit.name,
            "auditSha256": sha256_file(args.audit),
            "builderScriptSha256": sha256_file(Path(__file__).resolve()),
            "sourceInventorySha256": source_inventory_hash,
            "baseInventorySha256": base_inventory_hash,
            "sourceInventoryCount": len(audit["normalizedSourceInventory"]),
            "baseInventoryCount": len(audit["normalizedBaseInventory"]),
            "sourceFilesystemInventorySha256": source_inventory_hash,
            "baseFilesystemInventorySha256": base_inventory_hash,
            "sourceProvenanceSha256": audit.get("provenanceSha256", audit.get("sourceProvenanceSha256")),
            "mismatchCount": len(audit["normalizedMismatches"]),
            "mismatchBytes": sum(item["size"] for item in audit["normalizedMismatches"]),
            "ancestorDirectoryCount": len(audit["normalizedDirectories"]),
            "repairSetSha256": sha256_bytes(canonical(repair_items)),
            "baseConfigSha256": sha256_bytes(canonical(base_config)),
            "finalConfigSha256": sha256_bytes(canonical(output_config)),
            "baseRootfsSha256": sha256_bytes(canonical(base_layers)),
            "finalRootfsSha256": sha256_bytes(canonical(output_layers)),
            "finalInventorySha256": verification["sourceInventorySha256"],
            "finalInventoryCount": verification["resultInventoryCount"],
            "finalFilesystemInventorySha256": verification["sourceInventorySha256"],
            "finalRootfsDiffIds": output_layers,
            "finalImageRef": args.tag,
            "finalImageId": output["Id"],
            "appendedLayerProof": proof_path.name,
            "appendedLayerProofSha256": sha256_file(proof_path),
            "recipe": recipe_path.name,
            "recipeSha256": sha256_file(recipe_path),
            "gitHead": verification["gitHead"],
            "functionalChecks": {"pytestReturnCode": verification["pytestReturnCode"], "pytestVersion": verification["pytestVersion"]},
            "overlaySha256": sha256_file(overlay_path),
            "repairInventorySha256": sha256_bytes(canonical(sorted(written.values(), key=lambda item: item["path"]))),
            "dockerfileSha256": sha256_file(dockerfile),
            "cleanup": {"workDirectoryRemoved": False},
        }
        receipt_path = ROOT / "dependency-overlay-receipt-v1.json"
        receipt_path.write_text(json.dumps(receipt, indent=2, sort_keys=True) + "\n")
        shutil.rmtree(args.work_dir)
        receipt["cleanup"]["workDirectoryRemoved"] = True
        receipt_path.write_text(json.dumps(receipt, indent=2, sort_keys=True) + "\n")
        print(json.dumps(receipt, indent=2, sort_keys=True))
    except Exception:
        # Preserve owned work and partial evidence for review on failure.
        raise


if __name__ == "__main__":
    main()
