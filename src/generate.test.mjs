// Self-tests for the generator. No file writes, no network.
//   node --test src/*.test.mjs

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
  for (const expected of ["ProposeOutcome", "KvEntry", "LockAcquireRequest", "LockAcquireResponse", "LockRenewRequest", "LockRenewResponse", "LockReleaseRequest", "LockReleaseResponse", "LockCancelRequest", "LockCancelResponse", "SemaphoreAcquireRequest", "SemaphoreAcquireResponse", "SemaphoreRenewRequest", "SemaphoreRenewResponse", "SemaphoreReleaseRequest", "SemaphoreReleaseResponse", "SemaphoreCancelRequest", "SemaphoreCancelResponse", "LockGrant", "LockAcquireManyRequest", "LockReleaseManyRequest", "FileLeaseAcquireRequest", "FileLeaseRenewRequest", "FileLeaseReleaseRequest", "FileLeaseQuery", "RateLimitCheckRequest", "ScheduleUpsertRequest", "Leadership", "ServiceInstance", "IdempotencyClaimRequest", "IdempotencyCompleteRequest", "IdempotencyRecord"]) {
    assert.ok(names.includes(expected), `missing ${expected}`);
  }
  const outcome = types.find((t) => t.name === "ProposeOutcome");
  assert.deepEqual(outcome.props.map((p) => p.name).sort(), ["log_index", "output", "revision", "shard"]);
});

