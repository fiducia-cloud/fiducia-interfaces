-- Canonical PostgreSQL + pgvector schema for the private, single-tenant
-- Fiducia AI Agent Control Plane shared brain.
--
-- This file owns probabilistic and historical knowledge only. Locks, leases,
-- fencing tokens, elections, barriers, schedules, and other authoritative
-- coordination state remain in fiducia-node. Apply ai_agent_control_plane.sql
-- before this file because several provenance columns reference its agents and
-- executions.

create extension if not exists vector;

create or replace function ai_memory_bump_row_version() returns trigger as $$
begin
  new.version := old.version + 1;
  new.updated_at := now();
  return new;
end;
$$ language plpgsql;

create table if not exists ai_memory_namespaces (
  id uuid primary key default gen_random_uuid(),
  name varchar(255) not null,
  scope varchar(32) not null,
  sensitivity varchar(24) default 'internal' not null,
  read_policy jsonb default '{}'::jsonb not null,
  write_policy jsonb default '{}'::jsonb not null,
  retention_policy jsonb default '{}'::jsonb not null,
  created_at timestamptz default now() not null,
  updated_at timestamptz default now() not null,
  version bigint default 1 not null,
  constraint ai_memory_namespaces_scope_chk check (scope in ('workflow','organization','customer','system')),
  constraint ai_memory_namespaces_sensitivity_chk check (sensitivity in ('public','internal','confidential','restricted')),
  constraint ai_memory_namespaces_read_policy_object_chk check (jsonb_typeof(read_policy) = 'object'),
  constraint ai_memory_namespaces_write_policy_object_chk check (jsonb_typeof(write_policy) = 'object'),
  constraint ai_memory_namespaces_retention_policy_object_chk check (jsonb_typeof(retention_policy) = 'object')
);
create unique index if not exists ai_memory_namespaces_name_uq on ai_memory_namespaces (name);
drop trigger if exists ai_memory_namespaces_bump on ai_memory_namespaces;
create trigger ai_memory_namespaces_bump before update on ai_memory_namespaces for each row execute function ai_memory_bump_row_version();

create table if not exists ai_memory_records (
  id uuid primary key default gen_random_uuid(),
  namespace_id uuid not null references ai_memory_namespaces (id) on delete restrict,
  memory_type varchar(24) not null,
  key varchar(500) not null,
  content text,
  value jsonb default '{}'::jsonb not null,
  content_digest varchar(128) not null,
  metadata jsonb default '{}'::jsonb not null,
  source_execution_id uuid references ai_executions (id) on delete set null,
  author_agent_id uuid references ai_agents (id) on delete set null,
  source_model_provider varchar(64),
  source_model_name varchar(160),
  source_model_version varchar(160),
  artifact_uri text,
  artifact_digest varchar(128),
  trust_basis_points integer default 5000 not null,
  importance_basis_points integer default 5000 not null,
  sensitivity varchar(24) default 'internal' not null,
  valid_from timestamptz default now() not null,
  valid_until timestamptz,
  superseded_by uuid references ai_memory_records (id) on delete set null,
  deleted_at timestamptz,
  deletion_generation bigint,
  created_at timestamptz default now() not null,
  updated_at timestamptz default now() not null,
  version bigint default 1 not null,
  constraint ai_memory_records_type_chk check (memory_type in ('working','episodic','semantic','procedural','entity','observation')),
  constraint ai_memory_records_value_object_chk check (jsonb_typeof(value) = 'object'),
  constraint ai_memory_records_metadata_object_chk check (jsonb_typeof(metadata) = 'object'),
  constraint ai_memory_records_trust_chk check (trust_basis_points between 0 and 10000),
  constraint ai_memory_records_importance_chk check (importance_basis_points between 0 and 10000),
  constraint ai_memory_records_sensitivity_chk check (sensitivity in ('public','internal','confidential','restricted')),
  constraint ai_memory_records_validity_chk check (valid_until is null or valid_until > valid_from),
  constraint ai_memory_records_deletion_chk check ((deleted_at is null and deletion_generation is null) or (deleted_at is not null and deletion_generation is not null)),
  constraint ai_memory_records_payload_chk check (content is not null or value <> '{}'::jsonb),
  constraint ai_memory_records_supersession_chk check (superseded_by is null or superseded_by <> id)
);
create unique index if not exists ai_memory_records_live_key_uq on ai_memory_records (namespace_id, key) where deleted_at is null and superseded_by is null;
create index if not exists ai_memory_records_type_validity_idx on ai_memory_records (namespace_id, memory_type, valid_until) where deleted_at is null;
create index if not exists ai_memory_records_execution_idx on ai_memory_records (source_execution_id) where source_execution_id is not null;
create index if not exists ai_memory_records_metadata_gin_idx on ai_memory_records using gin (metadata);
drop trigger if exists ai_memory_records_bump on ai_memory_records;
create trigger ai_memory_records_bump before update on ai_memory_records for each row execute function ai_memory_bump_row_version();

