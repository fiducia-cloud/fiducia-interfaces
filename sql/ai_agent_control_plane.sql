-- Canonical PostgreSQL schema for a single-tenant Fiducia AI Agent Control Plane.
-- Rich customer data lives here. Exclusive ownership, fencing tokens, elections,
-- and high-contention coordination remain authoritative in fiducia-node.

create extension if not exists vector;

create or replace function bump_row_version() returns trigger as $$
begin
  new.version := old.version + 1;
  new.updated_at := now();
  return new;
end;
$$ language plpgsql;

create table if not exists ai_repositories (
  id uuid primary key default gen_random_uuid(),
  provider varchar(32) not null,
  external_id varchar(255) not null,
  clone_url text not null,
  default_branch varchar(255) default 'main' not null,
  installation_ref varchar(255),
  metadata jsonb default '{}'::jsonb not null,
  created_at timestamptz default now() not null,
  updated_at timestamptz default now() not null,
  version bigint default 1 not null,
  constraint repositories_provider_chk check (provider in ('github', 'gitlab', 'bitbucket', 'local')),
  constraint repositories_metadata_object_chk check (jsonb_typeof(metadata) = 'object')
);
create unique index if not exists repositories_provider_external_uq on ai_repositories (provider, external_id);
drop trigger if exists repositories_bump on ai_repositories;
create trigger repositories_bump before update on ai_repositories for each row execute function bump_row_version();

create table if not exists ai_agents (
  id uuid primary key default gen_random_uuid(),
  external_agent_id varchar(200) not null,
  name varchar(160) not null,
  model varchar(200) not null,
  model_provider varchar(64) not null,
  model_name varchar(160) not null,
  capabilities jsonb default '[]'::jsonb not null,
  status varchar(32) default 'provisioning' not null,
  runner_id uuid,
  metadata jsonb default '{}'::jsonb not null,
  last_heartbeat_at timestamptz,
  generation bigint default 1 not null,
  created_at timestamptz default now() not null,
  updated_at timestamptz default now() not null,
  version bigint default 1 not null,
  constraint agents_status_chk check (status in ('provisioning','ready','working','awaiting_approval','draining','stopped','failed')),
  constraint agents_capabilities_array_chk check (jsonb_typeof(capabilities) = 'array'),
  constraint agents_metadata_object_chk check (jsonb_typeof(metadata) = 'object')
);
create index if not exists agents_status_idx on ai_agents (status);
create unique index if not exists ai_agents_external_id_uq on ai_agents (external_agent_id);
drop trigger if exists agents_bump on ai_agents;
create trigger agents_bump before update on ai_agents for each row execute function bump_row_version();

create table if not exists ai_runners (
  id uuid primary key default gen_random_uuid(),
  instance_id varchar(255) not null,
  address varchar(500),
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
  constraint runners_status_chk check (status in ('online','busy','draining','offline')),
  constraint runners_isolation_chk check (isolation_mode in ('process','container','microvm','kubernetes')),
  constraint runners_capabilities_array_chk check (jsonb_typeof(capabilities) = 'array')
);
create unique index if not exists runners_instance_uq on ai_runners (instance_id);
drop trigger if exists runners_bump on ai_runners;
create trigger runners_bump before update on ai_runners for each row execute function bump_row_version();
alter table ai_agents drop constraint if exists agents_runner_fk;
alter table ai_agents add constraint agents_runner_fk foreign key (runner_id) references ai_runners (id) on delete set null;

create table if not exists ai_work_items (
  id uuid primary key default gen_random_uuid(),
  source varchar(32) default 'manual' not null,
  external_id varchar(255),
  repository_id uuid references ai_repositories (id) on delete set null,
  objective text not null,
  required_capabilities jsonb default '[]'::jsonb not null,
  status varchar(32) default 'pending' not null,
  assigned_agent_id uuid references ai_agents (id) on delete set null,
  approval_policy jsonb default '{}'::jsonb not null,
  budget jsonb default '{}'::jsonb not null,
  priority integer default 0 not null,
  generation bigint default 1 not null,
  result jsonb,
  failure jsonb,
  created_at timestamptz default now() not null,
  updated_at timestamptz default now() not null,
  completed_at timestamptz,
  version bigint default 1 not null,
  constraint work_items_status_chk check (status in ('pending','claimed','running','awaiting_review','changes_requested','approved','completed','failed','cancelled','escalated')),
  constraint work_items_required_array_chk check (jsonb_typeof(required_capabilities) = 'array'),
  constraint work_items_policy_object_chk check (jsonb_typeof(approval_policy) = 'object'),
  constraint work_items_budget_object_chk check (jsonb_typeof(budget) = 'object')
);
create unique index if not exists work_items_source_external_uq on ai_work_items (source, external_id) where external_id is not null;
create index if not exists work_items_status_priority_idx on ai_work_items (status, priority desc, created_at);
drop trigger if exists work_items_bump on ai_work_items;
create trigger work_items_bump before update on ai_work_items for each row execute function bump_row_version();

