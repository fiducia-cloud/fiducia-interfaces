-- Canonical Postgres schema for fiducia.cloud's CUSTOMER plane.
--
-- Isolation: this DB is owned exclusively by the customer portal backend
-- (fiducia-customer.rs). The admin plane (fiducia-admin.rs) has its OWN separate
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
--   sync_sequence bigint    -- global, commit-ordered catch-up cursor
-- and a trigger (bump_row_version) that stamps inserts and advances all three
-- fields on updates. `version` is never a table-wide cursor. The sync engine
-- consumes only explicitly published, non-secret rows.
-- Transport adapters emit those rows as {table, op, id, version, row} events.
-- API-key rows are never published because they contain verifier hashes; customer
-- key state must be read through the authenticated backend's sanitized API.

-- A transactional singleton counter avoids the commit-order race of PostgreSQL
-- sequences: allocating N holds this row lock until commit, so no visible N+1 can
-- overtake an uncommitted N and cause a cursor to skip it forever.
create table if not exists sync_clock (
  singleton boolean primary key default true,
  last_sequence bigint default 0 not null,
  constraint sync_clock_singleton_chk check (singleton),
  constraint sync_clock_nonnegative_chk check (last_sequence >= 0)
);
insert into sync_clock (singleton, last_sequence)
values (true, 0)
on conflict (singleton) do nothing;

-- Latest delete per table/row, scoped so a BYPASSRLS backend can still construct
-- tenant-safe catch-up queries. Tombstones are retained until an operator-defined
-- full-snapshot watermark proves no supported client can still need them.
create table if not exists sync_tombstones (
  sequence bigint primary key,
  table_name text not null,
  row_id text not null,
  tenant_id uuid,
  owner_user_id uuid,
  row_version bigint not null,
  deleted_at timestamptz default now() not null,
  unique (table_name, row_id),
  constraint sync_tombstones_sequence_chk check (sequence > 0),
  constraint sync_tombstones_version_chk check (row_version > 0),
  constraint sync_tombstones_scope_chk check (tenant_id is not null or owner_user_id is not null)
);
create index if not exists sync_tombstones_tenant_sequence_idx
  on sync_tombstones (table_name, tenant_id, sequence) where tenant_id is not null;
create index if not exists sync_tombstones_user_sequence_idx
  on sync_tombstones (table_name, owner_user_id, sequence) where owner_user_id is not null;

create or replace function allocate_sync_sequence() returns bigint as $$
declare allocated bigint;
begin
  update public.sync_clock
     set last_sequence = last_sequence + 1
   where singleton = true
  returning last_sequence into allocated;
  if allocated is null then
    raise exception 'sync clock singleton is missing';
  end if;
  return allocated;
end;
$$ language plpgsql security definer set search_path = pg_catalog, public;

-- Lock the plane clock at statement start, before target-row locks. This keeps
-- multi-row/multi-table writes from deadlocking in the row trigger while retaining
-- commit-ordered sequence allocation.
create or replace function lock_sync_clock() returns trigger as $$
begin
  perform 1 from public.sync_clock where singleton = true for update;
  if not found then
    raise exception 'sync clock singleton is missing';
  end if;
  return null;
end;
$$ language plpgsql security definer set search_path = pg_catalog, public;

-- Shared trigger: stamp the global cursor on INSERT; bump version, timestamp, and
-- cursor on every UPDATE. Caller-supplied sync_sequence values are overwritten.
create or replace function bump_row_version() returns trigger as $$
begin
  if tg_op = 'UPDATE' then
    new.version := old.version + 1;
  end if;
  new.updated_at := now();
  new.sync_sequence := public.allocate_sync_sequence();
  return new;
end;
$$ language plpgsql security definer set search_path = pg_catalog, public;

-- Trigger arguments: primary-key column, tenant column (or ''), owner-user column
-- (or ''). Extracting through to_jsonb keeps this one function usable for the
-- customer_preferences user_id primary key and ordinary id primary keys.
create or replace function record_sync_tombstone() returns trigger as $$
declare
  allocated bigint;
  deleted_row jsonb;
  deleted_row_id text;
  deleted_tenant_id uuid;
  deleted_owner_user_id uuid;
