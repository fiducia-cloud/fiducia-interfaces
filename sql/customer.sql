-- Canonical Postgres schema for fiducia.cloud's CUSTOMER plane.
--
-- Isolation: this DB is owned exclusively by the customer portal backend
-- (fiducia-backend.rs). The admin plane (fiducia-admin.rs) has its OWN separate
-- Postgres instance (sql/admin.sql) and never connects here. See
-- docs/repo-boundaries.md — admin ⟂ customer is a security boundary.
--
-- Coordination data (locks/KV/rate limits/schedules/elections/discovery) does
-- NOT live here — it lives in the per-node Raft state machine. This DB holds the
-- customer's self-service relational data: orgs, projects, team, API keys, mTLS
-- identities, preferences, trusted sessions, and customer-scoped audit.
--
-- SYNC CONTRACT (local-first): every optimistically-editable table carries
--   updated_at timestamptz  -- server commit time
--   version    bigint       -- monotonic per-row counter (last-writer-wins tiebreak)
-- and a BEFORE UPDATE trigger (bump_row_version) that advances both on every
-- write. The sync engine ships {table, op, id, version, row} change events over
-- Supabase realtime OR the backend WS; clients reconcile IndexedDB against version.

-- Shared trigger: bump version + updated_at on every UPDATE of a synced row.
create or replace function bump_row_version() returns trigger as $$
begin
  new.version := old.version + 1;
  new.updated_at := now();
  return new;
end;
$$ language plpgsql;

create table if not exists orgs (
  id uuid primary key default gen_random_uuid(),
  slug varchar(120) not null,
  name varchar(200) not null,
  created_at timestamptz default now() not null,
  updated_at timestamptz default now() not null,
  version bigint default 1 not null,
  constraint orgs_slug_format_chk check (slug ~ '^[a-z0-9][a-z0-9-]{1,118}[a-z0-9]$')
);
create unique index if not exists orgs_slug_uq on orgs (slug);
drop trigger if exists orgs_bump on orgs;
create trigger orgs_bump before update on orgs for each row execute function bump_row_version();

create table if not exists projects (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs (id) on delete cascade,
  slug varchar(120) not null,
  name varchar(200) not null,
  created_at timestamptz default now() not null,
  updated_at timestamptz default now() not null,
  version bigint default 1 not null,
  constraint projects_slug_format_chk check (slug ~ '^[a-z0-9][a-z0-9-]{1,118}[a-z0-9]$')
);
create unique index if not exists projects_org_slug_uq on projects (org_id, slug);
create index if not exists projects_org_idx on projects (org_id);
drop trigger if exists projects_bump on projects;
create trigger projects_bump before update on projects for each row execute function bump_row_version();

-- Mirrors the Supabase auth user (source of truth is Supabase). We keep a thin
-- local row to join org membership + audit against.
create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  supabase_user_id uuid not null,
  email varchar(320) not null,
  created_at timestamptz default now() not null
);
create unique index if not exists users_supabase_uq on users (supabase_user_id);

create table if not exists org_members (
  org_id uuid not null references orgs (id) on delete cascade,
  user_id uuid not null references users (id) on delete cascade,
  role varchar(32) default 'member' not null,
  created_at timestamptz default now() not null,
  primary key (org_id, user_id),
  constraint org_members_role_chk check (role in ('owner', 'admin', 'member'))
);
create index if not exists org_members_user_idx on org_members (user_id);

create table if not exists project_members (
  project_id uuid not null references projects (id) on delete cascade,
  user_id uuid not null references users (id) on delete cascade,
  role varchar(32) default 'viewer' not null,
  created_at timestamptz default now() not null,
  primary key (project_id, user_id),
  constraint project_members_role_chk check (role in ('admin', 'operator', 'viewer'))
);
create index if not exists project_members_user_idx on project_members (user_id);

