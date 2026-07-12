# src — the code generators

The hand-written generators that turn the two sources of truth into the checked-in
artifacts under `generated/`. This is the only authored code in the repo besides the
schemas and SQL.

- `generate.mjs` — JSON Schema (`schema/`) → per-language payload types (Rust, Rust→wasm,
  TypeScript, Python, Go). Hardened: validates `index.json` + every schema, rejects
  duplicate type names / dangling `$ref`s, enforces snake_case, escapes Rust keywords,
  emits typed enums. `--check` gates staleness in CI.
- `generate-db.mjs` — SQL DDL (`sql/<plane>.sql`) → DB row types (`generated/rust-db`,
  `generated/typescript/db`), per plane. `--check` gates staleness.
- `generate.test.mjs` / `generate-db.test.mjs` — generator self-tests (no writes, no network).
- `typescript-usage.test.ts` — compile-time smoke test that the emitted TS types are usable.

Run the tests with `node --test src/*.test.mjs`.
