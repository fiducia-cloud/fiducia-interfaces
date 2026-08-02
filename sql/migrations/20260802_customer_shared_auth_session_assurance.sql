-- Bind a Fiducia customer browser session to the Shared Auth session that was
-- issued only after the customer app completed the Supabase MFA flow.
--
-- Existing device rows remain ordinary aal1 observations with no Shared Auth
-- session binding. The application may authenticate a provider bearer directly,
-- but a Shared Auth browser cookie is accepted only when its `sid` matches one of
-- these verified, unexpired rows.

alter table customer_sessions
  add column if not exists shared_auth_session_id uuid,
  add column if not exists assurance_level varchar(16) not null default 'aal1',
  add column if not exists assurance_verified_at timestamptz,
  add column if not exists expires_at timestamptz;

create unique index if not exists customer_sessions_shared_auth_sid_uq
  on customer_sessions (shared_auth_session_id)
  where shared_auth_session_id is not null;

create index if not exists customer_sessions_user_assurance_idx
  on customer_sessions (user_id, status, expires_at desc)
  where shared_auth_session_id is not null;

alter table customer_sessions
  drop constraint if exists customer_sessions_assurance_level_chk,
  add constraint customer_sessions_assurance_level_chk
    check (assurance_level in ('aal1', 'aal2'));

alter table customer_sessions
  drop constraint if exists customer_sessions_shared_auth_assurance_chk,
  add constraint customer_sessions_shared_auth_assurance_chk check (
    (
      shared_auth_session_id is null
      and assurance_level = 'aal1'
      and assurance_verified_at is null
      and expires_at is null
    )
    or
    (
      shared_auth_session_id is not null
      and assurance_level = 'aal2'
      and assurance_verified_at is not null
      and expires_at is not null
      and expires_at > assurance_verified_at
      and status in ('verified', 'revoked')
    )
  );
