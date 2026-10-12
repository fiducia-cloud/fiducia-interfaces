# RPC codec admission v1 (#130)

The contract lives in `contracts/rpc-payload-codecs/v1/policy.json`.
`src/rpc-payload-admission.mjs` provides a **reusable local reference boundary**.
It is not yet mounted by the live Fiducia API, TCP gateway, or WebSocket
implementation, and is not evidence of generated SDK parity.

- JSON is the default and is implemented for HTTP payloads, TCP NDJSON,
  32-bit big-endian length framing, and WebSocket bytes.
- Raw bytes require explicit `expectsBytes: true`. Never coerce a binary
  WebSocket payload into a text string, or treat arbitrary object JSON as bytes.
- MessagePack, CBOR, and Protobuf are **declared but disabled**, until
  validators, exact golden vectors and generated client implementations pass.
  Advertising a codec as available when it is not implemented fails closed.
- TCP NDJSON is **JSON only**; bounded binary framing uses a strict unsigned
  32-bit network-endian length and rejects truncation or trailing records.
- HTTP `Content-Type` and `Accept` are explicit. No wildcard fallback or
  implicit content negotiation.
- Every decoded structured payload requires a caller-provided semantic
  validation function to return `true`. Shape/authorization remains a
  separate application responsibility. Streaming, authentication and
  compression remain independent of codec/framing selection.

Run the self-contained reference tests:

```sh
node --test src/rpc-payload-admission.test.mjs
```

Remaining work: wire into real HTTP/TCP/WS ingress and generated Rust/Dart/
TypeScript SDKs, implement remaining codecs, add digest-bound provider-neutral
schema metadata, contract evolution and full cross-backend golden vectors.
Do not close #130 on this reference-only PR.
