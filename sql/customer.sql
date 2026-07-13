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
-- write. The sync engine consumes only explicitly published, non-secret rows.
-- API-key rows are never published because they contain verifier hashes; customer
-- key state must be read through the authenticated backend's sanitized API.

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
  require_idempotency boolean default true not null,
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
alter table api_keys
  add column if not exists require_idempotency boolean not null default true;
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

-- ============================================================================
-- SUPABASE REALTIME + ROW-LEVEL SECURITY (local-first sync, defense-in-depth)
-- ----------------------------------------------------------------------------
-- Idempotent, and a NO-OP on a non-Supabase Postgres (each block guards on the
-- supabase_realtime publication / auth.uid() existing). Consumed by @fiducia/sync.
--
-- IMPORTANT: the customer backend (fiducia-backend.rs) MUST connect as a role
-- that BYPASSES RLS — the Supabase service role, the table owner, or a role with
-- BYPASSRLS. It does (service-role DATABASE_URL). These policies therefore
-- constrain ONLY the realtime consumer (the `authenticated` role using a user
-- JWT), so realtime CDC can never leak one tenant's rows to another. A plain
-- non-owner app role would be blocked by RLS — verify the backend's DB role
-- before applying to a fresh environment.
-- ============================================================================

-- (1) Deletes must carry the full OLD row (incl. version) over logical
-- replication; without this, Supabase DELETE events arrive with only the primary
-- key and the sync engine cannot order them. Safe on any Postgres.
alter table orgs                 replica identity full;
alter table projects             replica identity full;
alter table api_keys             replica identity full;
alter table mtls_client_certs    replica identity full;
alter table customer_preferences replica identity full;
alter table customer_sessions    replica identity full;

-- (2) Register only tables whose complete row is safe for the authorized member.
-- `api_keys` is deliberately excluded: PostgreSQL publications are row-oriented,
-- and RLS cannot hide its `secret_hash` column. Remove it from older deployments
-- that published it before this boundary was made explicit.
do $$
declare t text;
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach t in array array[
      'orgs','projects','mtls_client_certs','customer_preferences','customer_sessions'
    ] loop
      if not exists (
        select 1 from pg_publication_tables
        where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
      ) then
        execute format('alter publication supabase_realtime add table public.%I', t);
      end if;
    end loop;

    if exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = 'api_keys'
    ) then
      alter publication supabase_realtime drop table public.api_keys;
    end if;
  end if;
end $$;

-- (3) RLS tenant policies — Supabase only (guarded on auth.uid()). A member of an
-- org sees that org's rows; a user sees their own preferences/sessions. Realtime
-- also respects the client-side postgres_changes `filter` we pass, but RLS is the
-- authoritative boundary.
do $$
begin
  if to_regprocedure('auth.uid()') is null then
    return; -- not a Supabase DB; realtime/RLS not applicable
  end if;

  -- Policy predicates must not grant browser roles direct access to membership
  -- tables. These narrowly scoped SECURITY DEFINER helpers run as the migration
  -- owner; pinning search_path prevents object-shadowing attacks.
  execute $fn$
    create or replace function public.fiducia_customer_is_org_member(target_org_id uuid)
    returns boolean
    language sql
    stable
    security definer
    set search_path = pg_catalog, public
    as $body$
      select exists (
        select 1
        from public.org_members m
        join public.users u on u.id = m.user_id
        where m.org_id = target_org_id
          and u.supabase_user_id = auth.uid()
      )
    $body$
  $fn$;
  execute $fn$
    create or replace function public.fiducia_customer_is_self(target_user_id uuid)
    returns boolean
    language sql
    stable
    security definer
    set search_path = pg_catalog, public
    as $body$
      select exists (
        select 1 from public.users u
        where u.id = target_user_id and u.supabase_user_id = auth.uid()
      )
    $body$
  $fn$;
  execute 'revoke all on function public.fiducia_customer_is_org_member(uuid) from public';
  execute 'revoke all on function public.fiducia_customer_is_self(uuid) from public';
  execute 'grant execute on function public.fiducia_customer_is_org_member(uuid) to authenticated';
  execute 'grant execute on function public.fiducia_customer_is_self(uuid) to authenticated';

  execute 'alter table orgs enable row level security';
  execute 'drop policy if exists orgs_member_read on orgs';
  execute $p$
    create policy orgs_member_read on orgs for select to authenticated using (
      public.fiducia_customer_is_org_member(orgs.id))$p$;

  execute 'alter table projects enable row level security';
  execute 'drop policy if exists projects_member_read on projects';
  execute $p$
    create policy projects_member_read on projects for select to authenticated using (
      public.fiducia_customer_is_org_member(projects.org_id))$p$;

  execute 'alter table api_keys enable row level security';
  execute 'drop policy if exists api_keys_member_read on api_keys';

  execute 'alter table mtls_client_certs enable row level security';
  execute 'drop policy if exists mtls_certs_member_read on mtls_client_certs';
  execute $p$
    create policy mtls_certs_member_read on mtls_client_certs for select to authenticated using (
      public.fiducia_customer_is_org_member(mtls_client_certs.org_id))$p$;

  execute 'alter table customer_preferences enable row level security';
  execute 'drop policy if exists customer_preferences_owner_read on customer_preferences';
  execute $p$
    create policy customer_preferences_owner_read on customer_preferences for select to authenticated using (
      public.fiducia_customer_is_self(customer_preferences.user_id))$p$;

  execute 'alter table customer_sessions enable row level security';
  execute 'drop policy if exists customer_sessions_owner_read on customer_sessions';
  execute $p$
    create policy customer_sessions_owner_read on customer_sessions for select to authenticated using (
      public.fiducia_customer_is_self(customer_sessions.user_id))$p$;
