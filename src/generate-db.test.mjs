import assert from "node:assert/strict";
import { test } from "node:test";
import { parseTables, baseType, structName } from "./generate-db.mjs";

test("parseTables extracts columns and skips constraints, with correct nullability", () => {
  const sql = `
create table if not exists widgets (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs (id) on delete cascade,
  note varchar(200),
  count integer default 0 not null,
  version bigint default 1 not null,
  constraint widgets_note_chk check (note is not null)
);`;
  const [t] = parseTables(sql);
  assert.equal(t.name, "widgets");
  const byName = Object.fromEntries(t.columns.map((c) => [c.name, c]));
  // The constraint line must NOT be treated as a column.
  assert.deepEqual(Object.keys(byName), ["id", "org_id", "note", "count", "version"]);
  assert.equal(byName.id.nullable, false); // primary key
  assert.equal(byName.org_id.nullable, false); // not null
  assert.equal(byName.note.nullable, true); // no not null
  assert.equal(byName.count.nullable, false);
  assert.equal(byName.version.nullable, false);
});

test("baseType maps the postgres types used in the schemas", () => {
  assert.equal(baseType("uuid"), "uuid");
  assert.equal(baseType("varchar(120)"), "string");
  assert.equal(baseType("text"), "string");
  assert.equal(baseType("timestamptz"), "timestamp");
  assert.equal(baseType("bigint"), "i64");
  assert.equal(baseType("integer"), "i32");
  assert.equal(baseType("boolean"), "bool");
  assert.equal(baseType("jsonb"), "json");
  assert.equal(baseType("inet"), "inet");
  assert.equal(baseType("vector(1536)"), "vector");
});

test("structName pascalizes the table and adds a Row suffix", () => {
  assert.equal(structName("api_keys"), "ApiKeysRow");
  assert.equal(structName("customer_preferences"), "CustomerPreferencesRow");
  assert.equal(structName("orgs"), "OrgsRow");
});
