# generated/rust-db — DB row crate (Rust)

The Rust crate of Postgres row types, **generated** by `src/generate-db.mjs` from
`sql/<plane>.sql` — do not hand-edit. One module per plane. CI `cargo check`s this crate
to catch SQL→Rust mapping regressions.

- `Cargo.toml` — crate manifest.
- `src/` — the emitted per-plane row types (`admin`, `customer`, `ai_agent_bridge`,
  `ai_agent_control_plane`, `operations_control_plane`) re-exported from `lib.rs`.