create table if not exists ai_memory_embeddings (
  id uuid primary key default gen_random_uuid(),
  memory_id uuid not null references ai_memory_records (id) on delete cascade,
  model_provider varchar(64) not null,
  model_name varchar(160) not null,
  model_version varchar(160) not null,
  dimensions integer default 1536 not null,
  source_content_digest varchar(128) not null,
  embedding vector(1536) not null,
  created_at timestamptz default now() not null,
  constraint ai_memory_embeddings_dimensions_chk check (dimensions = 1536)
);
create unique index if not exists ai_memory_embeddings_version_uq on ai_memory_embeddings (memory_id, model_provider, model_name, model_version, source_content_digest);
create index if not exists ai_memory_embeddings_hnsw_idx on ai_memory_embeddings using hnsw (embedding vector_cosine_ops);

create table if not exists ai_memory_embedding_jobs (
  id uuid primary key default gen_random_uuid(),
  memory_id uuid not null references ai_memory_records (id) on delete cascade,
  model_provider varchar(64) not null,
  model_name varchar(160) not null,
  model_version varchar(160) not null,
  source_content_digest varchar(128) not null,
  status varchar(24) default 'pending' not null,
  attempt integer default 0 not null,
  available_at timestamptz default now() not null,
  claimed_at timestamptz,
  completed_at timestamptz,
  failure jsonb,
  created_at timestamptz default now() not null,
  updated_at timestamptz default now() not null,
  version bigint default 1 not null,
  constraint ai_memory_embedding_jobs_status_chk check (status in ('pending','claimed','completed','failed','cancelled')),
  constraint ai_memory_embedding_jobs_attempt_chk check (attempt >= 0),
  constraint ai_memory_embedding_jobs_failure_object_chk check (failure is null or jsonb_typeof(failure) = 'object')
);
create unique index if not exists ai_memory_embedding_jobs_dedupe_uq on ai_memory_embedding_jobs (memory_id, model_provider, model_name, model_version, source_content_digest) where status in ('pending','claimed');
create index if not exists ai_memory_embedding_jobs_ready_idx on ai_memory_embedding_jobs (status, available_at) where status = 'pending';
drop trigger if exists ai_memory_embedding_jobs_bump on ai_memory_embedding_jobs;
create trigger ai_memory_embedding_jobs_bump before update on ai_memory_embedding_jobs for each row execute function ai_memory_bump_row_version();

create table if not exists ai_memory_claims (
  id uuid primary key default gen_random_uuid(),
  namespace_id uuid not null references ai_memory_namespaces (id) on delete restrict,
  subject varchar(500) not null,
  predicate varchar(500) not null,
  value jsonb not null,
  value_digest varchar(128) not null,
  status varchar(24) default 'asserted' not null,
  confidence_basis_points integer not null,
  author_agent_id uuid references ai_agents (id) on delete set null,
  source_execution_id uuid references ai_executions (id) on delete set null,
  resolved_by varchar(320),
  resolution_policy_version varchar(160),
  valid_from timestamptz default now() not null,
  valid_until timestamptz,
  superseded_by uuid references ai_memory_claims (id) on delete set null,
  created_at timestamptz default now() not null,
  updated_at timestamptz default now() not null,
  version bigint default 1 not null,
  constraint ai_memory_claims_status_chk check (status in ('asserted','contested','resolved','superseded','expired')),
  constraint ai_memory_claims_confidence_chk check (confidence_basis_points between 0 and 10000),
  constraint ai_memory_claims_validity_chk check (valid_until is null or valid_until > valid_from),
  constraint ai_memory_claims_resolution_chk check ((status = 'resolved' and resolved_by is not null and resolution_policy_version is not null) or status <> 'resolved'),
  constraint ai_memory_claims_supersession_chk check (superseded_by is null or superseded_by <> id)
);
create index if not exists ai_memory_claims_lookup_idx on ai_memory_claims (namespace_id, subject, predicate, status, valid_until);
create index if not exists ai_memory_claims_value_gin_idx on ai_memory_claims using gin (value);
drop trigger if exists ai_memory_claims_bump on ai_memory_claims;
create trigger ai_memory_claims_bump before update on ai_memory_claims for each row execute function ai_memory_bump_row_version();

