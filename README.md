# fiducia-interfaces

Shared interfaces + definitions for [fiducia.cloud](https://fiducia.cloud), on two
sources of truth:

1. **JSON Schema** (`schema/*.schema.json`, Draft 2020-12) — typed I/O for the
   API payloads (KV, locks/semaphores/RW, rate limiting, scheduling, elections,
   discovery, sync policies/events, common envelopes). The generator emits
   idiomatic types and validators per language.
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

The JSON-Schema-to-types organization was informed by
`ORESoftware/k8s-libs-and-shared-defs`, but this repository is completely
independent: it imports no schema, generator, package, runtime, or build artifact
from that project.

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
│   ├── discovery.schema.json   # ServiceRegister/Instance/List
│   └── sync.schema.json        # sync envelopes, write policy, replica metadata
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
    ├── rust/{Cargo.toml,src/*.rs}           # serde payload types + JSON Schema validation
    ├── rust-wasm/{Cargo.toml,src/lib.rs}   # Rust compiled to WebAssembly (tsify boundary)
    ├── rust-db/{Cargo.toml,src/*.rs}       # sqlx::FromRow row types, one module per plane
    ├── typescript/{index.ts,zod.ts,db/*.ts} # payload types + Zod facade + DB row types
    ├── dart/{lib,test}                     # typed payloads + canonical validator
    ├── python/fiducia_interfaces.py
    └── go/interfaces.go
```

## Generator

```sh
node src/generate.mjs          # JSON Schema → generated/<lang>/...
node src/generate-db.mjs       # SQL DDL → generated/rust-db + generated/typescript/db
node src/generate.mjs --check  # CI: fail if generated files are stale
npm test                      # drift, validator parity, generated crates/types
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
sanitizes doc comments, escapes Rust keyword fields (`r#type`) and Python
keyword fields (`from_`, documented with its JSON name), and emits typed enums
for string `enum`s (Rust enum · TS union · Python `Literal` · Go
string + allowed-values doc). Explicit JSON `null` unions remain nullable in
every generated language instead of degrading to an untyped value. CI runs the
self-tests and `--check` on every push. It also exercises the same canonical
valid/invalid samples through the TypeScript/Zod, Rust, and Dart validators.

The generated TypeScript Zod facade delegates exact Draft 2020-12 evaluation to
AJV 2020 and presents the result as typed `ZodType<T>` schemas. It does not
depend on Zod's experimental JSON Schema importer. Rust validates untrusted
values with `jsonschema` and external reference resolution disabled. Dart embeds
the canonical bundle and uses a generated validator for every JSON Schema
keyword present in these schemas; it does not claim that the third-party
Draft-7-only `json_schema` package provides Draft 2020-12 parity.

The boundary is deliberate: validate untrusted REST, realtime, queue, and stored
JSON blobs against the JSON Schema artifacts at I/O ingress and egress. Use
`generated/rust-db` and `generated/typescript/db` for trusted ORM/database row
shapes generated from SQL. A database row and a public wire projection are not
implicitly interchangeable.

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
uses pinned Node and Dart SDKs, copies `package-lock.json`, the root workspace
`Cargo.lock`, and every standalone generated Rust dependency lock, installs npm
dependencies with `npm ci --ignore-scripts`, and relies on the `--locked` Cargo
commands in `npm test`. Build and test execution run as numeric UID/GID
`65532:65532`; the image exposes no port and starts no daemon. TypeScript comes
from the npm lockfile rather than a mutable global install.

## Languages

First-class today: **Rust**, **Rust→WebAssembly**, **TypeScript/Zod**, **Dart**,
**Python**, and **Go**. Adding a language is one render function in
`src/generate.mjs` (see the `EMITTERS` map).

The `rust-wasm` target is the same serde types as `rust`, plus
[`tsify`](https://github.com/madonoharu/tsify) + `wasm-bindgen` so payloads cross
the JS/wasm boundary as real objects (and a `.d.ts` is emitted). It is a separate
crate so the browser target does not inherit the native validation runtime.
Build it with:

```sh
wasm-pack build generated/rust-wasm --target web -- --locked
# or: cargo build --locked --manifest-path generated/rust-wasm/Cargo.toml --target wasm32-unknown-unknown
```

The roadmap is the rest of the **client languages** in
[`fiducia-clients`](https://github.com/fiducia-cloud/fiducia-clients), so each
HTTP client ships typed payloads generated from this single source.
(Shell/PowerShell are untyped and consume the JSON directly.)

## Use as a dependency

```toml
# Rust (generated crate)
fiducia-interfaces = { git = "https://github.com/fiducia-cloud/fiducia-interfaces", tag = "v0.1.0" }
```
```ts
// TypeScript
import type { LockGrant } from "@fiducia/interfaces/typescript";
import { SyncWritePolicySchema } from "@fiducia/interfaces/zod";
```

```dart
// Dart (generated package)
import 'package:fiducia_interfaces/fiducia_interfaces.dart';
```

## Consumers

Servers (`fiducia-node`/`auth`/...) and clients in `fiducia-clients` consume
these request/response types and validators. The customer portal
(`fiducia-customer.rs`) uses `sql/customer.sql` and the admin dashboard
(`fiducia-admin.rs`) uses `sql/admin.sql`, each against its own isolated Postgres
instance.

For customer/admin sync, Supabase is the authoritative Postgres service and
Realtime is a transport for commits from that same authority. A separate
bidirectional Postgres writer is unsupported unless it implements an explicitly
causal multi-primary protocol with origin identity, globally unique change ids,
causal revisions, tombstones, and a declared conflict policy. `created_at` is
preserved, `updated_at` advances strictly, and replica-local `synced_at` metadata
must never be used as the conflict clock; the per-row `version` is authoritative.

## Lock, semaphore, and file-lease wire contract

`schema/locks.schema.json` describes the operation output nested inside the
node's normal propose envelope. Lock and semaphore acquire requests always carry
a caller-generated, non-empty `holder`; there is no anonymous wire identity.
Optional `ttl_ms` and `wait_timeout_ms` values are positive and capped at 24
hours. The former bounds a granted lease, while the latter independently bounds
a durable `wait:true` queue entry. A queued acquire response includes the
replicated absolute `wait_expires_ms`; retrying the same holder/resource identity
does not extend that deadline.

New clients also send a cryptographically random `request_id` for each logical
acquisition attempt. They reuse that ID for every retry and for the matching
cancel, then generate a different ID for a later attempt—even when the holder
and resource are unchanged. This lets a cancel committed before an ambiguous
acquire durably suppress that one late request without creating a long-lived
tombstone for the holder. Omitting `request_id` preserves the legacy
holder/resource cancellation contract during rolling upgrades. Request IDs are
1–128 non-control characters and cannot be blank.
The replicated tombstone table is deliberately bounded. If it is full, cancel
returns `cancelled:false`, `acquired:false`, and
`reason:"cancellation_capacity"`; a caller must surface that failure and must
not assume its ambiguous acquire was suppressed.

The complete mutating lifecycle is explicit and token-bound:

| Primitive | Acquire | Renew | Release | Cancel queued waiter |
| --- | --- | --- | --- | --- |
| union lock | `POST /v1/locks/acquire` | `POST /v1/locks/renew` | `POST /v1/locks/release` | `POST /v1/locks/cancel` |
| semaphore | `POST /v1/semaphores/acquire` | `POST /v1/semaphores/renew` | `POST /v1/semaphores/release` | `POST /v1/semaphores/cancel` |

Renew and release require the original `holder` plus the positive
`fencing_token`; lock renewal also requires the exact canonical key set. Cancel
is idempotent and never silently releases an active grant. If cancellation races
queue promotion, its response has `acquired:true` plus `fencing_token` and
`lease_expires_ms`, so an aborting client can immediately issue the corresponding
release.

Fencing tokens are JSON integers in the range 1 through
`9007199254740991` (JavaScript's maximum safe integer). This keeps browser
authorization exact; implementations must refuse overflow rather than round a
token.

Reissuing acquire with the exact same holder/resource identity is idempotent: it
returns the existing fencing token and expiry with `renewed:false`, but it cannot
extend authority using only the unfenced holder name. Only the dedicated
token-bound renew operation extends a live lease. A semaphore's `limit` is fixed
when that key is first created; a later acquire with a different limit returns
`reason:"limit_mismatch"` and the requested/current limits without changing
capacity.

File-lease repository identity is canonical GitHub `owner/repo` (for example,
`fiducia-cloud/fiducia-node.rs`). A control-plane migration path may accept one
legacy bare repository name while old callers roll forward, but new clients and
stored/generated payloads must emit `owner/repo`; nested or traversal-shaped
repository values are invalid.
`FileLeaseRenewRequest` carries the complete repository/path union, `agent_key`,
current fencing token, and bounded renewal TTL so a partial or stale lease cannot
be extended accidentally.

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
