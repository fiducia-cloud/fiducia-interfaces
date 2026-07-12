# workflows — CI pipelines

GitHub Actions for the interfaces repo.

- `ci.yml` — runs the generator self-tests, fails if the checked-in `generated/`
  files are stale vs the schemas (`generate.mjs --check`) or the SQL DDL
  (`generate-db.mjs --check`), and compiles the generated Rust and Rust→wasm crates.
  The wasm job additionally type-checks the emitted `.d.ts` to catch tsify
  type-mapping regressions.
- `cli-flags.yml` — audits `.cli-flags.toml` against the flags-2-env submodule so
  documented CLI flags stay in sync; runs only when the flag config or tooling changes.
