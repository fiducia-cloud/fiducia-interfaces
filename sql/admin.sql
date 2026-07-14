-- Canonical Postgres schema for fiducia.cloud's ADMIN / control plane.
--
-- Isolation: this DB is owned exclusively by the admin dashboard backend
-- (fiducia-admin.rs) and is a SEPARATE Postgres instance from the customer DB
-- (sql/customer.sql). Neither backend connects to the other's database — this is
-- a security boundary (see docs/repo-boundaries.md). Admin's view of customer
-- data (orgs, keys) comes via an audited read API to the customer backend, never
-- a shared pool.
--
-- Holds operator identity/RBAC and the audit trail of control-plane actions
-- (scale, node drain/cordon, shard placement) that the admin app drives against
-- fiducia-brain. Same local-first SYNC CONTRACT as the customer plane:
-- `version` is per-row conflict state; `sync_sequence` is the globally ordered,
-- commit-visible catch-up cursor. They are deliberately different values.

-- A transactional counter row is used instead of a PostgreSQL sequence. Sequence
-- values are allocated outside transaction visibility, so transaction B can commit
-- N+1 while transaction A still holds N; a client advancing past N+1 would then
-- miss A forever. Updating this singleton holds a row lock until commit, which
-- serializes cursor allocation in the same order changes become visible.
create table if not exists sync_clock (
  singleton boolean primary key default true,
  last_sequence bigint default 0 not null,
  constraint sync_clock_singleton_chk check (singleton),
  constraint sync_clock_nonnegative_chk check (last_sequence >= 0)
);
insert into sync_clock (singleton, last_sequence)
values (true, 0)
on conflict (singleton) do nothing;

-- Latest delete per table/row. Keeping a tombstone makes an offline client converge
-- even though the source row no longer exists. Re-inserting the same id is safe:
-- its newer live-row sync_sequence sorts after the retained tombstone.
create table if not exists sync_tombstones (
  sequence bigint primary key,
  table_name text not null,
  row_id text not null,
  row_version bigint not null,
  deleted_at timestamptz default now() not null,
  unique (table_name, row_id),
  constraint sync_tombstones_sequence_chk check (sequence > 0),
  constraint sync_tombstones_version_chk check (row_version > 0)
);
create index if not exists sync_tombstones_table_sequence_idx
  on sync_tombstones (table_name, sequence);

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

-- Acquire the plane clock before PostgreSQL locks any target rows. Without this
-- statement trigger, transaction A could hold the clock while waiting for a row
-- already held by transaction B, which is itself waiting for the clock.
create or replace function lock_sync_clock() returns trigger as $$
begin
  perform 1 from public.sync_clock where singleton = true for update;
  if not found then
    raise exception 'sync clock singleton is missing';
  end if;
  return null;
end;
$$ language plpgsql security definer set search_path = pg_catalog, public;

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

create or replace function record_sync_tombstone() returns trigger as $$
declare
  allocated bigint;
  deleted_row_id text;
begin
  if tg_nargs != 1 then
    raise exception 'record_sync_tombstone requires the primary-key column name';
  end if;
  deleted_row_id := to_jsonb(old) ->> tg_argv[0];
  if deleted_row_id is null then
    raise exception 'sync tombstone primary key % is missing', tg_argv[0];
  end if;
  allocated := public.allocate_sync_sequence();
  insert into public.sync_tombstones
    (sequence, table_name, row_id, row_version, deleted_at)
  values
    (allocated, tg_table_name, deleted_row_id, old.version + 1, now())
  on conflict (table_name, row_id) do update
    set sequence = excluded.sequence,
        row_version = excluded.row_version,
        deleted_at = excluded.deleted_at;
  return old;
end;
$$ language plpgsql security definer set search_path = pg_catalog, public;

revoke all on function public.allocate_sync_sequence() from public;
revoke all on function public.lock_sync_clock() from public;
revoke all on function public.bump_row_version() from public;
revoke all on function public.record_sync_tombstone() from public;