-- API keys: only the hash of the secret is ever stored. A null project_id means
-- the key is org-scoped; otherwise permissions are constrained to one project.
create table if not exists api_keys (
  id uuid primary key default gen_random_uuid(),
  key_id varchar(64) not null,
  org_id uuid not null references orgs (id) on delete cascade,
  project_id uuid references projects (id) on delete cascade,
  created_by_user_id uuid references users (id) on delete set null,
  name varchar(200) not null,
  secret_hash varchar(255) not null,
  scopes jsonb default '[]'::jsonb not null,
  env varchar(16) default 'live' not null,
  mtls_required boolean default false not null,
  revoked boolean default false not null,
  created_at timestamptz default now() not null,
  updated_at timestamptz default now() not null,
  version bigint default 1 not null,
  last_used_at timestamptz,
  expires_at timestamptz,
  constraint api_keys_env_chk check (env in ('live', 'test')),
  constraint api_keys_scopes_array_chk check (jsonb_typeof(scopes) = 'array')
);
create unique index if not exists api_keys_key_id_uq on api_keys (key_id);
create index if not exists api_keys_org_idx on api_keys (org_id) where revoked = false;
create index if not exists api_keys_project_idx on api_keys (project_id) where revoked = false;
drop trigger if exists api_keys_bump on api_keys;
create trigger api_keys_bump before update on api_keys for each row execute function bump_row_version();

create table if not exists mtls_client_certs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs (id) on delete cascade,
  project_id uuid references projects (id) on delete cascade,
  name varchar(200) not null,
  subject varchar(500) not null,
  sha256_fingerprint varchar(95) not null,
  not_before timestamptz,
  not_after timestamptz,
  revoked boolean default false not null,
  created_at timestamptz default now() not null,
  updated_at timestamptz default now() not null,
  version bigint default 1 not null
);
create unique index if not exists mtls_client_certs_fingerprint_uq
  on mtls_client_certs (sha256_fingerprint);
create index if not exists mtls_client_certs_org_idx
  on mtls_client_certs (org_id) where revoked = false;
drop trigger if exists mtls_client_certs_bump on mtls_client_certs;
create trigger mtls_client_certs_bump before update on mtls_client_certs for each row execute function bump_row_version();

-- Per-user dashboard preferences (backs GET/PUT /api/customer/preferences).
create table if not exists customer_preferences (
  user_id uuid primary key references users (id) on delete cascade,
  density varchar(16) default 'comfortable' not null,
  timezone varchar(64) default 'UTC' not null,
  region varchar(16) default 'auto' not null,
  notify_key_rotation boolean default true not null,
  notify_lock_contention boolean default true not null,
  notify_mfa boolean default true not null,
  updated_at timestamptz default now() not null,
  version bigint default 1 not null,
  constraint customer_preferences_density_chk check (density in ('comfortable', 'compact'))
);
drop trigger if exists customer_preferences_bump on customer_preferences;
create trigger customer_preferences_bump before update on customer_preferences for each row execute function bump_row_version();

-- Trusted sessions shown on the customer Security page (list + revoke).
create table if not exists customer_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users (id) on delete cascade,
  device varchar(200) not null,
  location varchar(200),
  last_seen timestamptz default now() not null,
  status varchar(16) default 'active' not null,
  updated_at timestamptz default now() not null,
  version bigint default 1 not null,
  constraint customer_sessions_status_chk check (status in ('active', 'verified', 'revoked'))
);
create index if not exists customer_sessions_user_idx on customer_sessions (user_id);
drop trigger if exists customer_sessions_bump on customer_sessions;
create trigger customer_sessions_bump before update on customer_sessions for each row execute function bump_row_version();

-- Customer-scoped audit (append-only; no version/trigger).
create table if not exists audit_log (
  id uuid primary key default gen_random_uuid(),
  org_id uuid references orgs (id) on delete set null,
  project_id uuid references projects (id) on delete set null,
  actor_user_id uuid references users (id) on delete set null,
  actor_key_id uuid references api_keys (id) on delete set null,
  actor varchar(320),
  action varchar(120) not null,
  target varchar(320),
  request_id varchar(120),
  source_ip inet,
  user_agent varchar(500),
  meta jsonb default '{}'::jsonb not null,
  created_at timestamptz default now() not null,
  retention_expires_at timestamptz,
  constraint audit_meta_object_chk check (jsonb_typeof(meta) = 'object')
);
create index if not exists audit_log_org_created_idx on audit_log (org_id, created_at desc);
create index if not exists audit_log_project_created_idx on audit_log (project_id, created_at desc);
create index if not exists audit_log_actor_user_created_idx on audit_log (actor_user_id, created_at desc);
create index if not exists audit_log_actor_key_created_idx on audit_log (actor_key_id, created_at desc);
