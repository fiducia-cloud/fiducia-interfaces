# Fiducia opportunity-application contract

This directory contains two co-equal, independently authored authorities for the
packet that moves a Fiducia opportunity from preparation toward submission:

- `main.tsp` is the TypeSpec authority;
- `authored.schema.json` is the JSON Schema Draft 2020-12 authority.

Neither file is generated from the other. The JSON Schema emitted from TypeSpec
by `ORESoftware/typespec-json-schema-validator` is comparison evidence only.
Any unexplained disagreement fails CI and prevents admission of Contract IR.

## Safety boundary

The contract records what has been verified, what remains unresolved, the exact
intake mode and route, and whether the completed packet was shown to and
explicitly approved by Alex. Generic or historical authorization does not make a
new packet approved. The opportunity automation boundary always keeps legal
terms, payment obligations, travel commitments, recording/publicity consent,
and relocation commitments false.

The fixtures are synthetic. They are contract tests, not evidence that any
application was submitted, acknowledged, approved, rejected, or withdrawn.

## Cross-runtime admission

The admitted Contract IR is the digest-bound projection gate for TypeScript,
Rust, Go, and Dart consumers. A runtime projection must not fall back to either
authority, a stale receipt, an incomplete declaration inventory, or a generated
JSON Schema witness.

Run the dependency-free local policy and corpus checks with:

```bash
node --test \
  src/opportunity-application-policy.test.mjs \
  src/check-opportunity-application-contract.test.mjs
node src/check-opportunity-application-contract.mjs
```

Compiler-backed peer parity and altered-evidence rejection run in
`.github/workflows/opportunity-application-contract.yml` at an exact TJSV commit.
