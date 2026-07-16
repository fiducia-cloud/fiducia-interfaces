// Cross-language wire parity: fixtures/lock-payloads.json is ONE source of
// truth decoded by every language suite. The Rust side is
// generated/rust/tests/lock_payloads.rs; this is the JS/TS side, validating
// each fixture entry against the same schemas the generators consume.
//   node --test src/*.test.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { loadTypes, refName, isStringEnum } from "./generate.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = JSON.parse(
  fs.readFileSync(path.join(here, "..", "fixtures", "lock-payloads.json"), "utf8"),
);

/** Decode `value` as schema type `typeName`: unknown fields, missing required
 * fields, wrong primitive types, and out-of-enum strings all throw. */
function decode(types, typeName, value, at = typeName) {
  const type = types.find((t) => t.name === typeName);
  assert.ok(type, `fixture names unknown schema type ${typeName}`);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${at}: expected an object`);
  }
  const known = new Set(type.props.map((p) => p.name));
  for (const key of Object.keys(value)) {
    if (!known.has(key)) throw new Error(`${at}.${key}: unknown field`);
  }
  for (const prop of type.props) {
    const has = Object.hasOwn(value, prop.name);
    if (!has) {
      if (prop.required) throw new Error(`${at}.${prop.name}: missing required field`);
      continue;
    }
    const v = value[prop.name];
    const where = `${at}.${prop.name}`;
    const ref = refName(prop.schema);
    if (ref) {
      decode(types, ref, v, where);
      continue;
    }
    const declared = prop.schema.type;
    if (declared === "string" && typeof v !== "string") throw new Error(`${where}: expected string`);
    if (declared === "integer" && !Number.isInteger(v)) throw new Error(`${where}: expected integer`);
    if (declared === "boolean" && typeof v !== "boolean") throw new Error(`${where}: expected boolean`);
    if (declared === "array" && !Array.isArray(v)) throw new Error(`${where}: expected array`);
    if (isStringEnum(prop.schema) && !prop.schema.enum.includes(v)) {
      throw new Error(`${where}: ${JSON.stringify(v)} not in ${prop.schema.enum.join("|")}`);
    }
  }
  return value;
}

test("every valid shared-fixture payload decodes against the schema source of truth", () => {
  const types = loadTypes();
  const valid = fixtures.valid;
  assert.ok(Object.keys(valid).length >= 2, "fixture must cover lock AND propose payloads");
  for (const [typeName, entries] of Object.entries(valid)) {
    assert.ok(Array.isArray(entries) && entries.length > 0, `${typeName}: no entries`);
    for (const [i, entry] of entries.entries()) {
      assert.doesNotThrow(
        () => decode(types, typeName, entry),
        `valid ${typeName}[${i}] must decode`,
      );
    }
  }
  // Field fidelity, not just decodability: the first acquire entry keeps its keys.
  assert.deepEqual(valid.LockAcquireManyRequest[0].keys, ["orders/42", "inventory/sku-7"]);
  assert.equal(valid.DecisionProposeRequest[0].policy.kind, "plurality");
});

test("invalid shared-fixture payloads (missing required field) are rejected", () => {
  const types = loadTypes();
  const invalid = fixtures.invalid.LockAcquireManyRequest;
  assert.ok(Array.isArray(invalid) && invalid.length > 0, "fixture must carry invalid entries");
  for (const entry of invalid) {
    assert.throws(
      () => decode(types, "LockAcquireManyRequest", entry),
      /keys: missing required field/,
      "a payload without `keys` must NOT decode",
    );
  }
});
