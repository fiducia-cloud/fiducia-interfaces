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
   (operators, infra-operation audit, admin audit, and a request-bound
   idempotency ledger). The admin and customer apps run on **separate Postgres
   instances** — a security boundary — so their schemas are separate too. Every
   optimistically-editable table carries two distinct ordering values:
   per-row `version` for compare-and-swap/reconciliation, and a plane-wide,
   transactionally allocated `sync_sequence` for stable catch-up pagination.
   Durable, scoped tombstones carry deletes through the same global cursor.

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

Customer and admin sync idempotency keys are bound to a canonical SHA-256 request
fingerprint. Writers claim the key, perform the version-CAS mutation, and persist
the committed row version in one transaction. A legacy NULL fingerprint or a
different fingerprint must never replay; it fails closed and requires a new key.
The SQL intentionally keeps legacy fingerprints nullable so that state remains
distinguishable during rolling upgrades.

CI installs dependencies strictly from `package-lock.json`, runs the complete
`npm test` contract, checks all generated Rust crates with rustfmt and Clippy,
builds the wasm target with an exact tool version, and audits every npm/Cargo
lockfile. Action SHAs, Node, Rust, wasm-pack, and cargo-audit are immutable pins.

The root Dockerfile is a contract **test image**, not a long-running service. It
copies `package-lock.json` and every generated Rust `Cargo.lock`, installs npm
dependencies with `npm ci --ignore-scripts`, and relies on the `--locked` Cargo
commands in `npm test`. Build and test execution run as numeric UID/GID
`65532:65532`; the image exposes no port and starts no daemon. TypeScript comes
from the npm lockfile rather than a mutable global install.

## Languages

First-class today: **Rust**, **Rust→WebAssembly**, **TypeScript**, **Python**,
**Go**. Adding a language is one render function in `src/generate.mjs` (see the
`EMITTERS` map).

The `rust-wasm` target is the same serde types as `rust`, plus
[`tsify`](https://github.com/madonoharu/tsify) + `wasm-bindgen` so payloads cross
the JS/wasm boundary as real objects (and a `.d.ts` is emitted). It is a separate
crate so the plain `rust` crate stays dependency-free. Build it with:

```sh
wasm-pack build generated/rust-wasm --target web -- --locked
# or: cargo build --locked --manifest-path generated/rust-wasm/Cargo.toml --target wasm32-unknown-unknown
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

## Configuration (CLI flags → env)

CLI flags and their environment-variable mappings are declared once in
[`.cli-flags.toml`](.cli-flags.toml) and applied by the pinned
[flags-2-env](https://github.com/ORESoftware/flags-2-env) tool
(`vendor/flags-2-env`, a git submodule — do not hand-edit; bump the pin instead).

```sh
git submodule update --init --recursive       # fetch the pinned tool
make -C vendor/flags-2-env all                 # build vendor/flags-2-env/build/flags2env
scripts/with-flags2env.sh check -- npm run generate   # flags → env, then exec
```

`scripts/with-flags2env.sh [flags...] -- <cmd>` resolves the flags through
`flags2env` and execs `<cmd>` with the resulting env applied (override the binary
with `FLAGS2ENV_BIN`). Today the only flag is `check` →
`FIDUCIA_GENERATE_CHECK` (bool), read by both generators to run the staleness gate
without writing. The `cli-flags` CI workflow runs `flags2env audit .cli-flags.toml`
so the declared flags never drift from the tool. No secret-valued flags are
declared; add new ones to `.cli-flags.toml` (mark any secret in its `help`).

## Security & dependency audits

No committed secrets: credential columns store hashes only (e.g. `api_keys.secret_hash`),
and `fencing_token` throughout is a distributed-systems term, not a credential. The
SQL is pure DDL; its one dynamic statement uses `format(..., %I)` identifier-quoting
over a hardcoded table list. The generators run offline over local files and issue no
SQL, so there is no query-injection or unsafe-deserialization surface.

Supabase's `public` schema is treated as an API-exposed boundary. Backend-only
membership, audit, and idempotency relations have RLS enabled with no client
policy and explicitly revoke privileges from `anon` and `authenticated` when
those roles exist. Raw `api_keys` rows are not in the realtime publication:
row-level security cannot hide `secret_hash`, so customer key metadata is served
only by an authenticated backend endpoint that returns a sanitized projection.
Service backends must connect with a dedicated `BYPASSRLS` role and must never
hand that credential to browsers.

Dependency advisories (`cargo audit` per generated crate, `npm audit`), last reviewed
2026-07-12:

| Target | Status |
| --- | --- |
| `generated/rust` (payloads) | clean — 0 advisories |
| `generated/rust-wasm` | clean — 0 advisories |
| `generated/rust-db` | 1 accepted: `RUSTSEC-2023-0071` (`rsa` — Marvin timing side-channel). No upstream fix; pulled transitively via `sqlx-mysql`, which this crate does **not** enable (Postgres-only features), so it is not compiled in. |
| npm (`package-lock.json`) | clean — 0 vulnerabilities |

`cargo audit` scans the whole `Cargo.lock` regardless of feature selection, which is
why the unused `rsa` still surfaces. Node, Rust, and GitHub Actions updates land
via Dependabot (`.github/dependabot.yml`); CI remains pinned until those reviewed
updates merge.
