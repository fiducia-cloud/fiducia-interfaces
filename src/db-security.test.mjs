import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../', import.meta.url);

test('customer SQL keeps verifier hashes and backend-only tables off browser roles', async () => {
  const sql = await readFile(new URL('sql/customer.sql', root), 'utf8');

  assert.match(sql, /alter publication supabase_realtime drop table public\.api_keys/);
  assert.doesNotMatch(sql, /create policy api_keys_member_read/);
  assert.match(
    sql,
    /require_idempotency boolean(?: not null default true| default true not null)/,
  );
  assert.match(sql, /request_fingerprint varchar\(64\)/);
  assert.match(
    sql,
    /customer_sync_idempotency_request_fingerprint_chk[\s\S]*request_fingerprint is null or request_fingerprint ~ '\^\[0-9a-f\]\{64\}\$'/,
    'customer idempotency keys bind requests while legacy NULL rows remain distinguishable',
  );
  assert.match(
    sql,
    /customer_sync_idempotency_request_fingerprint_required[\s\S]*check \(request_fingerprint is not null\)[\s\S]*not valid/,
    'new customer ledger rows cannot omit their request binding',
  );
  assert.match(sql, /create table if not exists sync_clock/);
  assert.match(sql, /create table if not exists sync_tombstones/);
  assert.match(sql, /tenant_id uuid,[\s\S]*owner_user_id uuid/);
  assert.match(sql, /create trigger orgs_bump before insert or update/);
  assert.match(
    sql,
    /new := jsonb_populate_record\([\s\S]*to_jsonb\(old\) -> 'created_at'/,
    'sync updates preserve server-owned created_at',
  );
  assert.match(
    sql,
    /new\.updated_at := greatest\([\s\S]*old\.updated_at \+ interval '1 microsecond'/,
    'sync updates advance updated_at strictly even inside one transaction',
  );
  assert.match(sql, /else\s+new\.version := 1;/);
  assert.match(sql, /create trigger orgs_sync_clock_guard before insert or update or delete/);
  assert.match(sql, /create trigger users_sync_clock_guard before delete on users/);
  assert.match(sql, /create trigger customer_preferences_tombstone after delete/);
  assert.match(sql, /on projects \(org_id, sync_sequence\)/);

  for (const table of [
    'users',
    'org_members',
    'project_members',
    'audit_log',
    'sync_idempotency_keys',
    'sync_clock',
    'sync_tombstones',
  ]) {
    assert.match(sql, new RegExp(`alter table ${table} enable row level security`));
    assert.match(
      sql,
      new RegExp(`revoke all privileges on table public\\.${table} from %I`),
    );
  }

  assert.match(sql, /security definer\s+set search_path = pg_catalog, public/);
  assert.match(sql, /revoke all privileges on table public\.api_keys from %I/);
});

test('admin SQL denies browser roles access to internal ledgers', async () => {
  const sql = await readFile(new URL('sql/admin.sql', root), 'utf8');

  for (const table of [
    'admin_audit_log',
    'sync_idempotency_keys',
    'sync_clock',
    'sync_tombstones',
  ]) {
    assert.match(sql, new RegExp(`alter table ${table} enable row level security`));
    assert.match(
      sql,
      new RegExp(`revoke all privileges on table public\\.${table} from %I`),
    );
  }

  assert.match(
    sql,
    /request_fingerprint varchar\(64\)/,
    'admin idempotency keys bind to a canonical request digest',
  );
  assert.match(
    sql,
    /alter table sync_idempotency_keys\s+add column if not exists request_fingerprint varchar\(64\)/,
    'existing admin databases receive the fingerprint column idempotently',
  );
  assert.match(
    sql,
    /check \(request_fingerprint is null or request_fingerprint ~ '\^\[0-9a-f\]\{64\}\$'\)/,
    'new ledger values accept only canonical lowercase SHA-256 fingerprints',
  );
  assert.match(
    sql,
    /sync_idempotency_request_fingerprint_required[\s\S]*check \(request_fingerprint is not null\)[\s\S]*not valid/,
    'new admin ledger rows cannot omit their request binding',
  );
  assert.match(sql, /create table if not exists sync_clock/);
  assert.match(sql, /create table if not exists sync_tombstones/);
  assert.match(sql, /create trigger infra_operations_bump before insert or update/);
  assert.match(
    sql,
    /new := jsonb_populate_record\([\s\S]*to_jsonb\(old\) -> 'created_at'/,
    'admin sync updates preserve server-owned created_at',
  );
  assert.match(
    sql,
    /new\.updated_at := greatest\([\s\S]*old\.updated_at \+ interval '1 microsecond'/,
    'admin sync updates advance updated_at strictly',
  );
  assert.match(
    sql,
    /create trigger infra_operations_sync_clock_guard before insert or update or delete/,
  );
  assert.match(sql, /create trigger infra_operations_tombstone after delete/);
  assert.match(sql, /on infra_operations \(sync_sequence\)/);
  assert.match(
    sql,
    /update public\.sync_clock[\s\S]*returning last_sequence into allocated/,
    'global cursor allocation is transactional rather than a non-transactional sequence',
  );
});