-- Fiducia operators (staff). Mirrors a Supabase auth user; admin role gates
-- infra ops. Distinct from customer `users` — a different plane, a different DB.
create table if not exists operators (
  id uuid primary key default gen_random_uuid(),
  supabase_user_id uuid not null,
  email varchar(320) not null,
  role varchar(32) default 'operator' not null,
  disabled boolean default false not null,
  created_at timestamptz default now() not null,
  updated_at timestamptz default now() not null,
  version bigint default 1 not null,
  sync_sequence bigint not null,
  constraint operators_role_chk check (role in ('owner', 'admin', 'operator', 'viewer'))
);
alter table operators add column if not exists sync_sequence bigint;
create unique index if not exists operators_supabase_uq on operators (supabase_user_id);
create unique index if not exists operators_email_uq on operators (lower(email));
drop trigger if exists operators_bump on operators;
update operators
   set sync_sequence = public.allocate_sync_sequence()
 where sync_sequence is null or sync_sequence <= 0;
alter table operators alter column sync_sequence set not null;
alter table operators alter column sync_sequence drop default;
drop trigger if exists operators_sync_clock_guard on operators;
create trigger operators_sync_clock_guard before insert or update or delete on operators for each statement execute function lock_sync_clock();
create trigger operators_bump before insert or update on operators for each row execute function bump_row_version();
drop trigger if exists operators_tombstone on operators;
create trigger operators_tombstone after delete on operators for each row execute function record_sync_tombstone('id');

-- Control-plane operations audit: every scale/drain/cordon/placement action the
-- admin app issues to fiducia-brain, with its lifecycle (requested -> applied/failed).
create table if not exists infra_operations (
  id uuid primary key default gen_random_uuid(),
  operator_id uuid references operators (id) on delete set null,
  action varchar(48) not null,
  target varchar(200),
  target_nodes integer,
  params jsonb default '{}'::jsonb not null,
  status varchar(16) default 'requested' not null,
  request_id varchar(120),
  error varchar(500),
  created_at timestamptz default now() not null,
  updated_at timestamptz default now() not null,
  version bigint default 1 not null,
  sync_sequence bigint not null,
  constraint infra_operations_action_chk
    check (action in ('scale', 'drain', 'cordon', 'uncordon', 'placement', 'snapshot', 'restore')),
  constraint infra_operations_status_chk
    check (status in ('requested', 'applied', 'failed')),
  constraint infra_operations_params_object_chk check (jsonb_typeof(params) = 'object'),
  constraint infra_operations_target_nodes_chk check (target_nodes is null or target_nodes >= 3)
);
alter table infra_operations add column if not exists sync_sequence bigint;
create index if not exists infra_operations_operator_created_idx
  on infra_operations (operator_id, created_at desc);
create index if not exists infra_operations_status_idx
  on infra_operations (status) where status = 'requested';
drop trigger if exists infra_operations_bump on infra_operations;
update infra_operations
   set sync_sequence = public.allocate_sync_sequence()
 where sync_sequence is null or sync_sequence <= 0;
alter table infra_operations alter column sync_sequence set not null;
alter table infra_operations alter column sync_sequence drop default;
drop trigger if exists infra_operations_sync_clock_guard on infra_operations;
create trigger infra_operations_sync_clock_guard before insert or update or delete on infra_operations for each statement execute function lock_sync_clock();
create trigger infra_operations_bump before insert or update on infra_operations for each row execute function bump_row_version();
drop trigger if exists infra_operations_tombstone on infra_operations;
create trigger infra_operations_tombstone after delete on infra_operations for each row execute function record_sync_tombstone('id');