begin
  if tg_nargs != 3 then
    raise exception 'record_sync_tombstone requires pk, tenant, and user column arguments';
  end if;
  deleted_row := to_jsonb(old);
  deleted_row_id := deleted_row ->> tg_argv[0];
  if deleted_row_id is null then
    raise exception 'sync tombstone primary key % is missing', tg_argv[0];
  end if;
  if tg_argv[1] <> '' then
    deleted_tenant_id := (deleted_row ->> tg_argv[1])::uuid;
  end if;
  if tg_argv[2] <> '' then
    deleted_owner_user_id := (deleted_row ->> tg_argv[2])::uuid;
  end if;

  allocated := public.allocate_sync_sequence();
  insert into public.sync_tombstones
    (sequence, table_name, row_id, tenant_id, owner_user_id, row_version, deleted_at)
  values
    (allocated, tg_table_name, deleted_row_id, deleted_tenant_id,
     deleted_owner_user_id, old.version + 1, now())
  on conflict (table_name, row_id) do update
    set sequence = excluded.sequence,
        tenant_id = excluded.tenant_id,
        owner_user_id = excluded.owner_user_id,
        row_version = excluded.row_version,
        deleted_at = excluded.deleted_at;
  return old;
end;
$$ language plpgsql security definer set search_path = pg_catalog, public;

revoke all on function public.allocate_sync_sequence() from public;
revoke all on function public.lock_sync_clock() from public;
revoke all on function public.bump_row_version() from public;
revoke all on function public.record_sync_tombstone() from public;

create table if not exists orgs (
  id uuid primary key default gen_random_uuid(),
  slug varchar(120) not null,
  name varchar(200) not null,
  created_at timestamptz default now() not null,
  updated_at timestamptz default now() not null,
  version bigint default 1 not null,
  sync_sequence bigint not null,
  constraint orgs_slug_format_chk check (slug ~ '^[a-z0-9][a-z0-9-]{1,118}[a-z0-9]$')
);
alter table orgs add column if not exists sync_sequence bigint;
create unique index if not exists orgs_slug_uq on orgs (slug);
drop trigger if exists orgs_bump on orgs;
update orgs set sync_sequence = public.allocate_sync_sequence()
 where sync_sequence is null or sync_sequence <= 0;
alter table orgs alter column sync_sequence set not null;
alter table orgs alter column sync_sequence drop default;
drop trigger if exists orgs_sync_clock_guard on orgs;
create trigger orgs_sync_clock_guard before insert or update or delete on orgs for each statement execute function lock_sync_clock();
create trigger orgs_bump before insert or update on orgs for each row execute function bump_row_version();
drop trigger if exists orgs_tombstone on orgs;
create trigger orgs_tombstone after delete on orgs for each row execute function record_sync_tombstone('id', 'id', '');

create table if not exists projects (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs (id) on delete cascade,
  slug varchar(120) not null,
  name varchar(200) not null,
  created_at timestamptz default now() not null,
  updated_at timestamptz default now() not null,
  version bigint default 1 not null,
  sync_sequence bigint not null,
  constraint projects_slug_format_chk check (slug ~ '^[a-z0-9][a-z0-9-]{1,118}[a-z0-9]$')
);
alter table projects add column if not exists sync_sequence bigint;
create unique index if not exists projects_org_slug_uq on projects (org_id, slug);
create index if not exists projects_org_idx on projects (org_id);
drop trigger if exists projects_bump on projects;
update projects set sync_sequence = public.allocate_sync_sequence()
 where sync_sequence is null or sync_sequence <= 0;
alter table projects alter column sync_sequence set not null;
alter table projects alter column sync_sequence drop default;
drop trigger if exists projects_sync_clock_guard on projects;
create trigger projects_sync_clock_guard before insert or update or delete on projects for each statement execute function lock_sync_clock();
create trigger projects_bump before insert or update on projects for each row execute function bump_row_version();
drop trigger if exists projects_tombstone on projects;
create trigger projects_tombstone after delete on projects for each row execute function record_sync_tombstone('id', 'org_id', '');

