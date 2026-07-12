# generated/rust — Rust payload crate

The Rust `fiducia-interfaces` crate, **generated** by `src/generate.mjs` from
`schema/`. Dependency-free serde types (no wasm deps — see `../rust-wasm` for the
WebAssembly variant). **Do not hand-edit** — change `schema/` and regenerate.

- `Cargo.toml` — crate manifest.
- `src/lib.rs` — the emitted `Serialize`/`Deserialize` payload types.
- `tests/lock_payloads.rs` — checked-in payload round-trip tests.
