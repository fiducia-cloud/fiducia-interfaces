// Cross-source schema drift guard.
//
// The customer/admin plane tables are declared in TWO places today:
//   * canonical here — `sql/customer.sql`, `sql/admin.sql` (what services expect,
//     what generate-db.mjs turns into the row structs);
//   * a schema-qualified copy in the k8s-libs-and-shared-defs `pg-defs` repo
//     (`pg-defs/schema/schema.sql`, the `fiducia.*` section), which is what an
//     operator actually converges the managed database against.
//
// Nothing keeps the two in step, so a column added here but not there (or vice
// versa) ships a binary whose expectations the live database does not meet. This
// test fails when they diverge. It is the seam between fiducia and the external
// pg-defs source of truth — the "postgres is integrated with k8s-libs" contract.
//
// pg-defs is a separate repo, not a fiducia dependency, so this is a SOFT guard:
// it runs only when the schema is locatable (env override or a sibling checkout)
// and skips cleanly otherwise, so `npm test` stays green in a bare CI checkout.

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

import { parseTables, baseType } from "./generate-db.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");

/** Locate the pg-defs schema.sql, or null to skip. */
function findPgDefsSchema() {
  const explicit = process.env.FIDUCIA_PGDEFS_SCHEMA;
  if (explicit) return existsSync(explicit) ? explicit : null;
  // Common local layouts: ~/codes/ores/k8s-libs-and-shared-defs, or a sibling.
  const candidates = [
    join(process.env.HOME ?? "", "codes/ores/k8s-libs-and-shared-defs/pg-defs/schema/schema.sql"),
    resolve(repoRoot, "../k8s-libs-and-shared-defs/pg-defs/schema/schema.sql"),
    resolve(repoRoot, "../../ores/k8s-libs-and-shared-defs/pg-defs/schema/schema.sql"),
  ];
  return candidates.find((p) => p && existsSync(p)) ?? null;
}

// pg-defs' `fiducia.*` section mirrors ONLY the customer plane (the app.fiducia.cloud
// webapp DB). The admin plane is a separate, isolated database with no pg-defs
// copy, and it reuses table names (sync_tombstones, sync_clock, …) with a
// different single-tenant shape — so comparing it here would be meaningless.
// Guard the customer plane; the admin↔pg-defs gap is tracked separately.
const PLANES = ["customer.sql"];

// Known, accepted divergences between fiducia sql/customer.sql and the pg-defs
// copy, pending a decision on which source wins (see the report). The guard
// tolerates exactly these and fails on anything NEW, so drift can't grow
// silently while the known items are reconciled. Format: "table.column: reason".
const ACCEPTED_DRIFT = new Set([
  // fiducia stores the raw IP as `inet` (generate-db casts via ::text on read);
  // pg-defs widened it to varchar(64). Same data, different decode path.
  "audit_log.source_ip",
  // fiducia added request_fingerprint as a nullable ALTER (old rows have null);
  // pg-defs declares it NOT NULL + a hex-format CHECK. Reconcile before enforcing.
  "sync_idempotency_keys.request_fingerprint",
]);

/**
 * Parse the `fiducia.` section of a pg-defs dump into the same table shape
 * `parseTables` yields for our own SQL. `parseTables` only matches bare
 * `create table if not exists <ident>`, so strip the schema qualifier first;
 * that also collapses `references fiducia.x` in constraint lines, which the
 * column parser already ignores.
 */
function parsePgDefsFiducia(sql) {
  const stripped = sql.replace(/\bfiducia\./g, "");
  return parseTables(stripped);
}

function columnMap(table) {
  return new Map(table.columns.map((c) => [c.name, c]));
}

test("fiducia SQL tables match the k8s-libs pg-defs fiducia schema (no drift)", (t) => {
  const schemaPath = findPgDefsSchema();
  if (!schemaPath) {
    t.skip(
      "pg-defs schema not found — set FIDUCIA_PGDEFS_SCHEMA or check out " +
        "k8s-libs-and-shared-defs beside this repo to enable the cross-source drift guard",
    );
    return;
  }

  const pgDefs = parsePgDefsFiducia(readFileSync(schemaPath, "utf8"));
  const pgDefsByName = new Map(pgDefs.map((table) => [table.name, table]));

  // Sanity: we actually located the fiducia section, not an empty/renamed file.
  assert.ok(
    pgDefsByName.has("orgs") && pgDefsByName.has("users"),
    `pg-defs at ${schemaPath} has no recognizable fiducia section (orgs/users missing)`,
  );

  const problems = [];
  for (const plane of PLANES) {
    const ours = parseTables(readFileSync(join(repoRoot, "sql", plane), "utf8"));
    for (const table of ours) {
      const theirs = pgDefsByName.get(table.name);
      if (!theirs) {
        problems.push(`${plane}: table "${table.name}" is absent from pg-defs`);
        continue;
      }
      const oursCols = columnMap(table);
      const theirsCols = columnMap(theirs);
      for (const [name, col] of oursCols) {
        const other = theirsCols.get(name);
        if (!other) {
          problems.push(`${table.name}.${name} exists here but not in pg-defs`);
          continue;
        }
        // Compare the two facets that change row decoding: SQL base type and
        // nullability. (Defaults/constraints don't affect the generated struct.)
        if (baseType(col.sqlType) !== baseType(other.sqlType)) {
          problems.push(
            `${table.name}.${name} type drift: here ${col.sqlType} vs pg-defs ${other.sqlType}`,
          );
        }
        if (col.nullable !== other.nullable) {
          problems.push(
            `${table.name}.${name} nullability drift: here nullable=${col.nullable} vs pg-defs nullable=${other.nullable}`,
          );
        }
      }
      for (const name of theirsCols.keys()) {
        if (!oursCols.has(name)) {
          problems.push(`${table.name}.${name} exists in pg-defs but not here`);
        }
      }
    }
  }

  assert.deepEqual(
    problems,
    [],
    `schema drift between fiducia sql/ and pg-defs:\n  ${problems.join("\n  ")}`,
  );
});
