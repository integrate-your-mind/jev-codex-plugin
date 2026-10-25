#!/usr/bin/env python3
"""Reproduce the pinned Node 22.23.2 / Codex 0.155.0 Linux amd64 bundle.

Download NODE_ARCHIVE_URL, NODE_CHECKSUMS_URL, and CODEX_ARCHIVE_URL with
an HTTPS client. Save the checksum document as node-published-SHASUMS256.txt
in --provenance-dir. CODEX_METADATA_URL is the published source for the pinned
npm integrity below. This builder makes no network requests or executions.

Usage:
  python3 build-shared-runtime.py --node-archive node-v22.23.2-linux-x64.tar.xz \
    --codex-archive codex-0.155.0-linux-x64.tgz --provenance-dir provenance \
    --output /absolute/existing-parent/new-linux-amd64-sandbox

An existing output (including a dangling symlink) is never replaced. The output
parent must exist. Inputs are verified before claiming the output; the manifest
is the completion marker. On failure only this invocation's new output is
removed. Archives remain caller-owned. Successful output has no writable bits;
this is a file-mode contract, not an OS immutable flag or runtime sandbox proof.
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import shutil
import stat
import sys
import tarfile
from pathlib import Path, PurePosixPath

TARGET = "linux/amd64"
SCHEMA = "plugin-value-shared-runtime-v1"
NODE_ARCHIVE_URL = "https://nodejs.org/dist/v22.23.2/node-v22.23.2-linux-x64.tar.xz"
NODE_CHECKSUMS_URL = "https://nodejs.org/dist/v22.23.2/SHASUMS256.txt"
NODE_ARCHIVE_SHA256 = "d60acfe00a2932254bb0ad20e01b0d74397a0875595de719654b214f4b03f307"
NODE_ARCHIVE_BYTES = 31058332
NODE_CHECKSUMS_SHA256 = "778ac5b2fcdbd68d9c0ae9f4310674faa3af0910bd0d18e7f6597787c40a3e39"
CODEX_METADATA_URL = "https://registry.npmjs.org/@openai%2fcodex/0.155.0-linux-x64"
CODEX_ARCHIVE_URL = "https://registry.npmjs.org/@openai/codex/-/codex-0.155.0-linux-x64.tgz"
CODEX_ARCHIVE_SHA256 = "4c4c874e0dff97277f2de92cfe82e8d84ddc2d80f206779f38c831bd2e147647"
CODEX_ARCHIVE_BYTES = 142148999
CODEX_ARCHIVE_INTEGRITY = "sha512-CiXkVTy4ERdFSXXP8n98/iOyVUCOYFPQ8cuwgeOEEbLhe1LnlQbgH/H8ZeuxO9WXKIZLJg0x626UgR9axY2zSA=="
NODE_HASH = "3517c2df0b2f8cd7f422b4b8450ef81c6889f08eb03e281d6de9079b15e6a327"
CODEX_HASH = "660e159a49e823ac8e5986cb238f73158ce4b957d40d9292f8de90862644b501"
EXPECTED_TREE = "32225cab4ec5d69ec0e54ef484b73357398ea23238cfb65f8860d5900bbaf175"
EXPECTED_MANIFEST = "a3a4b16d095d901fd0bbcfc6153c1fa9bd6777a077edb361e57cba16187cab36"

# Archive member -> (output relative path, byte length, final mode, SHA-256).
# No npm dependencies, unselected binaries, links, or archive modes are copied.
NODE_MEMBERS = {
    "node-v22.23.2-linux-x64/bin/node": ("bin/node", 124836408, 0o555, NODE_HASH),
    "node-v22.23.2-linux-x64/LICENSE": (
        "licenses/node-LICENSE", 145485, 0o444,
        "c738ae413cf561f174e34f6961f8ca458aae2369a73640dda6234c629b98bcc4",
    ),
}
CODEX_MEMBERS = {
    "package/vendor/x86_64-unknown-linux-musl/bin/codex": (
        "vendor/x86_64-unknown-linux-musl/bin/codex", 269339072, 0o555, CODEX_HASH,
    ),
    "package/vendor/x86_64-unknown-linux-musl/codex-package.json": (
        "vendor/x86_64-unknown-linux-musl/codex-package.json", 205, 0o444,
        "ddaf1668a475f4e203876d28c71d03bbb62fa4cec93197e4ab677c3514b6f2fd",
    ),
    "package/vendor/x86_64-unknown-linux-musl/codex-resources/bwrap": (
        "vendor/x86_64-unknown-linux-musl/codex-resources/bwrap", 529776, 0o555,
        "7df960565a0dece99240ea4b9d0e011307817f9f3b73176c7b71fda44fe84765",
    ),
}


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def tree_sha256(root: Path) -> str:
    """Match runtime.py's path/mode/content identity algorithm.

    Sorted relative POSIX paths; UTF-8 records; octal permission modes; exclude
    only runtime-manifest.json and the root itself. File records contain the
    file's hex SHA-256. Symlink records contain their literal target and require
    resolution inside the root. This builder never creates symlinks.
    """
    root = root.resolve(strict=True)
    digest = hashlib.sha256()
    for entry in sorted(root.rglob("*"), key=lambda p: p.relative_to(root).as_posix()):
        relative = entry.relative_to(root).as_posix()
        if relative == "runtime-manifest.json":
            continue
        metadata = entry.lstat()
        mode = stat.S_IMODE(metadata.st_mode)
        if stat.S_ISLNK(metadata.st_mode):
            resolved = entry.resolve(strict=True)
            if resolved != root and root not in resolved.parents:
                raise ValueError(f"output symlink escapes root: {relative}")
            record = f"L\0{relative}\0{mode:o}\0{os.readlink(entry)}\n"
        elif stat.S_ISDIR(metadata.st_mode):
            record = f"D\0{relative}\0{mode:o}\n"
        elif stat.S_ISREG(metadata.st_mode):
            record = f"F\0{relative}\0{mode:o}\0{sha256_file(entry)}\n"
        else:
            raise ValueError(f"unsupported output entry: {relative}")
        digest.update(record.encode("utf-8"))
    return digest.hexdigest()


def _safe_member(name: str) -> PurePosixPath:
    path = PurePosixPath(name)
    if path.is_absolute() or ".." in path.parts or path == PurePosixPath("."):
        raise ValueError(f"unsafe archive member: {name}")
    return path


def _extract_selected(
    archive: Path, mode: str, selected: dict[str, tuple[str, int, int, str]], root: Path,
) -> None:
    found: set[str] = set()
    with tarfile.open(archive, mode) as source_tar:
        for member in source_tar:
            _safe_member(member.name)
            wanted = selected.get(member.name)
            if wanted is None:
                continue
            if member.name in found:
                raise ValueError(f"duplicate archive member: {member.name}")
            if not member.isfile():
                raise ValueError(f"selected archive member is not a regular file: {member.name}")
            relative, expected_size, final_mode, expected_hash = wanted
            if member.size != expected_size:
                raise ValueError(f"size mismatch for {member.name}")
            destination = root.joinpath(*_safe_member(relative).parts)
            destination.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            source = source_tar.extractfile(member)
            if source is None:
                raise ValueError(f"cannot read selected member: {member.name}")
            with source, destination.open("xb") as output:
                shutil.copyfileobj(source, output, 1024 * 1024)
                output.flush()
                os.fsync(output.fileno())
            if destination.stat().st_size != expected_size or sha256_file(destination) != expected_hash:
                raise ValueError(f"extracted file checksum mismatch: {relative}")
            destination.chmod(final_mode)
            found.add(member.name)
    missing = set(selected) - found
    if missing:
        raise ValueError(f"missing archive members: {sorted(missing)}")


def _verify_archive(path: Path, label: str, expected_size: int, expected_sha256: str, integrity: str | None = None) -> None:
    if path.stat().st_size != expected_size:
        raise ValueError(f"{label} archive size mismatch")
    sha256 = hashlib.sha256()
    sha512 = hashlib.sha512()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            sha256.update(chunk)
            if integrity is not None:
                sha512.update(chunk)
    if sha256.hexdigest() != expected_sha256:
        raise ValueError(f"{label} archive SHA-256 mismatch")
    if integrity is not None and integrity != "sha512-" + base64.b64encode(sha512.digest()).decode("ascii"):
        raise ValueError(f"{label} archive integrity mismatch")


def manifest_bytes(tree_hash: str) -> bytes:
    manifest = {
        "schemaVersion": SCHEMA,
        "platform": TARGET,
        "treeSha256": tree_hash,
        "executables": {
            "codex": {"path": "vendor/x86_64-unknown-linux-musl/bin/codex", "version": "0.155.0", "sha256": CODEX_HASH},
            "node": {"path": "bin/node", "version": "22.23.2", "sha256": NODE_HASH},
        },
    }
    return (json.dumps(manifest, indent=2) + "\n").encode("utf-8")


def _remove_owned_output(root: Path) -> None:
    # Called only after this invocation exclusively created this exact root.
    # Restore directory write bits before removing already-frozen children.
    root.chmod(0o700)
    for entry in root.rglob("*"):
        if not entry.is_symlink() and entry.is_dir():
            entry.chmod(0o700)
    shutil.rmtree(root)


def build(node_archive: Path, codex_archive: Path, provenance_dir: Path, output: Path) -> dict:
    if os.path.lexists(output):
        raise FileExistsError(f"refusing to replace existing output: {output}")
    if not output.parent.is_dir():
        raise ValueError("output parent must already exist")
    _verify_archive(node_archive, "Node", NODE_ARCHIVE_BYTES, NODE_ARCHIVE_SHA256)
    checksums = provenance_dir / "node-published-SHASUMS256.txt"
    if sha256_file(checksums) != NODE_CHECKSUMS_SHA256:
        raise ValueError("Node published checksum source mismatch")
    node_name = NODE_ARCHIVE_URL.rsplit("/", 1)[-1]
    matches = [line.split() for line in checksums.read_text(encoding="utf-8").splitlines()
               if line.split()[-1:] == [node_name]]
    if matches != [[NODE_ARCHIVE_SHA256, node_name]]:
        raise ValueError("Node published checksum entry mismatch")
    _verify_archive(codex_archive, "Codex", CODEX_ARCHIVE_BYTES, CODEX_ARCHIVE_SHA256, CODEX_ARCHIVE_INTEGRITY)

    output.mkdir(mode=0o700)  # Exclusive claim; a concurrent creator wins safely.
    try:
        _extract_selected(node_archive, "r|xz", NODE_MEMBERS, output)
        _extract_selected(codex_archive, "r|gz", CODEX_MEMBERS, output)
        for directory in (p for p in output.rglob("*") if p.is_dir()):
            directory.chmod(0o555)
        tree_hash = tree_sha256(output)
        if tree_hash != EXPECTED_TREE:
            raise ValueError("output tree does not match pinned sandbox tree")
        data = manifest_bytes(tree_hash)
        if hashlib.sha256(data).hexdigest() != EXPECTED_MANIFEST:
            raise ValueError("output manifest does not match pinned sandbox manifest")
        # Root is excluded from the tree digest; freeze it after the manifest.
        manifest_path = output / "runtime-manifest.json"
        with manifest_path.open("xb") as manifest_file:
            manifest_file.write(data)
            manifest_file.flush()
            os.fsync(manifest_file.fileno())
        manifest_path.chmod(0o444)
        output.chmod(0o555)
        return json.loads(data)
    except BaseException as error:
        try:
            _remove_owned_output(output)
        except OSError as cleanup_error:
            raise RuntimeError(f"build failed ({error}); cleanup failed for owned output {output}: {cleanup_error}") from error
        raise


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--node-archive", type=Path, required=True)
    parser.add_argument("--codex-archive", type=Path, required=True)
    parser.add_argument("--provenance-dir", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args(argv)
    try:
        result = build(args.node_archive, args.codex_archive, args.provenance_dir, args.output)
    except Exception as error:
        print(f"error: {error}", file=sys.stderr)
        return 1
    print(json.dumps(result, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