-- Stable decision ledger retained from the initial schema. Detailed multi-round
-- reviews and line-level findings live in ai_review_rounds/ai_review_findings.
create table if not exists ai_review_decisions (
  id uuid primary key default gen_random_uuid(),
  work_item_id uuid not null references ai_work_items (id) on delete cascade,
  work_generation bigint not null,
  reviewer varchar(320) not null,
  reviewer_type varchar(16) not null,
  approved boolean not null,
  rationale text not null,
  created_at timestamptz default now() not null,
  constraint ai_review_type_chk check (reviewer_type in ('human','model','policy'))
);
create index if not exists ai_review_work_generation_idx on ai_review_decisions (work_item_id, work_generation);

create table if not exists ai_executions (
  id uuid primary key default gen_random_uuid(),
  work_item_id uuid not null references ai_work_items (id) on delete cascade,
  agent_id uuid not null references ai_agents (id) on delete restrict,
  runner_id uuid references ai_runners (id) on delete set null,
  model_provider varchar(64) not null,
  model_name varchar(160) not null,
  branch_name varchar(255),
  status varchar(32) default 'claimed' not null,
  phase varchar(64) default 'planning' not null,
  fencing_token bigint not null,
  lease_resource varchar(500) not null,
  lease_expires_at timestamptz,
  token_usage bigint default 0 not null,
  cost_micros bigint default 0 not null,
  started_at timestamptz default now() not null,
  completed_at timestamptz,
  created_at timestamptz default now() not null,
  updated_at timestamptz default now() not null,
  version bigint default 1 not null,
  constraint executions_status_chk check (status in ('claimed','running','awaiting_review','paused','completed','failed','cancelled','escalated'))
);
create index if not exists executions_work_created_idx on ai_executions (work_item_id, created_at desc);
create index if not exists executions_active_idx on ai_executions (status) where status in ('claimed','running','awaiting_review','paused');
drop trigger if exists executions_bump on ai_executions;
create trigger executions_bump before update on ai_executions for each row execute function bump_row_version();

create table if not exists ai_execution_checkpoints (
  id uuid primary key default gen_random_uuid(),
  execution_id uuid not null references ai_executions (id) on delete cascade,
  sequence bigint not null,
  phase varchar(64) not null,
  artifact_uri text,
  state jsonb default '{}'::jsonb not null,
  created_at timestamptz default now() not null,
  constraint execution_checkpoints_state_object_chk check (jsonb_typeof(state) = 'object')
);
create unique index if not exists execution_checkpoints_seq_uq on ai_execution_checkpoints (execution_id, sequence);

create table if not exists ai_review_rounds (
  id uuid primary key default gen_random_uuid(),
  execution_id uuid not null references ai_executions (id) on delete cascade,
  round integer not null,
  reviewer_kind varchar(24) not null,
  reviewer_ref varchar(255) not null,
  decision varchar(32),
  rationale text,
  execution_version bigint not null,
  created_at timestamptz default now() not null,
  completed_at timestamptz,
  constraint review_rounds_kind_chk check (reviewer_kind in ('model','human','policy')),
  constraint review_rounds_decision_chk check (decision is null or decision in ('approved','changes_requested','rejected','abstained'))
);
create unique index if not exists review_rounds_uq on ai_review_rounds (execution_id, round, reviewer_kind, reviewer_ref);

create table if not exists ai_review_findings (
  id uuid primary key default gen_random_uuid(),
  review_round_id uuid not null references ai_review_rounds (id) on delete cascade,
  severity varchar(16) not null,
  category varchar(64) not null,
  file_path text,
  line_start integer,
  line_end integer,
  message text not null,
  resolved boolean default false not null,
  created_at timestamptz default now() not null,
  constraint review_findings_severity_chk check (severity in ('info','low','medium','high','critical'))
);
create index if not exists review_findings_open_idx on ai_review_findings (review_round_id, severity) where resolved = false;

