-- Canonical PostgreSQL schema for a single-tenant Fiducia Operations Control Plane.
-- Workflow history and queryable desired/observed state live here; active ownership,
-- fencing, CAS, counters, schedules, and barriers are coordinated by fiducia-node.

create or replace function bump_row_version() returns trigger as $$
begin
  new.version := old.version + 1;
  new.updated_at := now();
  return new;
end;
$$ language plpgsql;

create table if not exists operation_targets (
  id uuid primary key default gen_random_uuid(),
  provider varchar(32) not null,
  external_id varchar(255) not null,
  labels jsonb default '{}'::jsonb not null,
  connection_ref varchar(255),
  desired_generation bigint default 0 not null,
  observed_generation bigint default 0 not null,
  desired_state jsonb default '{}'::jsonb not null,
  observed_state jsonb default '{}'::jsonb not null,
  healthy boolean default false not null,
  last_observed_at timestamptz,
  created_at timestamptz default now() not null,
  updated_at timestamptz default now() not null,
  version bigint default 1 not null,
  constraint operation_targets_labels_object_chk check (jsonb_typeof(labels) = 'object'),
  constraint operation_targets_desired_object_chk check (jsonb_typeof(desired_state) = 'object'),
  constraint operation_targets_observed_object_chk check (jsonb_typeof(observed_state) = 'object')
);
create unique index if not exists operation_targets_provider_external_uq on operation_targets (provider, external_id);
create index if not exists operation_targets_reconcile_idx on operation_targets (healthy, desired_generation, observed_generation);
drop trigger if exists operation_targets_bump on operation_targets;
create trigger operation_targets_bump before update on operation_targets for each row execute function bump_row_version();

create table if not exists operations (
  id uuid primary key default gen_random_uuid(),
  operation_type varchar(48) not null,
  status varchar(32) default 'pending' not null,
  target_selector jsonb default '{}'::jsonb not null,
  desired_state jsonb default '{}'::jsonb not null,
  execution_policy jsonb default '{}'::jsonb not null,
  requested_by varchar(320),
  coordination_resource varchar(500) not null,
  current_fencing_token bigint,
  created_at timestamptz default now() not null,
  updated_at timestamptz default now() not null,
  completed_at timestamptz,
  version bigint default 1 not null,
  constraint operations_type_chk check (operation_type in ('deploy','restart','database_migration','backup','restore','certificate_rotation','configuration_update','custom_job')),
  constraint operations_status_chk check (status in ('pending','running','paused','rolling_back','rolled_back','completed','failed','cancelled','escalated')),
  constraint operations_selector_object_chk check (jsonb_typeof(target_selector) = 'object'),
  constraint operations_desired_object_chk check (jsonb_typeof(desired_state) = 'object'),
  constraint operations_policy_object_chk check (jsonb_typeof(execution_policy) = 'object')
);
create index if not exists operations_status_created_idx on operations (status, created_at);
drop trigger if exists operations_bump on operations;
create trigger operations_bump before update on operations for each row execute function bump_row_version();

create table if not exists operations_runners (
  id uuid primary key default gen_random_uuid(),
  instance_id varchar(255) not null,
  provider varchar(32) not null,
  capabilities jsonb default '[]'::jsonb not null,
  cpu_cores integer not null,
  memory_bytes bigint not null,
  isolation_mode varchar(32) not null,
  status varchar(24) default 'online' not null,
  public_key text not null,
  last_heartbeat_at timestamptz default now() not null,
  created_at timestamptz default now() not null,
  updated_at timestamptz default now() not null,
  version bigint default 1 not null,
  constraint operations_runners_status_chk check (status in ('online','busy','draining','offline')),
  constraint operations_runners_capabilities_array_chk check (jsonb_typeof(capabilities) = 'array')
);
create unique index if not exists operations_runners_instance_uq on operations_runners (instance_id);
drop trigger if exists operations_runners_bump on operations_runners;
create trigger operations_runners_bump before update on operations_runners for each row execute function bump_row_version();

create table if not exists operation_executions (
  id uuid primary key default gen_random_uuid(),
  operation_id uuid not null references operations (id) on delete cascade,
  runner_id uuid references operations_runners (id) on delete set null,
  status varchar(24) default 'assigned' not null,
  attempt integer default 1 not null,
  generation bigint not null,
  fencing_token bigint not null,
  idempotency_key varchar(500) not null,
  signed_spec jsonb not null,
  signature text not null,
  started_at timestamptz,
  heartbeat_at timestamptz,
  completed_at timestamptz,
  result jsonb,
  error text,
  created_at timestamptz default now() not null,
  updated_at timestamptz default now() not null,
  version bigint default 1 not null,
  constraint operation_executions_status_chk check (status in ('assigned','running','succeeded','failed','cancelled','timed_out','cleanup_pending','cleaned')),
  constraint operation_executions_attempt_chk check (attempt > 0),
  constraint operation_executions_spec_object_chk check (jsonb_typeof(signed_spec) = 'object')
);
create unique index if not exists operation_executions_idempotency_uq on operation_executions (idempotency_key);
create index if not exists operation_executions_operation_idx on operation_executions (operation_id, attempt);
create index if not exists operation_executions_active_idx on operation_executions (status, heartbeat_at) where status in ('assigned','running','cleanup_pending');
drop trigger if exists operation_executions_bump on operation_executions;
create trigger operation_executions_bump before update on operation_executions for each row execute function bump_row_version();

