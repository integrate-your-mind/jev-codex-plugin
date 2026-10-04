# Historical owned-file preservation

This archive preserves local source snapshots discovered after the installed Jev 0.4.1 repair. It does not change the plugin, select an experiment, restart held work, or report new validation. No source, build, test, Docker, provider, model or benchmark execution was performed for this preservation pass. Original worktree files remain untouched.

The per-file [disposition](disposition.json) covers all 60 files in the five previously untracked benchmark directories and every file in the six delivery-verification entries. Of the benchmark files, 38 exactly match public commit `c548d0b09aef8d948f9932d4114ab1921ed47ef4`, ten exactly match historical public commit `46dd949bc9292c22ceb0c5593d3f87f4670bd14a`, ten source/documentation snapshots are copied under `original-files/`, and two generated metadata/status records remain local.

## Archived source boundaries

- The batch harness is an earlier local snapshot. The public benchmark branch has later receipt-journal and grading corrections; do not treat this archive as an improvement or attribute that branch's test results to these files.
- The dependency-recovery builder, test source and README are held experimental source. Their prerequisite descriptor/image state and implementation have not been qualified in this pass. Do not run them as part of preservation.
- The two older evaluation READMEs are historical snapshots; current public READMEs contain later reproduction and attribution limitations.
- The installed-candidate probe is preserved as inert `.mjs.txt` source with the two machine-specific path literals replaced by placeholders. It represents a live-provider fixture, not an offline test. The exact original remains private.

The archived files retain their original relative paths beneath `original-files/` for provenance, but this subset is not a standalone runnable checkout. There is no implementation-candidate PR for this archive. Production code and installed 0.4.1 remain unchanged.

## Private evidence

The account/cursor diagnostic, raw test logs, draft PR text, native runtime receipt and one-off probe result remain local. The public delivery verification at `a29b4427947d85d321ae8fd2090ef8f3658e9ac0` already summarizes the tested behavior. No private transcript, credential value, account identifier or credential fingerprint is copied into this archive.
