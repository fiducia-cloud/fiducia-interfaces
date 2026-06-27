# fiducia-interfaces

Shared interfaces + definitions for [fiducia.cloud](https://fiducia.cloud), on two
sources of truth:

1. **JSON Schema** (`schema/*.schema.json`, Draft 2020-12) — typed-IO for the
   API payloads (KV, locks/semaphores/RW, rate limiting, scheduling, elections,
   discovery, common envelopes). The generator emits idiomatic types per
   language.
2. **SQL** (`sql/schema.sql`) — the canonical Postgres schema for the
   control/business plane (orgs, users, API keys, audit), in the same
   desired-state-contract style as the `pg-defs` lib.

Same spirit as `remote/libs/interfaces` (JSON Schema → types) and
`remote/libs/pg-defs` (canonical SQL).

> Coordination data (locks/KV/rate limits/schedules/elections/discovery state)
> does **not** live in Postgres — it's the per-node Raft state machine. The SQL
> here is only the relational business data. See the discussion in the
> data-storage design.

## Layout

```
fiducia-interfaces/
├── schema/                     # JSON Schema — source of truth for payloads
│   ├── index.json              # list of every schema file (alphabetised)
│   ├── common.schema.json      # ProposeOutcome, ProposeError, Introspection
│   ├── kv.schema.json          # KvEntry, KvPutRequest, KvGetResponse
│   ├── locks.schema.json       # LockAcquire/Grant/Release, RwAcquire
│   ├── rate_limits.schema.json # RateLimitCheck/Snapshot/GetResponse
│   ├── schedules.schema.json   # ScheduleTarget/Upsert/Run/History
│   ├── elections.schema.json   # Campaign/Hold, Leadership, ElectionGet
│   └── discovery.schema.json   # ServiceRegister/Instance/List
├── sql/schema.sql              # canonical Postgres schema (auth/business)
├── src/generate.mjs            # JSON Schema → per-language types
└── generated/                  # check-in artifacts — never hand-edit
    ├── rust/{Cargo.toml,src/lib.rs}
    ├── typescript/index.ts
    ├── python/fiducia_interfaces.py
    └── go/interfaces.go
```

## Generator

```sh
node src/generate.mjs          # write generated/<lang>/...
node src/generate.mjs --check  # CI: fail if generated files are stale
node --test src/*.test.mjs     # generator self-tests
```

The generator is hardened: it validates `index.json` + every schema, rejects
duplicate type names and dangling `$ref`s, enforces snake_case field names,
sanitizes doc comments, raw-escapes Rust keyword fields (`r#type`), and emits
typed enums for string `enum`s (Rust enum · TS union · Python `Literal` · Go
string + allowed-values doc). CI runs the self-tests and `--check` on every push.

## Languages

First-class today: **Rust**, **TypeScript**, **Python**, **Go**. Adding a
language is one render function in `src/generate.mjs` (see the `EMITTERS` map).

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
validate their request/response shapes against these types; `fiducia-auth` +
dashboards use `sql/schema.sql` for the business DB.
