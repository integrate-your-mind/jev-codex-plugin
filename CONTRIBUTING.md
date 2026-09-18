# Contributing

The canonical public source is `source/jev-workflows`. Keep changes focused and add regression coverage for changed behavior. Run typecheck, build, tests, and manifest validation before proposing changes. Do not add live network calls to the default test suite.

`plugins/jev-workflows` is generated with `node scripts/package-host.mjs /absolute/path/to/plugins/jev-workflows` from the source directory. Never include a machine-specific `--state-directory` override in public artifacts. Keep the portable and generated manifests at the same release version and include updated prebuilt runtime files.

Submit a pull request describing the behavior change, verification, and host compatibility limits. Do not claim classifier accuracy from synthetic fixtures alone.