-- Mirrors the Supabase auth user (source of truth is Supabase). We keep a thin
-- local row to join org membership + audit against.
create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  supabase_user_id uuid not null,
  email varchar(320) not null,
  created_at timestamptz default now() not null
);
create unique index if not exists users_supabase_uq on users (supabase_user_id);
-- A user row is not itself part of the sync feed, but deleting it cascades into
-- customer_preferences/customer_sessions and updates api_keys.created_by_user_id.
-- Lock before the parent row so those triggered synced writes retain the global
-- clock-before-data lock order.
drop trigger if exists users_sync_clock_guard on users;
create trigger users_sync_clock_guard before delete on users for each statement execute function lock_sync_clock();

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
  sync_sequence bigint not null,
  last_used_at timestamptz,
  expires_at timestamptz,
  constraint api_keys_env_chk check (env in ('live', 'test')),
  constraint api_keys_scopes_array_chk check (jsonb_typeof(scopes) = 'array')
);
alter table api_keys
  add column if not exists require_idempotency boolean not null default true;
alter table api_keys add column if not exists sync_sequence bigint;
create unique index if not exists api_keys_key_id_uq on api_keys (key_id);
create index if not exists api_keys_org_idx on api_keys (org_id) where revoked = false;
create index if not exists api_keys_project_idx on api_keys (project_id) where revoked = false;
drop trigger if exists api_keys_bump on api_keys;
update api_keys set sync_sequence = public.allocate_sync_sequence()
 where sync_sequence is null or sync_sequence <= 0;
alter table api_keys alter column sync_sequence set not null;
alter table api_keys alter column sync_sequence drop default;
drop trigger if exists api_keys_sync_clock_guard on api_keys;
create trigger api_keys_sync_clock_guard before insert or update or delete on api_keys for each statement execute function lock_sync_clock();
create trigger api_keys_bump before insert or update on api_keys for each row execute function bump_row_version();
drop trigger if exists api_keys_tombstone on api_keys;
create trigger api_keys_tombstone after delete on api_keys for each row execute function record_sync_tombstone('id', 'org_id', '');

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
  version bigint default 1 not null,
  sync_sequence bigint not null
);
alter table mtls_client_certs add column if not exists sync_sequence bigint;
create unique index if not exists mtls_client_certs_fingerprint_uq
  on mtls_client_certs (sha256_fingerprint);
create index if not exists mtls_client_certs_org_idx
  on mtls_client_certs (org_id) where revoked = false;
drop trigger if exists mtls_client_certs_bump on mtls_client_certs;
update mtls_client_certs set sync_sequence = public.allocate_sync_sequence()
 where sync_sequence is null or sync_sequence <= 0;
alter table mtls_client_certs alter column sync_sequence set not null;
alter table mtls_client_certs alter column sync_sequence drop default;
drop trigger if exists mtls_client_certs_sync_clock_guard on mtls_client_certs;
create trigger mtls_client_certs_sync_clock_guard before insert or update or delete on mtls_client_certs for each statement execute function lock_sync_clock();
create trigger mtls_client_certs_bump before insert or update on mtls_client_certs for each row execute function bump_row_version();
drop trigger if exists mtls_client_certs_tombstone on mtls_client_certs;
create trigger mtls_client_certs_tombstone after delete on mtls_client_certs for each row execute function record_sync_tombstone('id', 'org_id', '');

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
  sync_sequence bigint not null,
  constraint customer_preferences_density_chk check (density in ('comfortable', 'compact'))
);
alter table customer_preferences add column if not exists sync_sequence bigint;
drop trigger if exists customer_preferences_bump on customer_preferences;
update customer_preferences set sync_sequence = public.allocate_sync_sequence()
 where sync_sequence is null or sync_sequence <= 0;
