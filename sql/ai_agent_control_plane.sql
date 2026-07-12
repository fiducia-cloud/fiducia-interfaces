-- Canonical single-tenant PostgreSQL schema for Fiducia AI Agent Control Plane.
-- Coordination ownership, leases, fencing tokens, watches and idempotency live
-- in fiducia-node. These tables hold rich customer workflow state and audit.

create table if not exists ai_agents (
  id uuid primary key default gen_random_uuid(),
  external_agent_id varchar(200) not null,
  model varchar(200) not null,
  capabilities jsonb default '[]'::jsonb not null,
  status varchar(32) default 'provisioning' not null,
  generation bigint default 1 not null,
  metadata jsonb default '{}'::jsonb not null,
  created_at timestamptz default now() not null,
  updated_at timestamptz default now() not null,
  constraint ai_agents_capabilities_array_chk check (jsonb_typeof(capabilities) = 'array'),
  constraint ai_agents_metadata_object_chk check (jsonb_typeof(metadata) = 'object'),
  constraint ai_agents_status_chk check (status in ('provisioning','ready','working','awaiting_approval','draining','stopped','failed'))
);
create unique index if not exists ai_agents_external_id_uq on ai_agents (external_agent_id);
create index if not exists ai_agents_status_idx on ai_agents (status);

create table if not exists ai_work_items (
  id uuid primary key default gen_random_uuid(),
  objective text not null,
  required_capabilities jsonb default '[]'::jsonb not null,
  status varchar(32) default 'pending' not null,
  generation bigint default 1 not null,
  assigned_agent_id uuid references ai_agents (id) on delete set null,
  approval_policy jsonb default '{}'::jsonb not null,
  budget jsonb default '{}'::jsonb not null,
  result jsonb,
  failure jsonb,
  created_at timestamptz default now() not null,
  updated_at timestamptz default now() not null,
  completed_at timestamptz,
  constraint ai_work_required_capabilities_array_chk check (jsonb_typeof(required_capabilities) = 'array'),
  constraint ai_work_approval_policy_object_chk check (jsonb_typeof(approval_policy) = 'object'),
  constraint ai_work_budget_object_chk check (jsonb_typeof(budget) = 'object'),
  constraint ai_work_status_chk check (status in ('pending','claimed','running','awaiting_review','changes_requested','approved','completed','failed','cancelled','escalated'))
);
create index if not exists ai_work_status_created_idx on ai_work_items (status, created_at);
create index if not exists ai_work_agent_idx on ai_work_items (assigned_agent_id, status);

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

create table if not exists ai_shared_memory (
  id uuid primary key default gen_random_uuid(),
  namespace varchar(200) not null,
  key varchar(500) not null,
  generation bigint default 1 not null,
  value jsonb not null,
  author_agent_id uuid references ai_agents (id) on delete set null,
  created_at timestamptz default now() not null,
  updated_at timestamptz default now() not null
);
create unique index if not exists ai_shared_memory_namespace_key_uq on ai_shared_memory (namespace, key);

create table if not exists ai_work_audit (
  id uuid primary key default gen_random_uuid(),
  work_item_id uuid not null references ai_work_items (id) on delete cascade,
  work_generation bigint not null,
  fencing_token bigint not null,
  actor varchar(320) not null,
  action varchar(120) not null,
  idempotency_key varchar(500) not null,
  details jsonb default '{}'::jsonb not null,
  created_at timestamptz default now() not null,
  constraint ai_work_audit_details_object_chk check (jsonb_typeof(details) = 'object')
);
create unique index if not exists ai_work_audit_idempotency_uq on ai_work_audit (idempotency_key);
create index if not exists ai_work_audit_work_created_idx on ai_work_audit (work_item_id, created_at);
