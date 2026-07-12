-- Canonical single-tenant PostgreSQL schema for Fiducia Operations Control Plane.
-- fiducia-node owns coordination state; PostgreSQL owns customer definitions,
-- durable workflow progress, observations, runner inventory and append-only audit.

create table if not exists operations (
  id uuid primary key default gen_random_uuid(),
  operation_type varchar(40) not null,
  target jsonb not null,
  desired_state jsonb not null,
  generation bigint default 1 not null,
  status varchar(32) default 'pending' not null,
  execution_policy jsonb not null,
  created_at timestamptz default now() not null,
  updated_at timestamptz default now() not null,
  completed_at timestamptz,
  constraint operations_target_object_chk check (jsonb_typeof(target) = 'object'),
  constraint operations_policy_object_chk check (jsonb_typeof(execution_policy) = 'object'),
  constraint operations_status_chk check (status in ('pending','running','paused','rolling_back','rolled_back','completed','failed','cancelled','escalated'))
);
create index if not exists operations_status_created_idx on operations (status, created_at);

create table if not exists operation_schedules (
  id uuid primary key default gen_random_uuid(),
  name varchar(200) not null,
  cron varchar(200) not null,
  timezone varchar(80) default 'UTC' not null,
  operation_template jsonb not null,
  overlap_policy varchar(24) default 'forbid' not null,
  misfire_policy jsonb default '{"type":"run_latest_only"}'::jsonb not null,
  enabled boolean default true not null,
  last_fire_at timestamptz,
  created_at timestamptz default now() not null,
  updated_at timestamptz default now() not null,
  constraint operation_schedules_template_object_chk check (jsonb_typeof(operation_template) = 'object'),
  constraint operation_schedules_misfire_object_chk check (jsonb_typeof(misfire_policy) = 'object'),
  constraint operation_schedules_overlap_chk check (overlap_policy in ('allow','forbid','replace_existing','queue'))
);
create unique index if not exists operation_schedules_name_uq on operation_schedules (name);

create table if not exists operation_executions (
  id uuid primary key default gen_random_uuid(),
  operation_id uuid not null references operations (id) on delete cascade,
  operation_generation bigint not null,
  runner_id uuid,
  batch_number integer,
  attempt integer default 1 not null,
  status varchar(24) default 'assigned' not null,
  fencing_token bigint not null,
  idempotency_key varchar(500) not null,
  signed_specification jsonb not null,
  started_at timestamptz,
  heartbeat_at timestamptz,
  finished_at timestamptz,
  result jsonb,
  failure jsonb,
  constraint operation_executions_spec_object_chk check (jsonb_typeof(signed_specification) = 'object'),
  constraint operation_executions_status_chk check (status in ('assigned','running','succeeded','failed','cancelled','cleaning','cleaned'))
);
create unique index if not exists operation_executions_idempotency_uq on operation_executions (idempotency_key);
create index if not exists operation_executions_operation_idx on operation_executions (operation_id, operation_generation, batch_number);

create table if not exists operations_runners (
  id uuid primary key default gen_random_uuid(),
  external_runner_id varchar(200) not null,
  capabilities jsonb default '[]'::jsonb not null,
  labels jsonb default '{}'::jsonb not null,
  public_key text not null,
  status varchar(16) default 'active' not null,
  registered_at timestamptz default now() not null,
  last_heartbeat_at timestamptz default now() not null,
  constraint operations_runners_capabilities_array_chk check (jsonb_typeof(capabilities) = 'array'),
  constraint operations_runners_labels_object_chk check (jsonb_typeof(labels) = 'object'),
  constraint operations_runners_status_chk check (status in ('active','draining','offline','revoked'))
);
create unique index if not exists operations_runners_external_id_uq on operations_runners (external_runner_id);

alter table operation_executions drop constraint if exists operation_executions_runner_fk;
alter table operation_executions add constraint operation_executions_runner_fk foreign key (runner_id) references operations_runners (id) on delete set null;

create table if not exists resource_observations (
  id uuid primary key default gen_random_uuid(),
  resource_id varchar(500) not null,
  observed_generation bigint not null,
  actual_state jsonb not null,
  healthy boolean not null,
  observed_by_runner_id uuid references operations_runners (id) on delete set null,
  observed_at timestamptz default now() not null
);
create index if not exists resource_observations_resource_time_idx on resource_observations (resource_id, observed_at desc);

create table if not exists operation_audit (
  id uuid primary key default gen_random_uuid(),
  operation_id uuid not null references operations (id) on delete cascade,
  operation_generation bigint not null,
  fencing_token bigint not null,
  idempotency_key varchar(500) not null,
  actor varchar(320) not null,
  action varchar(120) not null,
  details jsonb default '{}'::jsonb not null,
  created_at timestamptz default now() not null,
  constraint operation_audit_details_object_chk check (jsonb_typeof(details) = 'object')
);
create unique index if not exists operation_audit_idempotency_uq on operation_audit (idempotency_key);
create index if not exists operation_audit_operation_created_idx on operation_audit (operation_id, created_at);
