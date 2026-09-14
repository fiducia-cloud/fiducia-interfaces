# Additive TJSV projection gates

Fiducia contract authority remains exactly two peer sources: human-authored TypeSpec and independently authored JSON Schema Draft 2020-12. Protobuf, WIT, and Dafny are optional additive projections and must never become competing semantic authorities.

## Admission

When a projection lane exists, it is fail-closed. Its artifact and machine-readable projection metadata must bind to the exact current TypeSpec source, authored JSON Schema, TypeSpec-generated comparison witness, TJSV parity receipt, and Contract IR.

Required lane identifiers are `protobuf`, `wit`, and `dafny`. Consumers must not invent aliases or casing variants.

Native verification remains mandatory: Buf/protoc for Protobuf where applicable, `wasm-tools` for WIT, and Dafny verification for proof artifacts. A syntactically present file without executable verification is non-evidence.

## Authority rule

Generated Schema B, Contract IR, Protobuf, WIT, Dafny, SQL, SDKs, and language bindings are downstream evidence only. They may veto promotion when stale or inconsistent but may not overwrite either authored peer to force parity.

Tip-of-main canaries and immutable released-package checks are separate evidence classes; release promotion should bind projections to the exact released source identity.

Tracking: #104.