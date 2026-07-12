-- Canonical PostgreSQL schema for the Fiducia AI agent conversation bridge.
-- The service owns no migrations; operators apply this reviewed contract.

create schema if not exists ai_agent_bridge;
set search_path to ai_agent_bridge, public;

create table if not exists agents (
  id uuid primary key default gen_random_uuid(),
  agent_key varchar(120) not null unique,
  display_name varchar(255) not null,
  kind varchar(64) not null,
  host varchar(255),
  meta_data jsonb default '{}'::jsonb not null,
  created_at timestamptz default now() not null,
  updated_at timestamptz default now() not null,
  constraint bridge_agents_meta_object_chk check (jsonb_typeof(meta_data) = 'object')
);

create table if not exists channels (
  id uuid primary key default gen_random_uuid(),
  slug varchar(160) not null unique,
  topic text not null,
  status varchar(24) default 'active' not null,
  embedding_model varchar(255) not null,
  embedding jsonb default '[]'::jsonb not null,
  embedding_dimensions integer not null,
  created_by varchar(120) not null,
  meta_data jsonb default '{}'::jsonb not null,
  created_at timestamptz default now() not null,
  updated_at timestamptz default now() not null,
  constraint bridge_channels_status_chk check (status in ('active','archived')),
  constraint bridge_channels_embedding_array_chk check (jsonb_typeof(embedding) = 'array'),
  constraint bridge_channels_meta_object_chk check (jsonb_typeof(meta_data) = 'object')
);

create table if not exists channel_members (
  channel_slug varchar(160) not null,
  channel_id uuid references channels (id) on delete cascade,
  agent_key varchar(120) not null,
  role varchar(32) not null,
  joined_at timestamptz default now() not null,
  last_seen_at timestamptz default now() not null,
  primary key (channel_slug, agent_key)
);
create index if not exists bridge_channel_members_channel_idx on channel_members (channel_id);

create table if not exists messages (
  id uuid primary key default gen_random_uuid(),
  channel_slug varchar(160) not null,
  channel_id uuid references channels (id) on delete cascade,
  seq bigint not null,
  from_agent_key varchar(120) not null,
  role varchar(32) not null,
  content text not null,
  meta_data jsonb default '{}'::jsonb not null,
  created_at timestamptz default now() not null,
  constraint bridge_messages_meta_object_chk check (jsonb_typeof(meta_data) = 'object'),
  unique (channel_slug, seq)
);
create index if not exists bridge_messages_channel_created_idx on messages (channel_slug, created_at);

create table if not exists shared_context (
  channel_slug varchar(160) not null,
  channel_id uuid references channels (id) on delete cascade,
  ctx_key varchar(255) not null,
  value jsonb not null,
  version integer not null,
  updated_by varchar(120) not null,
  created_at timestamptz default now() not null,
  updated_at timestamptz default now() not null,
  primary key (channel_slug, ctx_key)
);

reset search_path;

