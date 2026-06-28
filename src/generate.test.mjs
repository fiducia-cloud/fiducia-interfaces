// Self-tests for the generator. No file writes, no network.
//   node --test src/*.test.mjs

import assert from "node:assert/strict";
import { test } from "node:test";

import { build, loadTypes, pascal, oneLine, refName, isStringEnum, enumTypeName, collectEnums } from "./generate.mjs";

test("helpers", () => {
  assert.equal(pascal("not_leader"), "NotLeader");
  assert.equal(pascal("ttl_ms"), "TtlMs");
  assert.equal(oneLine("a\n  b   c"), "a b c");
  assert.equal(refName({ $ref: "#/$defs/KvEntry" }), "KvEntry");
  assert.equal(refName({ type: "string" }), null);
  assert.equal(enumTypeName("ProposeError", "reason"), "ProposeErrorReason");
  assert.equal(isStringEnum({ type: "string", enum: ["a"] }), true);
  assert.equal(isStringEnum({ type: "string" }), false);
});

test("loadTypes parses the real schemas without error", () => {
  const types = loadTypes();
  const names = types.map((t) => t.name);
  for (const expected of ["ProposeOutcome", "KvEntry", "LockGrant", "LockAcquireManyRequest", "LockReleaseManyRequest", "RateLimitCheckRequest", "ScheduleUpsertRequest", "Leadership", "ServiceInstance"]) {
    assert.ok(names.includes(expected), `missing ${expected}`);
  }
  const outcome = types.find((t) => t.name === "ProposeOutcome");
  assert.deepEqual(outcome.props.map((p) => p.name).sort(), ["log_index", "revision", "shard"]);
});

test("string enums are collected and typed", () => {
  const enums = collectEnums(loadTypes());
  assert.deepEqual(enums.get("ProposeErrorReason"), ["not_leader", "unavailable"]);
});

test("rust output: struct, optional fields, and a typed enum", () => {
  const rust = build()["rust/src/lib.rs"];
  assert.match(rust, /pub struct ProposeOutcome \{/);
  assert.match(rust, /pub struct LockHolder \{/);
  assert.match(rust, /pub struct RateLimitSnapshot \{/);
  assert.match(rust, /pub struct ScheduleRun \{/);
  assert.match(rust, /pub enum ProposeErrorReason \{/);
  assert.match(rust, /skip_serializing_if = "Option::is_none"/); // optional handling
  assert.match(rust, /pub reason: ProposeErrorReason,/);          // field uses the enum
  assert.match(rust, /pub metadata: Option<std::collections::BTreeMap<String, String>>,/);
  assert.match(rust, /pub fencing_tokens: Option<std::collections::BTreeMap<String, i64>>,/);
});

test("typescript output: union for enum, optional marker", () => {
  const ts = build()["typescript/index.ts"];
  assert.match(ts, /reason: "not_leader" \| "unavailable";/);
  assert.match(ts, /metadata\?: Record<string, string>;/);
  assert.match(ts, /fencing_tokens\?: Record<string, number>;/);
  assert.match(ts, /algorithm: "token_bucket" \| "sliding_window";/);
  assert.match(ts, /delivery\?: "at_least_once" \| "exactly_once";/);
  assert.match(ts, /ttl_ms\?: number;/);
});

test("python output: Literal + Optional ordering compiles", () => {
  const py = build()["python/fiducia_interfaces.py"];
  assert.match(py, /reason: Literal\["not_leader", "unavailable"\]/);
  assert.match(py, /from typing import List, Optional, Dict, Literal/);
  assert.match(py, /metadata: Optional\[Dict\[str, str\]\] = None/);
  assert.match(py, /fencing_tokens: Optional\[Dict\[str, int\]\] = None/);
});

test("go output: pointer+omitempty for optional, json tags", () => {
  const go = build()["go/interfaces.go"];
  assert.match(go, /Shard int64 `json:"shard"`/);
  assert.match(go, /TtlMs \*int64 `json:"ttl_ms,omitempty"`/);
  assert.match(go, /Metadata \*map\[string\]string `json:"metadata,omitempty"`/);
  assert.match(go, /FencingTokens \*map\[string\]int64 `json:"fencing_tokens,omitempty"`/);
});