-- Operator-authored broadcast notices surfaced on the admin dashboard
-- (maintenance windows, incident notes, policy reminders). Operator plane only;
-- never shown to customers. Part of the admin sync set so open operator
-- consoles reconcile the active banner set live.
create table if not exists admin_broadcast_notices (
  id uuid primary key default gen_random_uuid(),
  operator_id uuid references operators (id) on delete set null,
  severity varchar(16) default 'info' not null,
  title varchar(200) not null,
  body varchar(2000) default '' not null,
  active boolean default true not null,
  starts_at timestamptz default now() not null,
  ends_at timestamptz,
  created_at timestamptz default now() not null,
  updated_at timestamptz default now() not null,
  version bigint default 1 not null,
  sync_sequence bigint not null,
  constraint admin_broadcast_notices_severity_chk
    check (severity in ('info', 'warning', 'critical')),
  constraint admin_broadcast_notices_window_chk
    check (ends_at is null or ends_at > starts_at)
);
alter table admin_broadcast_notices add column if not exists sync_sequence bigint;
create index if not exists admin_broadcast_notices_active_idx
  on admin_broadcast_notices (starts_at desc) where active;
update admin_broadcast_notices set sync_sequence = public.allocate_sync_sequence()
 where sync_sequence is null or sync_sequence <= 0;
alter table admin_broadcast_notices alter column sync_sequence set not null;
alter table admin_broadcast_notices alter column sync_sequence drop default;
drop trigger if exists admin_broadcast_notices_sync_clock_guard on admin_broadcast_notices;
create trigger admin_broadcast_notices_sync_clock_guard before insert or update or delete on admin_broadcast_notices for each statement execute function lock_sync_clock();
drop trigger if exists admin_broadcast_notices_bump on admin_broadcast_notices;
create trigger admin_broadcast_notices_bump before insert or update on admin_broadcast_notices for each row execute function bump_row_version();
drop trigger if exists admin_broadcast_notices_tombstone on admin_broadcast_notices;
create trigger admin_broadcast_notices_tombstone after delete on admin_broadcast_notices for each row execute function record_sync_tombstone('id');

-- Admin-plane audit (append-only; no version/trigger).
create table if not exists admin_audit_log (
  id uuid primary key default gen_random_uuid(),
  actor_operator_id uuid references operators (id) on delete set null,
  actor varchar(320),
  action varchar(120) not null,
  target varchar(320),
  request_id varchar(120),
  source_ip inet,
  user_agent varchar(500),
  meta jsonb default '{}'::jsonb not null,
  created_at timestamptz default now() not null,
  retention_expires_at timestamptz,
  constraint admin_audit_meta_object_chk check (jsonb_typeof(meta) = 'object')
);
create index if not exists admin_audit_log_actor_created_idx
  on admin_audit_log (actor_operator_id, created_at desc);
create index if not exists admin_audit_log_action_created_idx
  on admin_audit_log (action, created_at desc);

-- ============================================================================
-- SUPABASE REALTIME + ROW-LEVEL SECURITY (local-first sync, defense-in-depth)
-- ----------------------------------------------------------------------------
-- Idempotent, and a NO-OP on a non-Supabase Postgres (guards on the
-- supabase_realtime publication / auth.uid()). The admin frontend syncs over the
-- backend WS (/admin/ws), so these are belt-and-suspenders for any Supabase
-- realtime consumer. Same rule as the customer plane: the admin backend
-- (fiducia-admin.rs) MUST connect as a BYPASSRLS/owner/service role — these
-- policies constrain only the `authenticated` realtime consumer.
-- ============================================================================

-- (1) Full old row on delete, so DELETE CDC carries `version`.
alter table operators        replica identity full;
alter table infra_operations replica identity full;

-- (2) Register synced tables with Supabase's realtime publication (if present).
do $$
declare t text;
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach t in array array['operators','infra_operations'] loop
      if not exists (
        select 1 from pg_publication_tables
        where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
      ) then
        execute format('alter publication supabase_realtime add table public.%I', t);
      end if;
    end loop;
  end if;
end $$;

-- (4) Audit is server-internal even though legacy installations place it in
-- Supabase's API-exposed `public` schema. RLS with no client policy plus explicit
-- revocation makes that boundary fail closed. The admin backend must use the
-- documented BYPASSRLS/service role.
alter table admin_audit_log enable row level security;
alter table sync_clock enable row level security;
alter table sync_tombstones enable row level security;