end $$;

-- (4) Public is Supabase's API-exposed schema. Backend-only relation tables and
-- ledgers therefore get both RLS-with-no-client-policy and explicit privilege
-- revocation. The guarded statements keep this portable to plain Postgres where
-- Supabase's roles do not exist. The backend must use BYPASSRLS as required above.
alter table users enable row level security;
alter table org_members enable row level security;
alter table project_members enable row level security;
alter table audit_log enable row level security;

do $$
declare role_name text;
begin
  foreach role_name in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = role_name) then
      execute format('revoke all privileges on table public.users from %I', role_name);
      execute format('revoke all privileges on table public.org_members from %I', role_name);
      execute format('revoke all privileges on table public.project_members from %I', role_name);
      execute format('revoke all privileges on table public.audit_log from %I', role_name);
      execute format('revoke all privileges on table public.api_keys from %I', role_name);
    end if;
  end loop;
end $$;

-- ============================================================================
-- SYNC DURABILITY: idempotency ledger + catch-up (version) indexes
-- ----------------------------------------------------------------------------
-- Server-internal (NOT synced, NOT realtime): the backend records the committed
-- version it returned for each client Idempotency-Key here, so a retried sync
-- write replays the SAME ack across process restarts instead of re-running the
-- UPDATE (whose trigger would re-bump version). `committed_version` is null while
-- a claim is in-flight. Prune old keys with the created_at index (e.g. a daily
-- `delete from sync_idempotency_keys where created_at < now() - interval '2 days'`).
create table if not exists sync_idempotency_keys (
  key text primary key,
  committed_version bigint,
  created_at timestamptz default now() not null
);
create index if not exists sync_idempotency_created_idx on sync_idempotency_keys (created_at);
alter table sync_idempotency_keys enable row level security;

do $$
declare role_name text;
begin
  foreach role_name in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = role_name) then
      execute format(
        'revoke all privileges on table public.sync_idempotency_keys from %I',
        role_name
      );
    end if;
  end loop;
end $$;

-- Catch-up hydration reads each synced table by monotonic `version`
-- (`where version > $cursor order by version`), tenant-scoped where a tenant
-- column exists. These indexes make that an index range scan, not a seq scan.
create index if not exists orgs_version_idx                 on orgs (version);
create index if not exists projects_org_version_idx         on projects (org_id, version);
create index if not exists api_keys_org_version_idx         on api_keys (org_id, version);
create index if not exists mtls_client_certs_org_version_idx on mtls_client_certs (org_id, version);
create index if not exists customer_preferences_user_version_idx on customer_preferences (user_id, version);
create index if not exists customer_sessions_user_version_idx    on customer_sessions (user_id, version);
