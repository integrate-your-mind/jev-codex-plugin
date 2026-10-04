# Dependency overlay recovery

`build-overlay.py` is a reviewable, registry-bound recovery builder for the
remaining zeroed dependency files. It is intentionally inert until invoked
with `--build`; `--plan` only validates the audit and prints counts. The script
refuses the v1 audit and requires a frozen v2 descriptor before it contacts the
registry or Docker.

The v2 audit must contain:

- `schemaVersion: "jev-plugin-value-source-layer-proof-v2"`
- the pinned repository, manifest digest, config digest, and source-layer list;
- each source layer's digest, ordered index, compressed SHA256, and byte size;
- `mismatches`, with one unique path per regular file, exact size/SHA256/mode/
  UID/GID, and the authenticated source layer digest;
- `ancestorDirectories`, with every ancestor directory needed by a mismatch,
  exact mode/UID/GID, and its authenticated source layer digest.
- `baseInventory` and `sourceInventory`, each containing exactly 15,422
  root/regular-file/directory entries. The builder derives the repair set from
  their canonical metadata difference and rejects a mismatches list that does
  not equal that difference.

The build path streams only the listed source blobs, authenticates the
compressed digest and HTTP size, rejects links and special files, checks every
selected file and directory against the immutable audit, and writes one tar
proof plus a `repair/` tree. The Dockerfile uses one
`COPY --chown=0:0 repair/ /usr/local/lib/python3.12/site-packages/` instruction;
there are no package-manager calls and no per-file Docker instructions. The
result must have the base rootfs as a prefix plus one layer, an identical
runtime config projection, and an exact 15,422-entry readback with Git HEAD
and a pytest import check. The owned RAM work directory is retained on failure
and removed only after a receipt is written.

The current base is the digest-pinned v5 Pygments/pluggy derivative. Before a
future build, the parent task must review the v2 descriptor and adapt its field
names if necessary. No provider, model, or scored benchmark invocation belongs
in this builder.

Canonical filesystem hashes are SHA256 over UTF-8 JSON produced by sorting the
normalized entry objects by `path` and serializing with sorted keys and compact
separators. Directory entries have `type: "directory"`, `size: 0`, and
`sha256: null`; regular entries have `type: "regular"` and their content hash.
The receipt records the source audit/hash, source and base inventory hashes and
counts, derived repair-set hash/count/bytes, base/final image identities and
rootfs/config projections, final full-inventory readback, Git HEAD, pytest
check, recipe hash, and appended-layer proof hash.
