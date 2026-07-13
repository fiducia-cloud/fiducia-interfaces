# sql — canonical Postgres schemas

The authoritative Postgres DDL, split **by plane** — each plane is owned by one service
and (for customer/admin) runs on its own isolated Postgres instance as a security
boundary. `src/generate-db.mjs` derives the row types in `generated/rust-db` and
`generated/typescript/db` from these files. Services own no migrations; operators apply
these reviewed contracts.

- `customer.sql` — customer portal plane (`fiducia-backend.rs`): orgs, projects, users,
  API keys, mTLS identities, preferences, sessions, audit.
- `admin.sql` — admin/control plane (`fiducia-admin.rs`): operators, infra-op
  audit, admin audit, and the request-fingerprint-bound sync idempotency ledger.
- `ai_agent_control_plane.sql` — single-tenant AI Agent control plane (rich customer data).
- `ai_agent_bridge.sql` — AI agent conversation bridge.
- `operations_control_plane.sql` — single-tenant Operations control plane (workflow history + state).

Coordination data (locks/KV/rate limits/schedules/elections/etc.) does **not** live
here — that is per-node Raft state. This SQL is only the relational business data.
