import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../', import.meta.url);

test('customer SQL keeps verifier hashes and backend-only tables off browser roles', async () => {
  const sql = await readFile(new URL('sql/customer.sql', root), 'utf8');

  assert.match(sql, /alter publication supabase_realtime drop table public\.api_keys/);
  assert.doesNotMatch(sql, /create policy api_keys_member_read/);

  for (const table of [
    'users',
    'org_members',
    'project_members',
    'audit_log',
    'sync_idempotency_keys',
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

  for (const table of ['admin_audit_log', 'sync_idempotency_keys']) {
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
});
