"""Offline fixtures only: no downloads, executable launches, or real bundle edits."""
import base64
import hashlib
import importlib.util
import io
import json
import os
import stat
import tarfile
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).parent
SPEC = importlib.util.spec_from_file_location("builder", ROOT / "build-shared-runtime.py")
builder = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(builder)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def write_tar(path, entries, mode="w:gz"):
    with tarfile.open(path, mode) as archive:
        for name, payload, kind in entries:
            info = tarfile.TarInfo(name)
            info.type = kind
            info.size = len(payload) if kind == tarfile.REGTYPE else 0
            info.linkname = "../../outside" if kind in (tarfile.SYMTYPE, tarfile.LNKTYPE) else ""
            archive.addfile(info, io.BytesIO(payload) if kind == tarfile.REGTYPE else None)


class BuilderTests(unittest.TestCase):
    def setUp(self):
        self.tmpdir = Path(tempfile.mkdtemp(prefix="jev-runtime-builder-fixture-"))
        self.addCleanup(builder._remove_owned_output, self.tmpdir)

    def fixture(self):
        node = self.tmpdir / "node.tar.xz"
        codex = self.tmpdir / "codex.tgz"
        provenance = self.tmpdir / "provenance"
        provenance.mkdir()
        payloads = {
            "bin/node": b"synthetic node bytes\n",
            "licenses/node-LICENSE": b"synthetic license\n",
            "vendor/x86_64-unknown-linux-musl/bin/codex": b"synthetic codex bytes\n",
            "vendor/x86_64-unknown-linux-musl/codex-package.json": b'{"fixture": true}\n',
            "vendor/x86_64-unknown-linux-musl/codex-resources/bwrap": b"synthetic bwrap bytes\n",
        }
        specs = {}
        for name, originals in (("NODE_MEMBERS", builder.NODE_MEMBERS), ("CODEX_MEMBERS", builder.CODEX_MEMBERS)):
            specs[name] = {member: (rel, len(payloads[rel]), mode, digest(payloads[rel]))
                           for member, (rel, _, mode, _) in originals.items()}
        write_tar(node, [(member, payloads[spec[0]], tarfile.REGTYPE)
                         for member, spec in specs["NODE_MEMBERS"].items()], "w:xz")
        write_tar(codex, [(member, payloads[spec[0]], tarfile.REGTYPE)
                          for member, spec in specs["CODEX_MEMBERS"].items()])
        checksum_text = (digest(node.read_bytes()) + "  " + builder.NODE_ARCHIVE_URL.rsplit("/", 1)[-1] + "\n")
        (provenance / "node-published-SHASUMS256.txt").write_text(checksum_text)
        # Independent expected records from fixture specifications, not the
        # builder tree function. Includes every parent directory at mode 0555.
        records = {}
        for mapping in specs.values():
            for rel, _, mode, checksum in mapping.values():
                records[rel] = f"F\0{rel}\0{mode:o}\0{checksum}\n"
                for parent in Path(rel).parents:
                    if parent != Path("."):
                        relative = parent.as_posix()
                        records[relative] = f"D\0{relative}\0{0o555:o}\n"
        tree_hash = digest("".join(records[name] for name in sorted(records)).encode())
        node_hash = digest(payloads["bin/node"])
        codex_hash = digest(payloads["vendor/x86_64-unknown-linux-musl/bin/codex"])
        expected_manifest = {
            "schemaVersion": "plugin-value-shared-runtime-v1", "platform": "linux/amd64", "treeSha256": tree_hash,
            "executables": {
                "codex": {"path": "vendor/x86_64-unknown-linux-musl/bin/codex", "version": "0.155.0", "sha256": codex_hash},
                "node": {"path": "bin/node", "version": "22.23.2", "sha256": node_hash},
            },
        }
        expected_bytes = (json.dumps(expected_manifest, indent=2) + "\n").encode()
        overrides = {
            **specs, "NODE_ARCHIVE_BYTES": node.stat().st_size, "CODEX_ARCHIVE_BYTES": codex.stat().st_size,
            "NODE_ARCHIVE_SHA256": digest(node.read_bytes()), "CODEX_ARCHIVE_SHA256": digest(codex.read_bytes()),
            "NODE_CHECKSUMS_SHA256": digest(checksum_text.encode()),
            "CODEX_ARCHIVE_INTEGRITY": "sha512-" + base64.b64encode(hashlib.sha512(codex.read_bytes()).digest()).decode(),
            "NODE_HASH": node_hash, "CODEX_HASH": codex_hash,
            "EXPECTED_TREE": tree_hash, "EXPECTED_MANIFEST": digest(expected_bytes),
        }
        return (node, codex, provenance), overrides, payloads, expected_bytes

    def test_complete_build_and_readonly_modes(self):
        inputs, pins, payloads, expected = self.fixture()
        output = self.tmpdir / "output"
        with mock.patch.multiple(builder, **pins):
            result = builder.build(*inputs, output)
        self.assertEqual((output / "runtime-manifest.json").read_bytes(), expected)
        self.assertEqual(result, json.loads(expected))
        self.assertEqual(builder.tree_sha256(output), pins["EXPECTED_TREE"])
        for rel, data in payloads.items():
            self.assertEqual((output / rel).read_bytes(), data)
        self.assertEqual(sum(p.is_file() for p in output.rglob("*")), 6)
        for entry in (output, *output.rglob("*")):
            self.assertEqual(stat.S_IMODE(entry.stat().st_mode) & 0o222, 0, entry)
        # An ordinary user must be able to finish without chmod or rename errors.
        self.assertEqual(stat.S_IMODE(output.stat().st_mode), 0o555)

    def test_existing_output_and_dangling_link_preserved_before_inputs(self):
        output = self.tmpdir / "existing"
        output.mkdir()
        (output / "sentinel").write_bytes(b"keep")
        link = self.tmpdir / "dangling"
        link.symlink_to(self.tmpdir / "missing")
        for destination in (output, link):
            with self.assertRaises(FileExistsError):
                builder.build(self.tmpdir / "missing-node", self.tmpdir / "missing-codex", self.tmpdir / "missing-provenance", destination)
        self.assertEqual((output / "sentinel").read_bytes(), b"keep")
        self.assertTrue(link.is_symlink())

    def test_wrong_archive_and_integrity_rejected_before_output(self):
        inputs, pins, _, _ = self.fixture()
        for pin in ("NODE_ARCHIVE_SHA256", "CODEX_ARCHIVE_SHA256", "CODEX_ARCHIVE_INTEGRITY", "NODE_CHECKSUMS_SHA256"):
            with self.subTest(pin=pin), mock.patch.multiple(builder, **{**pins, pin: "incorrect"}):
                output = self.tmpdir / pin
                with self.assertRaises(ValueError):
                    builder.build(*inputs, output)
                self.assertFalse(os.path.lexists(output))

    def test_failed_final_hash_cleans_frozen_children_and_preserves_inputs(self):
        inputs, pins, _, _ = self.fixture()
        before = [(path, path.read_bytes()) for path in inputs[:2]]
        for pin in ("EXPECTED_TREE", "EXPECTED_MANIFEST"):
            with self.subTest(pin=pin), mock.patch.multiple(builder, **{**pins, pin: "incorrect"}):
                output = self.tmpdir / pin
                with self.assertRaises(ValueError):
                    builder.build(*inputs, output)
                self.assertFalse(os.path.lexists(output))
        for path, data in before:
            self.assertEqual(path.read_bytes(), data)

    def test_selected_payload_mismatch_cleans_partial_output(self):
        inputs, pins, _, _ = self.fixture()
        specs = dict(pins["CODEX_MEMBERS"])
        member = next(iter(specs))
        rel, size, mode, _ = specs[member]
        specs[member] = (rel, size, mode, "incorrect")
        with mock.patch.multiple(builder, **{**pins, "CODEX_MEMBERS": specs}):
            with self.assertRaisesRegex(ValueError, "checksum mismatch"):
                builder.build(*inputs, self.tmpdir / "partial")
        self.assertFalse((self.tmpdir / "partial").exists())

    def test_rejects_unsafe_paths(self):
        for value in ("/etc/passwd", "package/../escape", "..", ".", ""):
            with self.subTest(value=value), self.assertRaises(ValueError):
                builder._safe_member(value)

    def test_selected_nonregular_duplicate_missing_and_bad_size(self):
        cases = [
            ([("package/file", b"", kind)], "not a regular file")
            for kind in (tarfile.DIRTYPE, tarfile.SYMTYPE, tarfile.LNKTYPE, tarfile.FIFOTYPE)
        ]
        cases.extend([
            ([("package/file", b"x", tarfile.REGTYPE)] * 2, "duplicate"),
            ([("other", b"x", tarfile.REGTYPE)], "missing"),
            ([("package/file", b"xx", tarfile.REGTYPE)], "size mismatch"),
            ([("../outside", b"x", tarfile.REGTYPE)], "unsafe"),
        ])
        for index, (entries, error) in enumerate(cases):
            archive = self.tmpdir / f"fixture-{index}.tgz"
            write_tar(archive, entries)
            with self.subTest(index=index), self.assertRaisesRegex(ValueError, error):
                builder._extract_selected(archive, "r|gz", {"package/file": ("out", 1, 0o444, digest(b"x"))}, self.tmpdir / f"out-{index}")

    def test_manifest_excluded_and_mode_included_in_tree_hash(self):
        (self.tmpdir / "a").write_bytes(b"a")
        first = builder.tree_sha256(self.tmpdir)
        (self.tmpdir / "runtime-manifest.json").write_bytes(b"anything")
        self.assertEqual(builder.tree_sha256(self.tmpdir), first)
        (self.tmpdir / "a").chmod(0o444)
        self.assertNotEqual(builder.tree_sha256(self.tmpdir), first)

    def test_tree_rejects_escape_symlink(self):
        (self.tmpdir / "escape").symlink_to(self.tmpdir.parent)
        with self.assertRaisesRegex(ValueError, "escapes root"):
            builder.tree_sha256(self.tmpdir)


if __name__ == "__main__":
    unittest.main()
