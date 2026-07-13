# sql — canonical Postgres schemas

The authoritative Postgres DDL, split **by plane** — each plane is owned by one service
and (for customer/admin) runs on its own isolated Postgres instance as a security
boundary. `src/generate-db.mjs` derives the row types in `generated/rust-db` and
`generated/typescript/db` from these files. Services own no migrations; operators apply
these reviewed contracts.

- `customer.sql` — customer portal plane (`fiducia-customer.rs`): orgs, projects, users,
  API keys, mTLS identities, preferences, sessions, audit, request-bound sync
  idempotency, and tenant/user-scoped delete tombstones.
- `admin.sql` — admin/control plane (`fiducia-admin.rs`): operators, infra-op
  audit, admin audit, request-bound sync idempotency, and delete tombstones.
- `ai_agent_control_plane.sql` — single-tenant AI Agent control plane (rich customer data).
- `ai_agent_bridge.sql` — AI agent conversation bridge.
- `operations_control_plane.sql` — single-tenant Operations control plane (workflow history + state).

Coordination data (locks/KV/rate limits/schedules/elections/etc.) does **not** live
here — that is per-node Raft state. This SQL is only the relational business data.

For customer/admin local-first tables, `version` is a per-row CAS counter while
`sync_sequence` is allocated through a transactional singleton clock. Do not
replace it with `nextval()`: a non-transactional sequence can expose N+1 before N
commits and permanently skip the late row. Catch-up must merge live rows and
`sync_tombstones`, order strictly by `sync_sequence`, and advance only through
the last returned item. A statement trigger locks the clock before target rows to
avoid lock-order inversions in multi-row transactions; unsynced parent deletes
that cascade into synced rows carry the same guard. Writers must not acquire
synced-row locks manually before issuing the guarded mutation. Apply each canonical
schema in one migration transaction.
