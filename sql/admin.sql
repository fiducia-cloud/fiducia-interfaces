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
-- updated_at + monotonic version, bumped by a BEFORE UPDATE trigger.

create or replace function bump_row_version() returns trigger as $$
begin
  new.version := old.version + 1;
  new.updated_at := now();
  return new;
end;
$$ language plpgsql;

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
  constraint operators_role_chk check (role in ('owner', 'admin', 'operator', 'viewer'))
);
create unique index if not exists operators_supabase_uq on operators (supabase_user_id);
create unique index if not exists operators_email_uq on operators (lower(email));
drop trigger if exists operators_bump on operators;
create trigger operators_bump before update on operators for each row execute function bump_row_version();

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
  constraint infra_operations_action_chk
    check (action in ('scale', 'drain', 'cordon', 'uncordon', 'placement', 'snapshot', 'restore')),
  constraint infra_operations_status_chk
    check (status in ('requested', 'applied', 'failed')),
  constraint infra_operations_params_object_chk check (jsonb_typeof(params) = 'object'),
  constraint infra_operations_target_nodes_chk check (target_nodes is null or target_nodes >= 3)
);
create index if not exists infra_operations_operator_created_idx
  on infra_operations (operator_id, created_at desc);
create index if not exists infra_operations_status_idx
  on infra_operations (status) where status = 'requested';
drop trigger if exists infra_operations_bump on infra_operations;
create trigger infra_operations_bump before update on infra_operations for each row execute function bump_row_version();

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
