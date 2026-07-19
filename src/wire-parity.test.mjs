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

import { loadTypes, refName } from "./generate.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = JSON.parse(
  fs.readFileSync(path.join(here, "..", "fixtures", "lock-payloads.json"), "utf8"),
);

/** Validate the JSON-Schema subset used by this repository. This deliberately
 * covers bounds and composition as well as generated-type shape: generated
 * language types catch required fields, while the node enforces value bounds. */
function validateSchema(types, schema, value, at) {
  const ref = refName(schema);
  if (ref) return decode(types, ref, value, at);

  if (Array.isArray(schema.type) && schema.type.includes("null")) {
    if (value === null) return value;
    schema = { ...schema, type: schema.type.find((candidate) => candidate !== "null") };
  }
  if (Object.hasOwn(schema, "const") && value !== schema.const) {
    throw new Error(`${at}: expected constant ${JSON.stringify(schema.const)}`);
  }

  if (schema.required) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error(`${at}: expected an object`);
    }
    for (const name of schema.required) {
      if (!Object.hasOwn(value, name)) throw new Error(`${at}.${name}: missing required field`);
    }
  }
  if (schema.anyOf) {
    const matched = schema.anyOf.some((candidate) => {
      try {
        validateSchema(types, candidate, value, at);
        return true;
      } catch {
        return false;
      }
    });
    if (!matched) throw new Error(`${at}: did not match any allowed shape`);
  }
  if (schema.oneOf) {
    const matches = schema.oneOf.filter((candidate) => {
      try {
        validateSchema(types, candidate, value, at);
        return true;
      } catch {
        return false;
      }
    }).length;
    if (matches !== 1) throw new Error(`${at}: matched ${matches} oneOf shapes`);
  }
  if (schema.allOf) {
    schema.allOf.forEach((candidate) => validateSchema(types, candidate, value, at));
  }
  if (schema.if) {
    let condition = true;
    try {
      validateSchema(types, schema.if, value, at);
    } catch {
      condition = false;
    }
    if (condition && schema.then) validateSchema(types, schema.then, value, at);
    if (!condition && schema.else) validateSchema(types, schema.else, value, at);
  }
  if (schema.not) {
    let matched = true;
    try {
      validateSchema(types, schema.not, value, at);
    } catch {
      matched = false;
    }
    if (matched) throw new Error(`${at}: matched a forbidden shape`);
  }
  // Composition branches commonly constrain selected object properties without
  // repeating `type: object`; validate those present properties here.
  if (schema.type !== "object" && schema.properties && typeof value === "object" && value !== null && !Array.isArray(value)) {
    for (const [name, childSchema] of Object.entries(schema.properties)) {
      if (Object.hasOwn(value, name)) validateSchema(types, childSchema, value[name], `${at}.${name}`);
    }
  }

  switch (schema.type) {
    case "object": {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error(`${at}: expected an object`);
      }
      const properties = schema.properties || {};
      for (const [name, child] of Object.entries(value)) {
        if (Object.hasOwn(properties, name)) {
          validateSchema(types, properties[name], child, `${at}.${name}`);
        } else if (schema.additionalProperties === false) {
          throw new Error(`${at}.${name}: unknown field`);
        } else if (typeof schema.additionalProperties === "object") {
          validateSchema(types, schema.additionalProperties, child, `${at}.${name}`);
        }
      }
      break;
    }
    case "array": {
      if (!Array.isArray(value)) throw new Error(`${at}: expected array`);
      if (schema.minItems !== undefined && value.length < schema.minItems) {
        throw new Error(`${at}: expected at least ${schema.minItems} items`);
      }
      if (schema.maxItems !== undefined && value.length > schema.maxItems) {
        throw new Error(`${at}: expected at most ${schema.maxItems} items`);
      }
      if (schema.uniqueItems && new Set(value.map((item) => JSON.stringify(item))).size !== value.length) {
        throw new Error(`${at}: expected unique items`);
      }
      value.forEach((item, index) => validateSchema(types, schema.items || {}, item, `${at}[${index}]`));
      break;
    }
    case "string":
      if (typeof value !== "string") throw new Error(`${at}: expected string`);
      if (schema.minLength !== undefined && value.length < schema.minLength) {
        throw new Error(`${at}: shorter than ${schema.minLength}`);
      }
      if (schema.maxLength !== undefined && value.length > schema.maxLength) {
        throw new Error(`${at}: longer than ${schema.maxLength}`);
      }
      if (schema.pattern && !new RegExp(schema.pattern).test(value)) {
        throw new Error(`${at}: does not match ${schema.pattern}`);
      }
      break;
    case "integer":
      if (!Number.isInteger(value)) throw new Error(`${at}: expected integer`);
      if (schema.minimum !== undefined && value < schema.minimum) {
        throw new Error(`${at}: below minimum ${schema.minimum}`);
      }
      if (schema.maximum !== undefined && value > schema.maximum) {
        throw new Error(`${at}: above maximum ${schema.maximum}`);
      }
      break;
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${at}: expected number`);
      break;
    case "boolean":
      if (typeof value !== "boolean") throw new Error(`${at}: expected boolean`);
      break;
  }
  if (schema.enum && !schema.enum.includes(value)) {
    throw new Error(`${at}: ${JSON.stringify(value)} not in ${schema.enum.join("|")}`);
  }
  return value;
}

/** Decode `value` as schema type `typeName`; all schema violations throw. */
function decode(types, typeName, value, at = typeName) {
  const type = types.find((t) => t.name === typeName);
  assert.ok(type, `fixture names unknown schema type ${typeName}`);
  return validateSchema(types, type.schema, value, at);
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

test("invalid shared-fixture payloads with missing required fields are rejected", () => {
  const types = loadTypes();
  for (const [typeName, entries] of Object.entries(fixtures.invalid)) {
    assert.ok(Array.isArray(entries) && entries.length > 0, `${typeName}: no invalid entries`);
    for (const entry of entries) {
      assert.throws(() => decode(types, typeName, entry), /missing required field|allowed shape/);
    }
  }
});

test("schema bounds reject empty holders, zero leases/tokens, and non-canonical repositories", () => {
  const types = loadTypes();
  for (const [typeName, entries] of Object.entries(fixtures.schema_invalid)) {
    assert.ok(Array.isArray(entries) && entries.length > 0, `${typeName}: no boundary entries`);
    for (const entry of entries) {
      assert.throws(
        () => decode(types, typeName, entry),
        /shorter than|below minimum|allowed shape|does not match|missing required field|oneOf shapes|expected integer/,
        `${typeName} must reject ${JSON.stringify(entry)}`,
      );
    }
  }
});