create table if not exists ai_test_runs (
  id uuid primary key default gen_random_uuid(),
  execution_id uuid not null references ai_executions (id) on delete cascade,
  suite varchar(255) not null,
  status varchar(24) not null,
  command text,
  exit_code integer,
  artifact_uri text,
  summary jsonb default '{}'::jsonb not null,
  started_at timestamptz default now() not null,
  completed_at timestamptz,
  constraint test_runs_status_chk check (status in ('queued','running','passed','failed','cancelled','timed_out')),
  constraint test_runs_summary_object_chk check (jsonb_typeof(summary) = 'object')
);
create index if not exists test_runs_execution_idx on ai_test_runs (execution_id, started_at);

create table if not exists ai_pull_requests (
  id uuid primary key default gen_random_uuid(),
  execution_id uuid not null references ai_executions (id) on delete cascade,
  repository_id uuid not null references ai_repositories (id) on delete cascade,
  provider varchar(32) not null,
  external_number bigint not null,
  url text not null,
  head_sha varchar(64),
  status varchar(24) default 'open' not null,
  created_at timestamptz default now() not null,
  updated_at timestamptz default now() not null,
  version bigint default 1 not null,
  constraint pull_requests_status_chk check (status in ('draft','open','merged','closed'))
);
create unique index if not exists pull_requests_repo_number_uq on ai_pull_requests (repository_id, external_number);
drop trigger if exists pull_requests_bump on ai_pull_requests;
create trigger pull_requests_bump before update on ai_pull_requests for each row execute function bump_row_version();

create table if not exists ai_policies (
  id uuid primary key default gen_random_uuid(),
  name varchar(160) not null,
  policy_type varchar(64) not null,
  enabled boolean default true not null,
  document jsonb default '{}'::jsonb not null,
  created_at timestamptz default now() not null,
  updated_at timestamptz default now() not null,
  version bigint default 1 not null,
  constraint policies_document_object_chk check (jsonb_typeof(document) = 'object')
);
create unique index if not exists policies_name_uq on ai_policies (name);
drop trigger if exists policies_bump on ai_policies;
create trigger policies_bump before update on ai_policies for each row execute function bump_row_version();

create table if not exists ai_shared_memory (
  id uuid primary key default gen_random_uuid(),
  namespace varchar(255) not null,
  key varchar(500) not null,
  generation bigint default 1 not null,
  value jsonb not null,
  content text,
  metadata jsonb default '{}'::jsonb not null,
  embedding vector(1536),
  source_execution_id uuid references ai_executions (id) on delete set null,
  author_agent_id uuid references ai_agents (id) on delete set null,
  created_at timestamptz default now() not null,
  updated_at timestamptz default now() not null,
  version bigint default 1 not null,
  constraint memory_records_metadata_object_chk check (jsonb_typeof(metadata) = 'object')
);
create unique index if not exists memory_records_key_uq on ai_shared_memory (namespace, key);
create index if not exists memory_records_embedding_idx on ai_shared_memory using hnsw (embedding vector_cosine_ops) where embedding is not null;
drop trigger if exists memory_records_bump on ai_shared_memory;
create trigger memory_records_bump before update on ai_shared_memory for each row execute function bump_row_version();

create table if not exists ai_work_audit (
  id uuid primary key default gen_random_uuid(),
  work_item_id uuid not null references ai_work_items (id) on delete cascade,
  execution_id uuid references ai_executions (id) on delete set null,
  actor varchar(320) not null,
  action varchar(160) not null,
  work_generation bigint not null,
  fencing_token bigint not null,
  idempotency_key varchar(500) not null,
  details jsonb default '{}'::jsonb not null,
  created_at timestamptz default now() not null,
  constraint ai_audit_details_object_chk check (jsonb_typeof(details) = 'object')
);
create index if not exists ai_audit_work_created_idx on ai_work_audit (work_item_id, created_at desc);
create index if not exists ai_audit_execution_created_idx on ai_work_audit (execution_id, created_at desc);
create unique index if not exists ai_work_audit_idempotency_uq on ai_work_audit (idempotency_key);