alter table customer_preferences alter column sync_sequence set not null;
alter table customer_preferences alter column sync_sequence drop default;
drop trigger if exists customer_preferences_sync_clock_guard on customer_preferences;
create trigger customer_preferences_sync_clock_guard before insert or update or delete on customer_preferences for each statement execute function lock_sync_clock();
create trigger customer_preferences_bump before insert or update on customer_preferences for each row execute function bump_row_version();
drop trigger if exists customer_preferences_tombstone on customer_preferences;
create trigger customer_preferences_tombstone after delete on customer_preferences for each row execute function record_sync_tombstone('user_id', '', 'user_id');

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
  sync_sequence bigint not null,
  constraint customer_sessions_status_chk check (status in ('active', 'verified', 'revoked'))
);
alter table customer_sessions add column if not exists sync_sequence bigint;
create index if not exists customer_sessions_user_idx on customer_sessions (user_id);
drop trigger if exists customer_sessions_bump on customer_sessions;
update customer_sessions set sync_sequence = public.allocate_sync_sequence()
 where sync_sequence is null or sync_sequence <= 0;
alter table customer_sessions alter column sync_sequence set not null;
alter table customer_sessions alter column sync_sequence drop default;
drop trigger if exists customer_sessions_sync_clock_guard on customer_sessions;
create trigger customer_sessions_sync_clock_guard before insert or update or delete on customer_sessions for each statement execute function lock_sync_clock();
create trigger customer_sessions_bump before insert or update on customer_sessions for each row execute function bump_row_version();
drop trigger if exists customer_sessions_tombstone on customer_sessions;
create trigger customer_sessions_tombstone after delete on customer_sessions for each row execute function record_sync_tombstone('id', '', 'user_id');

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

-- In-product notifications for a signed-in user (key-rotation reminders, lock
-- contention alerts, MFA nudges, operator broadcasts). User-owned and part of
-- the local-first sync set so the portal hydrates and reconciles the unread
-- feed offline; `read_at` is the only client-editable field. Non-secret, so
-- rows are published to the sync engine. Delivery preferences live in
-- customer_preferences (notify_*); this table is the delivered instances.
create table if not exists customer_notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users (id) on delete cascade,
  org_id uuid references orgs (id) on delete set null,
  kind varchar(40) not null,
  severity varchar(16) default 'info' not null,
  title varchar(200) not null,
  body varchar(2000) default '' not null,
  link varchar(500),
  read_at timestamptz,
  created_at timestamptz default now() not null,
  updated_at timestamptz default now() not null,
  version bigint default 1 not null,
  sync_sequence bigint not null,
  constraint customer_notifications_severity_chk
    check (severity in ('info', 'success', 'warning', 'critical')),
  constraint customer_notifications_kind_chk
    check (kind ~ '^[a-z][a-z0-9_.]{1,38}[a-z0-9]$')
);
alter table customer_notifications add column if not exists sync_sequence bigint;
create index if not exists customer_notifications_user_created_idx
  on customer_notifications (user_id, created_at desc);
create index if not exists customer_notifications_user_unread_idx
  on customer_notifications (user_id) where read_at is null;
update customer_notifications set sync_sequence = public.allocate_sync_sequence()
 where sync_sequence is null or sync_sequence <= 0;
alter table customer_notifications alter column sync_sequence set not null;
alter table customer_notifications alter column sync_sequence drop default;
drop trigger if exists customer_notifications_sync_clock_guard on customer_notifications;
create trigger customer_notifications_sync_clock_guard before insert or update or delete on customer_notifications for each statement execute function lock_sync_clock();
drop trigger if exists customer_notifications_bump on customer_notifications;
create trigger customer_notifications_bump before insert or update on customer_notifications for each row execute function bump_row_version();
drop trigger if exists customer_notifications_tombstone on customer_notifications;
create trigger customer_notifications_tombstone after delete on customer_notifications for each row execute function record_sync_tombstone('id', '', 'user_id');

