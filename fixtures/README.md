# fixtures

Cross-language wire-contract fixtures: one JSON source of truth decoded by BOTH
the generated Rust tests (`generated/rust/tests/`) and the JS/TS suites, so the
two clients cannot drift apart on payload shapes. `invalid` entries must be
REJECTED by both sides. Add new cases here rather than duplicating payloads
per language.
