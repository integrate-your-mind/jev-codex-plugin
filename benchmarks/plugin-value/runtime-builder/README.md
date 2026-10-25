# Reproduce the shared Linux runtime

This offline builder extracts the pinned Node 22.23.2 and Codex 0.155.0 Linux
amd64 executables, Node license, Codex package metadata, and bundled bubblewrap.
It pins the official archive sizes, SHA-256 hashes, npm SHA-512 integrity,
selected member hashes, final modes, and expected tree/manifest identities.
Existing outputs, including dangling symlinks, are never replaced.

Download the three HTTPS resources named by `NODE_ARCHIVE_URL`,
`NODE_CHECKSUMS_URL`, and `CODEX_ARCHIVE_URL` in the script. Save the Node checksum
document as `provenance/node-published-SHASUMS256.txt`. The pinned Codex npm
integrity originates from `CODEX_METADATA_URL` in the same script.

With an existing output parent and a new output directory name:

```sh
python3 -B build-shared-runtime.py \
  --node-archive node-v22.23.2-linux-x64.tar.xz \
  --codex-archive codex-0.155.0-linux-x64.tgz \
  --provenance-dir provenance \
  --output /absolute/existing-parent/new-linux-amd64-sandbox
python3 -B build-shared-runtime.test.py -v
```

The builder makes no network requests and never executes extracted binaries.
Successful output has no writable mode bits; this is a packaging property,
not proof of runtime isolation. Input archives remain caller-owned. Failed
builds remove only the new output exclusively created by that invocation.

Nine offline fixture tests passed independently under Python 3.12.13, including
a complete tiny-archive build, final modes, malformed or duplicate members,
checksum failures, existing-output preservation, and cleanup after a late
failure. Those tests substitute tiny fixture bytes and their expected hashes.
The retained real bundle separately matches the pinned manifest and tree hashes
under both identity implementations. The repaired builder has not rebuilt the
full official archives; native execution controls remain separate and pending.
See [validation.json](validation.json) for source identities and limits.
