# Original registry byte restoration, 26 September 2026

Status: recovery implementation and controls pending. This amendment is being
recorded before any scored task inference. The original schedule, task sources,
model, effort, plugin treatment and independent task verifiers remain unchanged.

## Observed failure

The original IPython no-op and reference-solution controls both failed to import
pytest because `pygments.formatters.terminal.TerminalFormatter` was unavailable.
No test executed: the 46 reported failures were missing-result placeholders.
The reference patch was collected, so those zero rewards do not measure code
correctness.

The local base image and inherited verifier contained 338 empty Pygments Python
files. The initial metadata search used a case-sensitive package-name glob, so
it did not establish whether distribution metadata was absent. The immutable public registry layer
contains populated package files, including a 4,626-byte terminal formatter and
a 2,959-byte package initializer. This establishes a discrepancy between registry
bytes and the local unpacked filesystem. It does not establish when or why the
local corruption occurred.

Original registry manifest:
`sha256:ba83b5e9940114642ce64dd3644b4740c6776cba16b964964703422d3cdec4e1`.
Pygments package layer:
`sha256:7af86c1121e677d40e31d478434bd24c148439e6f6710f2567a924e9642f4c2f`.

Restoring Pygments exposed the same defect in Pluggy: its initializer and hook
module were empty, and pytest could not import `HookimplMarker`. The original
Pluggy layer is
`sha256:d0648bc472c60b4f930117e02bbbe63760a15394251035e234e8db17bb3c1844`.
The recovered registry metadata identifies Pygments 2.19.2 and Pluggy 1.6.0.
An intermediate derivative successfully imported both packages and pytest, but
its evidence bundle failed review because adjacent artifact hashes disagreed
with its manifest. That intermediate result is not permission to score tasks.
Retain it and complete a fresh, coherent proof bundle before freezing recovery.

## Recovery contract

Preserve the original registry identity ledger and all failed control records.
Restore only the demonstrated damaged packages and their original metadata from
authenticated registry layer bytes into a separately identified local derivative.
Do not install a guessed or newer dependency, modify task source, alter hidden
tests, or delete shared Docker state. Verify that later registry layers do not
legitimately supersede the restored paths, including deletion or opaque-directory
markers on the paths or their ancestors. Bind the actual bytes of those checked
layers to their registry digests. The two packages originate in different layers:
Pygments has 14 subsequent layers and Pluggy has 10.

Bind the original manifest and configuration identity, registry layer evidence,
restoration recipe, exhaustive file manifest, effective local image ID and layer
identity in a separate recovery manifest. The derivative is not represented as
the original registry digest. A local tag may locate it, but the exact image ID
and live restored-file hashes and metadata must match before use. Legitimate
empty files retain their original size and digest; empty files are not corruption
merely because they are empty. Image metadata alone is
insufficient because the observed corruption occurred under a valid image ID.

Both arms use the same resolved effective image. Validate upstream task and
verifier source against their original identities first. Only the private copied
verifier Dockerfile may substitute the resolved base; its build identity must
include the effective image identity to avoid reusing the prior damaged build.
The verifier remains offline and contains neither the Codex runtime nor account
credentials. The source registry ledger remains independently inspectable.

## Required evidence before scoring

The recovery manifest and final source hashes remain unready until the complete
restored-file comparison, pytest import, repository integrity check, and original
no-op/reference controls succeed on the effective image. Keep all failures and
missing tests distinct from task-quality results. Demonstrate that both arms
resolve to the same image and that the independent verifier inherits that base.

The earlier native v4 controls establish command, patch, host-hook and provider
integration under their recorded image and runtime identity. They do not by
themselves validate this new recovery image. No scored row may start while these
recovery checks are incomplete.

## Verifier platform control correction

The first recovered-image no-op control stopped before tests because BuildKit
selected the arm64 host platform for the local amd64 base. Its trial remains
recorded as infrastructure-invalid with no verifier reward. The private copied
Compose override now sets both service platform and build platforms to
linux/amd64. The original verifier Dockerfile, tests, task source, model and
schedule are unchanged. New source hashes and no-op/reference controls are
required before scoring.

## Broader dependency corruption observed

After the platform correction, both the unchanged and reference-solution
controls still produced zero executed tests and 46 missing-result placeholders.
The reference patch was collected (22,076 bytes), but pytest failed to import
Version from packaging.version; the local version.py is zero bytes. An offline
read-only scan counted 1,853 empty Python files across many dependency packages.
This count alone is not a corruption inventory because some empty files are
legitimate. A complete site-packages comparison against the immutable registry
layer sequence must identify the repair set before another image is built.
The recovered image is not ready for scored inference. The source snapshots,
control failures and private archive hashes are retained in runtime-validation.json.
