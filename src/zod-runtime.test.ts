import assert from "node:assert/strict";
import test from "node:test";

import {
  SyncChangeEventSchema,
  SyncReplicaMetadataSchema,
  SyncWritePolicySchema,
} from "../generated/typescript/zod.ts";

test("Zod validates sync IO from the canonical JSON Schema", () => {
  assert.deepEqual(
    SyncWritePolicySchema.parse({
      strategy: "optimistic",
      failure_mode: "throw_error",
      telemetry: "lifecycle",
    }),
    {
      strategy: "optimistic",
      failure_mode: "throw_error",
      telemetry: "lifecycle",
    },
  );

  assert.throws(() =>
    SyncWritePolicySchema.parse({
      strategy: "sometimes_optimistic",
      failure_mode: "return_result",
      telemetry: "errors",
    }),
  );
  assert.throws(() =>
    SyncChangeEventSchema.parse({
      table: "items",
      op: "upsert",
      id: "one",
      version: Number.MAX_SAFE_INTEGER + 1,
      row: {},
      at_ms: 1,
    }),
  );
  assert.throws(() =>
    SyncReplicaMetadataSchema.parse({
      version: 1,
      dirty: false,
      created_at_ms: 10,
      updated_at_ms: 9,
      unknown: true,
    }),
  );
});