create table if not exists ai_memory_claim_evidence (
  id uuid primary key default gen_random_uuid(),
  claim_id uuid not null references ai_memory_claims (id) on delete cascade,
  relation varchar(24) not null,
  memory_id uuid references ai_memory_records (id) on delete set null,
  source_uri text,
  source_digest varchar(128) not null,
  independence_key varchar(255),
  author_agent_id uuid references ai_agents (id) on delete set null,
  metadata jsonb default '{}'::jsonb not null,
  created_at timestamptz default now() not null,
  constraint ai_memory_claim_evidence_relation_chk check (relation in ('support','contest','resolve','supersede')),
  constraint ai_memory_claim_evidence_source_chk check (memory_id is not null or source_uri is not null),
  constraint ai_memory_claim_evidence_metadata_object_chk check (jsonb_typeof(metadata) = 'object')
);
create unique index if not exists ai_memory_claim_evidence_dedupe_uq on ai_memory_claim_evidence (claim_id, relation, source_digest, coalesce(independence_key, ''));
create index if not exists ai_memory_claim_evidence_memory_idx on ai_memory_claim_evidence (memory_id) where memory_id is not null;

create table if not exists ai_memory_edges (
  id uuid primary key default gen_random_uuid(),
  namespace_id uuid not null references ai_memory_namespaces (id) on delete restrict,
  from_memory_id uuid not null references ai_memory_records (id) on delete cascade,
  relation varchar(255) not null,
  to_memory_id uuid not null references ai_memory_records (id) on delete cascade,
  weight_basis_points integer default 5000 not null,
  provenance jsonb default '{}'::jsonb not null,
  valid_until timestamptz,
  created_at timestamptz default now() not null,
  constraint ai_memory_edges_weight_chk check (weight_basis_points between 0 and 10000),
  constraint ai_memory_edges_provenance_object_chk check (jsonb_typeof(provenance) = 'object'),
  constraint ai_memory_edges_self_chk check (from_memory_id <> to_memory_id)
);
create unique index if not exists ai_memory_edges_uq on ai_memory_edges (namespace_id, from_memory_id, relation, to_memory_id);
create index if not exists ai_memory_edges_reverse_idx on ai_memory_edges (namespace_id, to_memory_id, relation);

create table if not exists ai_memory_tombstones (
  id uuid primary key default gen_random_uuid(),
  memory_id uuid not null,
  namespace_id uuid not null references ai_memory_namespaces (id) on delete restrict,
  deleted_content_digest varchar(128) not null,
  deletion_generation bigint not null,
  reason varchar(255) not null,
  deleted_by varchar(320) not null,
  replacement_memory_id uuid references ai_memory_records (id) on delete set null,
  metadata jsonb default '{}'::jsonb not null,
  created_at timestamptz default now() not null,
  constraint ai_memory_tombstones_generation_chk check (deletion_generation > 0),
  constraint ai_memory_tombstones_metadata_object_chk check (jsonb_typeof(metadata) = 'object')
);
create unique index if not exists ai_memory_tombstones_generation_uq on ai_memory_tombstones (memory_id, deletion_generation);

create table if not exists ai_memory_access_audit (
  id uuid primary key default gen_random_uuid(),
  namespace_id uuid not null references ai_memory_namespaces (id) on delete restrict,
  memory_id uuid references ai_memory_records (id) on delete set null,
  actor varchar(320) not null,
  action varchar(64) not null,
  policy_version varchar(160) not null,
  decision varchar(16) not null,
  reason_code varchar(160) not null,
  query_digest varchar(128),
  details jsonb default '{}'::jsonb not null,
  created_at timestamptz default now() not null,
  constraint ai_memory_access_audit_action_chk check (action in ('observe','assert_claim','support_claim','contest_claim','resolve_claim','recall','promote','supersede','expire','forget','reindex')),
  constraint ai_memory_access_audit_decision_chk check (decision in ('allow','deny')),
  constraint ai_memory_access_audit_details_object_chk check (jsonb_typeof(details) = 'object')
);
create index if not exists ai_memory_access_audit_namespace_created_idx on ai_memory_access_audit (namespace_id, created_at desc);
create index if not exists ai_memory_access_audit_memory_created_idx on ai_memory_access_audit (memory_id, created_at desc) where memory_id is not null;