do $$
declare role_name text;
begin
  foreach role_name in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = role_name) then
      execute format('revoke all privileges on table public.admin_audit_log from %I', role_name);
      execute format('revoke all privileges on table public.sync_clock from %I', role_name);
      execute format('revoke all privileges on table public.sync_tombstones from %I', role_name);
      execute format('revoke all on function public.allocate_sync_sequence() from %I', role_name);
      execute format('revoke all on function public.lock_sync_clock() from %I', role_name);
      execute format('revoke all on function public.bump_row_version() from %I', role_name);
      execute format('revoke all on function public.record_sync_tombstone() from %I', role_name);
    end if;
  end loop;
end $$;

-- (3) RLS — Supabase only. An operator sees their own row; any active operator
-- (staff) may read the control-plane operations feed.
do $$
begin
  if to_regprocedure('auth.uid()') is null then
    return;
  end if;

  execute 'alter table operators enable row level security';
  execute 'drop policy if exists operators_self_read on operators';
  execute $p$
    create policy operators_self_read on operators for select to authenticated
      using (supabase_user_id = auth.uid())$p$;

  execute 'alter table infra_operations enable row level security';
  execute 'drop policy if exists infra_operations_staff_read on infra_operations';
  execute $p$
    create policy infra_operations_staff_read on infra_operations for select to authenticated using (
      exists (select 1 from operators o
              where o.supabase_user_id = auth.uid() and o.disabled = false))$p$;
end $$;

-- ============================================================================
-- SYNC DURABILITY: idempotency ledger + globally ordered catch-up indexes
-- ----------------------------------------------------------------------------
-- Server-internal, not synced/realtime. Each key is bound to a canonical digest
-- of the authenticated operator + table + row + operation + base version +
-- payload. The admin backend claims the key, mutates the row, and records the
-- committed version in ONE transaction, so a failed mutation cannot strand a
-- permanently in-flight key. Prune completed keys via the created_at index.
create table if not exists sync_idempotency_keys (
  key text primary key,
  request_fingerprint varchar(64),
  committed_version bigint,
  created_at timestamptz default now() not null
);
-- Backward-compatible upgrade for databases created from an older admin.sql.
-- Historical rows remain nullable because their original request cannot be
-- reconstructed; fiducia-admin rejects those keys and every newly claimed key
-- is fingerprinted.
alter table sync_idempotency_keys
  add column if not exists request_fingerprint varchar(64);
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'sync_idempotency_request_fingerprint_chk'
      and conrelid = 'sync_idempotency_keys'::regclass
  ) then
    alter table sync_idempotency_keys
      add constraint sync_idempotency_request_fingerprint_chk
      check (request_fingerprint is null or request_fingerprint ~ '^[0-9a-f]{64}$')
      not valid;
  end if;
end $$;
-- NOT VALID preserves pre-upgrade NULL rows for explicit fail-closed detection,
-- while PostgreSQL still enforces the constraint for every new/updated row.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'sync_idempotency_request_fingerprint_required'
      and conrelid = 'sync_idempotency_keys'::regclass
  ) then
    alter table sync_idempotency_keys
      add constraint sync_idempotency_request_fingerprint_required
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

-- Catch-up reads current rows and delete tombstones through one ordered UNION.
-- `sync_sequence` allocation is transactional/commit-ordered; `version` remains
-- a per-row CAS value and must never be used as a table-wide cursor.
update public.sync_clock
   set last_sequence = greatest(
     last_sequence,
     coalesce((select max(sync_sequence) from public.operators), 0),
     coalesce((select max(sync_sequence) from public.infra_operations), 0),
     coalesce((select max(sequence) from public.sync_tombstones), 0)
   )
 where singleton = true;
create index if not exists operators_sync_sequence_idx
  on operators (sync_sequence);
create index if not exists infra_operations_sync_sequence_idx
  on infra_operations (sync_sequence);
