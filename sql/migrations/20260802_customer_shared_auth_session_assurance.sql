-- Bind a Fiducia customer browser session to the Shared Auth session that was
-- issued only after the customer application completed the customer Supabase
-- MFA flow. This migration is intentionally idempotent.
--
-- Existing trusted-device rows remain unbound aal1 observations. A Shared Auth
-- browser JWT is accepted only when its `sid` matches a verified, unexpired row
-- for the same local customer user and the fixed fiducia-customer provider plane.

begin;

alter table customer_sessions
  add column if not exists shared_auth_session_id uuid,
  add column if not exists provider_project varchar(120),
  add column if not exists assurance_level varchar(16) not null default 'aal1',
  add column if not exists assurance_verified_at timestamptz,
  add column if not exists expires_at timestamptz;

comment on column customer_sessions.shared_auth_session_id is
  'Shared Auth sid issued after the Fiducia customer app completed MFA; null for legacy/device observations';
comment on column customer_sessions.provider_project is
  'Pinned provider plane for a bound Shared Auth session; customer rows must use fiducia-customer';
comment on column customer_sessions.assurance_level is
  'Local application assurance assertion; a bound Shared Auth browser session must be aal2';
comment on column customer_sessions.assurance_verified_at is
  'When the customer app completed provider MFA and bound the Shared Auth sid';
comment on column customer_sessions.expires_at is
  'Upper bound for accepting the bound Shared Auth browser session';

create unique index if not exists customer_sessions_shared_auth_sid_uq
  on customer_sessions (shared_auth_session_id)
  where shared_auth_session_id is not null;

create index if not exists customer_sessions_user_assurance_idx
  on customer_sessions (user_id, status, expires_at desc)
  where shared_auth_session_id is not null;

alter table customer_sessions
  drop constraint if exists customer_sessions_assurance_level_chk;
alter table customer_sessions
  add constraint customer_sessions_assurance_level_chk
    check (assurance_level in ('aal1', 'aal2'))
    not valid;
alter table customer_sessions
  validate constraint customer_sessions_assurance_level_chk;

alter table customer_sessions
  drop constraint if exists customer_sessions_shared_auth_assurance_chk;
alter table customer_sessions
  add constraint customer_sessions_shared_auth_assurance_chk check (
    (
      shared_auth_session_id is null
      and provider_project is null
      and assurance_level = 'aal1'
      and assurance_verified_at is null
      and expires_at is null
    )
    or
    (
      shared_auth_session_id is not null
      and provider_project = 'fiducia-customer'
      and assurance_level = 'aal2'
      and assurance_verified_at is not null
      and expires_at is not null
      and expires_at > assurance_verified_at
      and status in ('verified', 'revoked')
    )
  ) not valid;
alter table customer_sessions
  validate constraint customer_sessions_shared_auth_assurance_chk;

commit;
