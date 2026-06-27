-- Canonical Postgres schema for fiducia.cloud's control/business plane
-- (fiducia-auth + dashboard). This is the desired-state contract; generate and
-- review a diff before applying — never apply directly to a shared database.
--
-- NOTE: coordination data (locks/KV/elections/discovery) does NOT live here —
-- it lives in the per-node Raft state machine. This DB is only for relational
-- business data: orgs, users, API keys, audit.

create table if not exists orgs (
  id uuid primary key default gen_random_uuid(),
  slug varchar(120) not null,
  name varchar(200) not null,
  created_at timestamptz default now() not null,
  updated_at timestamptz default now() not null,
  constraint orgs_slug_format_chk check (slug ~ '^[a-z0-9][a-z0-9-]{1,118}[a-z0-9]$')
);
create unique index if not exists orgs_slug_uq on orgs (slug);

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

-- API keys: only the hash of the secret is ever stored.
create table if not exists api_keys (
  id uuid primary key default gen_random_uuid(),
  key_id varchar(64) not null,
  org_id uuid not null references orgs (id) on delete cascade,
  name varchar(200) not null,
  secret_hash varchar(255) not null,
  scopes jsonb default '[]'::jsonb not null,
  env varchar(16) default 'live' not null,
  revoked boolean default false not null,
  created_at timestamptz default now() not null,
  last_used_at timestamptz,
  constraint api_keys_env_chk check (env in ('live', 'test')),
  constraint api_keys_scopes_array_chk check (jsonb_typeof(scopes) = 'array')
);
create unique index if not exists api_keys_key_id_uq on api_keys (key_id);
create index if not exists api_keys_org_idx on api_keys (org_id) where revoked = false;

create table if not exists audit_log (
  id uuid primary key default gen_random_uuid(),
  org_id uuid references orgs (id) on delete set null,
  actor varchar(320),
  action varchar(120) not null,
  target varchar(320),
  meta jsonb default '{}'::jsonb not null,
  created_at timestamptz default now() not null,
  constraint audit_meta_object_chk check (jsonb_typeof(meta) = 'object')
);
create index if not exists audit_log_org_created_idx on audit_log (org_id, created_at desc);
