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
});