test("lock and semaphore contracts expose durable waits and token-bound lifecycle operations", () => {
  const types = loadTypes();
  const byName = (name) => types.find((type) => type.name === name);
  const required = (name) => byName(name).props.filter((prop) => prop.required).map((prop) => prop.name);
  const field = (name, property) => byName(name).props.find((prop) => prop.name === property).schema;

  assert.deepEqual(required("LockAcquireRequest"), ["holder"]);
  assert.deepEqual(required("LockAcquireManyRequest"), ["keys", "holder"]);
  assert.equal(field("LockAcquireRequest", "holder").minLength, 1);
  assert.equal(field("LockAcquireRequest", "ttl_ms").minimum, 1);
  assert.equal(field("LockAcquireRequest", "wait_timeout_ms").maximum, 86_400_000);
  assert.equal(field("LockRenewRequest", "fencing_token").minimum, 1);
  assert.ok(byName("LockAcquireResponse").props.some((prop) => prop.name === "wait_expires_ms"));
  assert.deepEqual(field("LockAcquireResponse", "position").type, ["integer", "null"]);
  assert.deepEqual(required("SemaphoreAcquireRequest"), ["key", "holder", "limit"]);
  assert.equal(field("SemaphoreRenewRequest", "fencing_token").minimum, 1);
  assert.deepEqual(field("SemaphoreAcquireResponse", "reason").enum, ["limit_mismatch"]);
  assert.equal(field("SemaphoreAcquireResponse", "requested_limit").minimum, 1);
  assert.ok(byName("SemaphoreCancelResponse").props.some((prop) => prop.name === "lease_expires_ms"));
  assert.match(field("FileLeaseAcquireRequest", "repository").pattern, /\//);
});

test("idempotency schema exposes claim, complete, record, and lookup payloads", () => {
  const types = loadTypes().filter((t) => t.name.startsWith("Idempotency"));

  assert.deepEqual(types.map((t) => t.name), [
    "IdempotencyClaimRequest",
    "IdempotencyCompleteRequest",
    "IdempotencyRecord",
    "IdempotencyGetResponse",
  ]);
  assert.deepEqual(
    types.find((t) => t.name === "IdempotencyCompleteRequest").props
      .filter((p) => p.required)
      .map((p) => p.name),
    ["key", "owner", "fencing_token"],
  );
});

test("KV schema exposes protection metadata and explicit plaintext opt-out", () => {
  const types = loadTypes();
  const protection = types.find((type) => type.name === "KvProtection");
  const put = types.find((type) => type.name === "KvPutRequest");
  const get = types.find((type) => type.name === "KvGetResponse");

  assert.ok(protection, "missing KvProtection");
  assert.deepEqual(
    protection.props.map((prop) => prop.name),
    ["at_rest", "provider", "key_id", "key_version"],
  );
  assert.equal(put.props.find((prop) => prop.name === "plaintext").required, false);
  assert.equal(get.props.find((prop) => prop.name === "protection").required, false);
  const enums = collectEnums(types);
  assert.deepEqual(enums.get("KvProtectionAtRest"), ["encrypted", "plaintext"]);
  assert.deepEqual(enums.get("KvProtectionProvider"), [
    "local_keyring",
    "local_keyring_legacy",
    "vault_transit",
  ]);
});

test("string enums are collected and typed", () => {
  const enums = collectEnums(loadTypes());
  assert.deepEqual(enums.get("ProposeErrorReason"), ["not_leader", "unavailable"]);
  assert.deepEqual(enums.get("IdempotencyRecordStatus"), ["claimed", "completed"]);
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
  assert.match(rust, /pub struct LockCancelResponse \{/);
  assert.match(rust, /pub wait_expires_ms: Option<i64>,/);
  assert.doesNotMatch(rust, /Option<Option<i64>>/);
  assert.match(rust, /#\[deprecated\(\n\s+note = "Deprecated compatibility shape/);
});

test("rust-wasm output: callable Tsify ABI with JSON-compatible maps", () => {
  const out = build();
  const wasm = out["rust-wasm/src/lib.rs"];
  assert.match(wasm, /use tsify::Tsify;/);
  assert.match(wasm, /use wasm_bindgen::prelude::\*;/);
  assert.match(wasm, /#\[derive\(Debug, Clone, Serialize, Deserialize, Tsify\)\]/);
  assert.match(wasm, /#\[tsify\(into_wasm_abi, from_wasm_abi, hashmap_as_object\)\]/);
  assert.match(wasm, /pub struct ProposeOutcome \{/);
  assert.match(wasm, /pub enum ProposeErrorReason \{/);
  // Type bodies must not drift from the plain rust crate.
  assert.match(wasm, /pub metadata: Option<std::collections::BTreeMap<String, String>>,/);
  const cargo = out["rust-wasm/Cargo.toml"];
  assert.match(cargo, /crate-type = \["cdylib", "rlib"\]/);
  assert.match(cargo, /wasm-bindgen = /);
  assert.match(cargo, /tsify = \{ version = "0\.5", features = \["js"\] \}/);
});

test("rust and rust-wasm never diverge in data shape (same structs + fields)", () => {
  const out = build();
  const pubLines = (s) => s
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("pub ") && !line.startsWith("pub mod "));
  // Same `pub struct`, `pub enum`, and `pub field: Type` lines in both crates —
  // only attributes/derives differ. Guarantees the wasm build stays in lockstep.
  assert.deepEqual(pubLines(out["rust-wasm/src/lib.rs"]), pubLines(out["rust/src/lib.rs"]));
});

test("rust-wasm pins map/Value fields to the same TS the typescript emitter uses", () => {
  const out = build();
  const wasm = out["rust-wasm/src/lib.rs"];
  // serde_json::Value must not reach tsify raw (it would emit an undefined `Value`);
  // maps must be Record, not tsify's default `Map`.
  assert.match(wasm, /#\[tsify\(type = "Record<string, unknown>"\)\]\n\s*pub result: Option<serde_json::Value>,/);
  assert.match(wasm, /#\[tsify\(type = "Record<string, string>"\)\]\n\s*pub metadata: Option<std::collections::BTreeMap<String, String>>,/);
  // The container-level serializer option makes the runtime ABI use ordinary
  // JavaScript objects too, matching those field-level TypeScript declarations.
  assert.match(wasm, /#\[tsify\(into_wasm_abi, from_wasm_abi, hashmap_as_object\)\]/);
  // Every serde_json::Value / BTreeMap field must be immediately preceded by a
  // tsify override — none may reach the .d.ts with tsify's broken default.
  const lines = wasm.split("\n");
  lines.forEach((line, i) => {
    if (/pub .*(serde_json::Value|BTreeMap)/.test(line)) {
      assert.match(lines[i - 1] || "", /#\[tsify\(type = /, `unguarded field: ${line.trim()}`);
    }
  });
});

test("typescript output: union for enum, optional marker", () => {
  const ts = build()["typescript/index.ts"];
  assert.match(ts, /reason: "not_leader" \| "unavailable";/);
  assert.match(ts, /metadata\?: Record<string, string>;/);
  assert.match(ts, /fencing_tokens\?: Record<string, number>;/);
  assert.match(ts, /algorithm: "token_bucket" \| "sliding_window";/);
  assert.match(ts, /delivery\?: "at_least_once" \| "exactly_once";/);
  assert.match(ts, /ttl_ms\?: number;/);
  assert.match(ts, /export type SemaphoreRenewRequest = \{/);
  assert.match(ts, /wait_expires_ms\?: number \| null;/);
  assert.match(ts, /position\?: number \| null;/);
  assert.match(ts, /\/\*\* @deprecated Deprecated compatibility shape/);
});

test("idempotency output is generated for every supported language", () => {
  const output = build();

  assert.match(output["rust/src/lib.rs"], /pub struct IdempotencyCompleteRequest \{/);
  assert.match(output["typescript/index.ts"], /export type IdempotencyGetResponse = \{/);
  assert.match(output["python/fiducia_interfaces.py"], /class IdempotencyRecord:/);
  assert.match(output["go/interfaces.go"], /type IdempotencyClaimRequest struct \{/);
});

test("sync envelopes are generated consistently for every supported language", () => {
  const output = build();

  assert.match(output["rust/src/lib.rs"], /pub struct SyncChangeEvent \{/);
  assert.match(output["rust/src/lib.rs"], /pub struct SyncPullPage \{/);
  assert.match(output["typescript/index.ts"], /export type SyncQueuedWrite = \{/);
  assert.match(output["typescript/index.ts"], /export type SyncWriteAcknowledgement = \{/);
  assert.match(output["python/fiducia_interfaces.py"], /class SyncChangeEvent:/);
  assert.match(output["python/fiducia_interfaces.py"], /class SyncPullPage:/);
  assert.match(output["go/interfaces.go"], /type SyncQueuedWrite struct \{/);
  assert.match(output["go/interfaces.go"], /type SyncWriteAcknowledgement struct \{/);
  assert.match(output["dart/lib/fiducia_interfaces.dart"], /final class SyncChangeEvent \{/);
  assert.match(output["dart/lib/fiducia_interfaces.dart"], /final class SyncWritePolicy \{/);
  assert.match(output["typescript/zod.ts"], /export const SyncWritePolicySchema/);
  assert.match(output["rust/src/validation.rs"], /impl ValidatedJson for crate::SyncWritePolicy/);
});

test("idempotency completion result remains optional JSON in generated clients", () => {
  const output = build();

  assert.match(output["rust/src/lib.rs"], /pub result: Option<serde_json::Value>,/);
  assert.match(output["typescript/index.ts"], /result\?: Record<string, unknown>;/);
  assert.match(output["python/fiducia_interfaces.py"], /result: Optional\[dict\] = None/);
  assert.match(output["go/interfaces.go"], /Result \*map\[string\]any `json:"result,omitempty"`/);
});

test("python output: Literal + Optional ordering compiles", () => {
  const py = build()["python/fiducia_interfaces.py"];
  assert.match(py, /reason: Literal\["not_leader", "unavailable"\]/);
  assert.match(py, /from typing import List, Optional, Dict, Literal/);
  assert.match(py, /metadata: Optional\[Dict\[str, str\]\] = None/);
  assert.match(py, /fencing_tokens: Optional\[Dict\[str, int\]\] = None/);
  assert.match(py, /# JSON field: from\n\s+from_: str = dataclass_field\(metadata=\{"wire_name": "from"\}\)/);
  assert.match(py, /def to_wire\(value\):/);
  assert.match(py, /output\[info\.metadata\.get\("wire_name", info\.name\)\] = to_wire\(item\)/);
});

test("python to_wire restores keyword aliases and omits optional None", () => {
  const script = `
import importlib.util, sys
spec = importlib.util.spec_from_file_location("fi", "generated/python/fiducia_interfaces.py")
module = importlib.util.module_from_spec(spec)
sys.modules["fi"] = module
spec.loader.exec_module(module)
value = module.HandoffOfferRequest(name="handoff", resource="repo", from_="worker-a", to="worker-b", from_token=7)
wire = module.to_wire(value)
assert wire["from"] == "worker-a"
assert "from_" not in wire
assert wire["from_token"] == 7
`;
  const result = spawnSync("python3", ["-c", script], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});

test("lock attempt ids and file-lease renewal generate in every language", () => {
  const output = build();

  assert.match(output["rust/src/lib.rs"], /pub request_id: Option<String>,/);
  assert.match(output["rust/src/lib.rs"], /pub struct FileLeaseRenewRequest \{/);
  assert.match(output["typescript/index.ts"], /export type FileLeaseRenewRequest = \{/);
  assert.match(output["python/fiducia_interfaces.py"], /class FileLeaseRenewRequest:/);
  assert.match(output["go/interfaces.go"], /type FileLeaseRenewRequest struct \{/);
});

test("go output: pointer+omitempty for optional, json tags", () => {
  const go = build()["go/interfaces.go"];
  assert.match(go, /Shard int64 `json:"shard"`/);
  assert.match(go, /TtlMs \*int64 `json:"ttl_ms,omitempty"`/);
  assert.match(go, /Metadata \*map\[string\]string `json:"metadata,omitempty"`/);
  assert.match(go, /FencingTokens \*map\[string\]int64 `json:"fencing_tokens,omitempty"`/);
});
