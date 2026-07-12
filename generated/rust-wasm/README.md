# generated/rust-wasm — Rust→WebAssembly crate

The same serde payload types as `../rust`, plus [`tsify`](https://github.com/madonoharu/tsify)
+ `wasm-bindgen` so payloads cross the JS/wasm boundary as real objects (and a `.d.ts`
is emitted). Kept as a **separate crate** so the plain `rust` crate stays dependency-free.
**Generated** by `src/generate.mjs` — do not hand-edit.

Build: `wasm-pack build generated/rust-wasm --target web`.
