# fiducia-interfaces

Shared interfaces + definitions for [fiducia.cloud](https://fiducia.cloud), on two
sources of truth:

1. **JSON Schema** (`schema/*.schema.json`, Draft 2020-12) — typed-IO for the
   API payloads (KV, locks/semaphores/RW, rate limiting, scheduling, elections,
   discovery, common envelopes). The generator emits idiomatic types per
   language.
2. **SQL** (`sql/customer.sql` + `sql/admin.sql`) — canonical Postgres schemas,
   split **by plane**: the customer plane (orgs, projects, users, API keys, mTLS
   identities, preferences, trusted sessions, audit) and the admin plane
   (operators, infra-operation audit, admin audit). The admin and customer apps
   run on **separate Postgres instances** — a security boundary — so their
   schemas are separate too. Every optimistically-editable table carries the
   local-first sync contract (`updated_at` + monotonic `version`, advanced by the
   `bump_row_version` trigger).

Same spirit as `remote/libs/interfaces` (JSON Schema → types) and
`remote/libs/pg-defs` (canonical SQL).

> Coordination data (locks/KV/rate limits/schedules/elections/discovery state)
> does **not** live in Postgres — it's the per-node Raft state machine backed by
> each shard's Raft log and local snapshots. The SQL here is only the relational
> business data. See the node storage design.

## Layout

```
fiducia-interfaces/
├── schema/                     # JSON Schema — source of truth for payloads
│   ├── index.json              # list of every schema file (alphabetised)
│   ├── common.schema.json      # ProposeOutcome, ProposeError, Introspection
│   ├── kv.schema.json          # KvEntry, KvPutRequest, KvGetResponse
│   ├── locks.schema.json       # Mutex/semaphore/multi-key lock, release, RW payloads
│   ├── rate_limits.schema.json # RateLimitCheck/Snapshot/GetResponse
│   ├── schedules.schema.json   # ScheduleTarget/Upsert/Run/History
│   ├── elections.schema.json   # Campaign/Hold, Leadership, ElectionGet
│   └── discovery.schema.json   # ServiceRegister/Instance/List
├── sql/customer.sql            # customer-plane Postgres schema (own DB instance)
├── sql/admin.sql               # admin-plane Postgres schema (separate DB instance)
├── sql/ai_agent_control_plane.sql      # additional planes (own DB instances)
├── sql/operations_control_plane.sql
├── sql/ai_agent_bridge.sql
├── src/generate.mjs            # JSON Schema → per-language payload types
├── src/generate-db.mjs         # SQL DDL → per-plane DB row types
├── .cli-flags.toml             # CLI-flag ↔ env-var contract (flags-2-env)
├── scripts/with-flags2env.sh   # apply .cli-flags.toml flags as env, then exec
├── vendor/flags-2-env/         # pinned submodule (do not hand-edit)
└── generated/                  # check-in artifacts — never hand-edit
    ├── rust/{Cargo.toml,src/lib.rs}        # payload types (dependency-free serde)
    ├── rust-wasm/{Cargo.toml,src/lib.rs}   # Rust compiled to WebAssembly (tsify boundary)
    ├── rust-db/{Cargo.toml,src/*.rs}       # sqlx::FromRow row types, one module per plane
    ├── typescript/{index.ts,db/*.ts}       # payload types + per-plane DB row types
    ├── python/fiducia_interfaces.py
    └── go/interfaces.go
```

## Generator

```sh
node src/generate.mjs          # JSON Schema → generated/<lang>/...
node src/generate-db.mjs       # SQL DDL → generated/rust-db + generated/typescript/db
node src/generate.mjs --check  # CI: fail if generated files are stale
node --test src/*.test.mjs     # generator self-tests
```

Two generators, two sources of truth: `generate.mjs` turns the JSON Schema into
payload types, and `generate-db.mjs` parses each `sql/<plane>.sql` DDL into
`sqlx::FromRow` row structs (`generated/rust-db`) and TS row types
(`generated/typescript/db/<plane>.ts`). Both are pure, offline codegen (read local
files, `JSON.parse` / regex, write `generated/`) — no network, no runtime queries.
`--check` on either fails CI when the checked-in `generated/` output drifts from
its source. Everything under `generated/` is a build artifact — never hand-edit it;
edit the schema or SQL and regenerate.

The generator is hardened: it validates `index.json` + every schema, rejects
duplicate type names and dangling `$ref`s, enforces snake_case field names,
sanitizes doc comments, raw-escapes Rust keyword fields (`r#type`), and emits
typed enums for string `enum`s (Rust enum · TS union · Python `Literal` · Go
string + allowed-values doc). CI runs the self-tests and `--check` on every push.

## Languages

First-class today: **Rust**, **Rust→WebAssembly**, **TypeScript**, **Python**,
**Go**. Adding a language is one render function in `src/generate.mjs` (see the
`EMITTERS` map).

The `rust-wasm` target is the same serde types as `rust`, plus
[`tsify`](https://github.com/madonoharu/tsify) + `wasm-bindgen` so payloads cross
the JS/wasm boundary as real objects (and a `.d.ts` is emitted). It is a separate
crate so the plain `rust` crate stays dependency-free. Build it with:

```sh
wasm-pack build generated/rust-wasm --target web
# or: cargo build --manifest-path generated/rust-wasm/Cargo.toml --target wasm32-unknown-unknown
```

The roadmap is the rest of the **client languages** in
[`fiducia-clients`](https://github.com/fiducia-cloud/fiducia-clients) — dart,
ruby, java, csharp, php, elixir — so each HTTP client ships typed payloads
generated from this single source. (Shell/PowerShell are untyped and consume the
JSON directly.)

## Use as a dependency

```toml
# Rust (generated crate)
fiducia-interfaces = { git = "https://github.com/fiducia-cloud/fiducia-interfaces", tag = "v0.1.0" }
```
```ts
// TypeScript
import type { LockGrant } from "@fiducia/interfaces/typescript";
```

## Consumers

Servers (`fiducia-node`/`auth`/...) and every client in `fiducia-clients`
validate their request/response shapes against these types. The customer portal
(`fiducia-backend.rs`) uses `sql/customer.sql` and the admin dashboard
(`fiducia-admin.rs`) uses `sql/admin.sql`, each against its own isolated Postgres
instance.