create table if not exists operation_schedules (
  id uuid primary key default gen_random_uuid(),
  name varchar(255) not null,
  cron varchar(255) not null,
  timezone varchar(80) default 'UTC' not null,
  operation_template jsonb not null,
  overlap_policy varchar(24) default 'forbid' not null,
  misfire_policy jsonb default '{"kind":"run_latest_only"}'::jsonb not null,
  enabled boolean default true not null,
  last_fire_at timestamptz,
  next_fire_at timestamptz,
  coordination_schedule_name varchar(500) not null,
  created_at timestamptz default now() not null,
  updated_at timestamptz default now() not null,
  version bigint default 1 not null,
  constraint operation_schedules_overlap_chk check (overlap_policy in ('allow','forbid','replace_existing','queue')),
  constraint operation_schedules_template_object_chk check (jsonb_typeof(operation_template) = 'object'),
  constraint operation_schedules_misfire_object_chk check (jsonb_typeof(misfire_policy) = 'object')
);
create unique index if not exists operation_schedules_name_uq on operation_schedules (name);
drop trigger if exists operation_schedules_bump on operation_schedules;
create trigger operation_schedules_bump before update on operation_schedules for each row execute function bump_row_version();

create table if not exists operation_schedule_runs (
  id uuid primary key default gen_random_uuid(),
  schedule_id uuid not null references operation_schedules (id) on delete cascade,
  operation_id uuid references operations (id) on delete set null,
  fire_id varchar(255) not null,
  scheduled_for timestamptz not null,
  status varchar(24) default 'claimed' not null,
  created_at timestamptz default now() not null,
  completed_at timestamptz,
  constraint operation_schedule_runs_status_chk check (status in ('claimed','started','completed','failed','skipped','replaced','queued'))
);
create unique index if not exists operation_schedule_runs_fire_uq on operation_schedule_runs (schedule_id, fire_id);

create table if not exists rollout_batches (
  id uuid primary key default gen_random_uuid(),
  operation_id uuid not null references operations (id) on delete cascade,
  batch_index integer not null,
  phase varchar(24) not null,
  status varchar(24) default 'pending' not null,
  required_healthy integer default 0 not null,
  healthy_count integer default 0 not null,
  failure_count integer default 0 not null,
  barrier_name varchar(500) not null,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz default now() not null,
  updated_at timestamptz default now() not null,
  version bigint default 1 not null,
  constraint rollout_batches_phase_chk check (phase in ('canary','rolling','verification','rollback')),
  constraint rollout_batches_status_chk check (status in ('pending','running','waiting_at_barrier','succeeded','failed','rolled_back','cancelled'))
);
create unique index if not exists rollout_batches_operation_index_uq on rollout_batches (operation_id, batch_index);
drop trigger if exists rollout_batches_bump on rollout_batches;
create trigger rollout_batches_bump before update on rollout_batches for each row execute function bump_row_version();

create table if not exists rollout_batch_targets (
  batch_id uuid not null references rollout_batches (id) on delete cascade,
  target_id uuid not null references operation_targets (id) on delete cascade,
  status varchar(24) default 'pending' not null,
  execution_id uuid references operation_executions (id) on delete set null,
  observed_generation bigint,
  health jsonb default '{}'::jsonb not null,
  updated_at timestamptz default now() not null,
  version bigint default 1 not null,
  primary key (batch_id, target_id),
  constraint rollout_batch_targets_status_chk check (status in ('pending','running','healthy','failed','skipped','rolled_back')),
  constraint rollout_batch_targets_health_object_chk check (jsonb_typeof(health) = 'object')
);
drop trigger if exists rollout_batch_targets_bump on rollout_batch_targets;
create trigger rollout_batch_targets_bump before update on rollout_batch_targets for each row execute function bump_row_version();

create table if not exists migration_runs (
  id uuid primary key default gen_random_uuid(),
  operation_id uuid not null references operations (id) on delete cascade,
  database_ref varchar(500) not null,
  migration_id varchar(255) not null,
  from_version varchar(120),
  to_version varchar(120) not null,
  status varchar(24) default 'preflight' not null,
  fencing_token bigint not null,
  checksum varchar(128) not null,
  applied_at timestamptz,
  created_at timestamptz default now() not null,
  constraint migration_runs_status_chk check (status in ('preflight','running','applied','failed','rolled_back'))
);
create unique index if not exists migration_runs_database_migration_uq on migration_runs (database_ref, migration_id);

create table if not exists operation_events (
  id uuid primary key default gen_random_uuid(),
  operation_id uuid not null references operations (id) on delete cascade,
  execution_id uuid references operation_executions (id) on delete set null,
  event_type varchar(120) not null,
  generation bigint not null,
  fencing_token bigint,
  payload jsonb default '{}'::jsonb not null,
  created_at timestamptz default now() not null,
  constraint operation_events_payload_object_chk check (jsonb_typeof(payload) = 'object')
);
create index if not exists operation_events_operation_created_idx on operation_events (operation_id, created_at);

create table if not exists operations_audit_log (
  id uuid primary key default gen_random_uuid(),
  operation_id uuid references operations (id) on delete set null,
  execution_id uuid references operation_executions (id) on delete set null,
  actor varchar(320) not null,
  action varchar(160) not null,
  generation bigint not null,
  fencing_token bigint,
  idempotency_key varchar(500),
  details jsonb default '{}'::jsonb not null,
  created_at timestamptz default now() not null,
  constraint operations_audit_details_object_chk check (jsonb_typeof(details) = 'object')
);
create index if not exists operations_audit_operation_created_idx on operations_audit_log (operation_id, created_at desc);

