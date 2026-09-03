# Commercial-intake semantic parity audit

This standalone Rust tool compares the independently authored Fiducia TypeSpec and JSON Schema Draft 2020-12 authorities. It does not generate either authority from the other and it never selects one wholesale.

The audit normalizes TypeSpec camel-case field names to JSON snake case, checks reviewed model pairs, requiredness, string literal/enum values, HTTP methods, versioned routes, public/admin audience separation, body models, `Idempotency-Key`, and `If-Match`. It also verifies that `schema/commercial_intake.schema.json` is a distinct lead/estimate intake contract rather than an exact publication of the lifecycle authority.

The checked-in policy deliberately expects `STOPPED_FOR_EVALUATION` until the emitted discrepancy receipt is resolved. `--require-pass` exits with status 2 after writing the receipt, which gives downstream generators a fail-closed gate without hiding the evidence.

```bash
cargo test --locked --manifest-path tools/commercial-intake-parity/Cargo.toml
cargo run --locked --manifest-path tools/commercial-intake-parity/Cargo.toml -- \
  --typespec /tmp/commercial-intake.authority.tsp \
  --json-schema /tmp/commercial-intake.authority.schema.json \
  --publication schema/commercial_intake.schema.json \
  --policy provenance/commercial-intake-parity-policy.json \
  --output /tmp/commercial-intake-parity.json
```

The tool has no network access and no third-party Rust dependencies. The sibling Node materializer fetches only immutable GitHub pins into a temporary directory and verifies their Git blob identities before this tool reads them.