-- ============================================================================
-- SUPABASE REALTIME + ROW-LEVEL SECURITY (local-first sync, defense-in-depth)
-- ----------------------------------------------------------------------------
-- Idempotent, and a NO-OP on a non-Supabase Postgres (each block guards on the
-- supabase_realtime publication / auth.uid() existing). Consumed by @fiducia/sync.
--
-- IMPORTANT: the customer backend (fiducia-customer.rs) MUST connect as a role
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
alter table sync_clock enable row level security;
alter table sync_tombstones enable row level security;

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
      execute format('revoke all privileges on table public.sync_clock from %I', role_name);
      execute format('revoke all privileges on table public.sync_tombstones from %I', role_name);
      execute format('revoke all on function public.allocate_sync_sequence() from %I', role_name);
      execute format('revoke all on function public.lock_sync_clock() from %I', role_name);
      execute format('revoke all on function public.bump_row_version() from %I', role_name);
      execute format('revoke all on function public.record_sync_tombstone() from %I', role_name);
    end if;
  end loop;
end $$;

-- ============================================================================
-- SYNC DURABILITY: request-bound idempotency + global catch-up indexes
-- ----------------------------------------------------------------------------
-- Server-internal (NOT synced, NOT realtime). A writer MUST hash the authenticated
-- customer + tenant + table + row + operation + base version + canonical payload,
-- claim the key with that fingerprint in the SAME transaction as the mutation,
-- and record committed_version before commit. On conflict it may replay only when
-- fingerprints match and committed_version is non-null. A legacy NULL fingerprint,
-- a mismatch, or an uncommitted/null version MUST fail closed; callers mint a new
-- key. Prune only completed keys after the supported retry window.
create table if not exists sync_idempotency_keys (
  key text primary key,
  request_fingerprint varchar(64),
  committed_version bigint,
  created_at timestamptz default now() not null
);
-- Backward-compatible column addition deliberately leaves historical rows NULL:
-- their original request cannot be reconstructed, so customer writers must reject
-- them rather than replay an ack for an unrelated request.
alter table sync_idempotency_keys
  add column if not exists request_fingerprint varchar(64);
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'customer_sync_idempotency_request_fingerprint_chk'
      and conrelid = 'sync_idempotency_keys'::regclass
  ) then
    alter table sync_idempotency_keys
      add constraint customer_sync_idempotency_request_fingerprint_chk
      check (request_fingerprint is null or request_fingerprint ~ '^[0-9a-f]{64}$')
      not valid;
  end if;
end $$;
-- Preserve legacy NULL rows so writers can reject them explicitly, but prevent
-- every new or updated ledger row from omitting its semantic request binding.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'customer_sync_idempotency_request_fingerprint_required'
      and conrelid = 'sync_idempotency_keys'::regclass
  ) then
    alter table sync_idempotency_keys
      add constraint customer_sync_idempotency_request_fingerprint_required
      check (request_fingerprint is not null)
      not valid;
  end if;
end $$;
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

-- Catch-up merges current rows with scoped delete tombstones and orders by the
-- globally unique `sync_sequence`. Stable pages use `sequence > $cursor order by
-- sequence limit $page_size`; per-row `version` is only for CAS/reconciliation.
update public.sync_clock
   set last_sequence = greatest(
     last_sequence,
     coalesce((select max(sync_sequence) from public.orgs), 0),
     coalesce((select max(sync_sequence) from public.projects), 0),
     coalesce((select max(sync_sequence) from public.api_keys), 0),
     coalesce((select max(sync_sequence) from public.mtls_client_certs), 0),
     coalesce((select max(sync_sequence) from public.customer_preferences), 0),
     coalesce((select max(sync_sequence) from public.customer_sessions), 0),
     coalesce((select max(sequence) from public.sync_tombstones), 0)
   )
 where singleton = true;
create index if not exists orgs_sync_sequence_idx
  on orgs (sync_sequence);
create index if not exists projects_org_sync_sequence_idx
  on projects (org_id, sync_sequence);
create index if not exists api_keys_org_sync_sequence_idx
  on api_keys (org_id, sync_sequence);
create index if not exists mtls_client_certs_org_sync_sequence_idx
  on mtls_client_certs (org_id, sync_sequence);
create index if not exists customer_preferences_user_sync_sequence_idx
  on customer_preferences (user_id, sync_sequence);
create index if not exists customer_sessions_user_sync_sequence_idx
  on customer_sessions (user_id, sync_sequence);
