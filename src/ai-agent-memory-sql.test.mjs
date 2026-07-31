import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const sqlPath = path.resolve(here, "../sql/ai_agent_memory.sql");
const sql = fs.readFileSync(sqlPath, "utf8");

function normalized(value) {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

function tableNames(source) {
  return [...source.matchAll(/create table if not exists\s+(\w+)/gi)].map((match) => match[1]);
}

function tableBody(name) {
  const expression = new RegExp(`create table if not exists\\s+${name}\\s*\\(([\\s\\S]*?)\\n\\)\\s*;`, "i");
  const match = sql.match(expression);
  assert.ok(match, `missing table body for ${name}`);
  return normalized(match[1]);
}

const ddl = normalized(sql);
const tables = new Set(tableNames(sql));

const REQUIRED_TABLES = [
  "ai_memory_namespaces",
  "ai_memory_records",
  "ai_memory_embedding_models",
  "ai_memory_embeddings",
  "ai_memory_embedding_jobs",
  "ai_memory_claims",
  "ai_memory_claim_evidence",
  "ai_memory_edges",
  "ai_memory_tombstones",
  "ai_memory_access_audit",
];

test("governed AI memory schema contains every canonical subsystem", () => {
  for (const table of REQUIRED_TABLES) {
    assert.ok(tables.has(table), `missing ${table}`);
  }
  assert.match(ddl, /create extension if not exists vector/);
  assert.match(ddl, /embedding vector\(1536\) not null/);
  assert.match(ddl, /using hnsw \(embedding vector_cosine_ops\)/);
});

test("memory records preserve provenance, trust, validity, and sensitivity", () => {
  const records = tableBody("ai_memory_records");
  for (const column of [
    "source_execution_id",
    "author_agent_id",
    "source_model_provider",
    "source_model_name",
    "source_model_version",
    "content_digest",
    "trust_basis_points",
    "importance_basis_points",
    "sensitivity",
    "valid_from",
    "valid_until",
    "superseded_by",
  ]) {
    assert.match(records, new RegExp(`\\b${column}\\b`));
  }
  assert.match(records, /trust_basis_points between 0 and 10000/);
  assert.match(records, /importance_basis_points between 0 and 10000/);
  assert.doesNotMatch(records, /\bdeleted_at\b/);
  assert.doesNotMatch(records, /\bdeletion_generation\b/);
});

test("forgetting preserves digest lineage without retaining memory content", () => {
  const tombstones = tableBody("ai_memory_tombstones");
  assert.match(tombstones, /deleted_content_digest varchar\(128\) not null/);
  assert.match(tombstones, /deletion_generation bigint not null/);
  assert.match(tombstones, /deleted_by varchar\(320\) not null/);
  assert.doesNotMatch(tombstones, /\bcontent\b/);
  assert.doesNotMatch(tombstones, /\bvalue\b/);
  assert.match(ddl, /ai_memory_tombstones_generation_uq/);
  assert.match(ddl, /physically delete ai_memory_records/);
});

test("claim truth is governed rather than inferred from embeddings", () => {
  assert.match(ddl, /status in \('asserted','contested','resolved','superseded','expired'\)/);
  assert.match(ddl, /relation in \('support','contest','resolve','supersede'\)/);
  assert.match(ddl, /resolution_policy_version/);
  assert.match(ddl, /independence_key/);
  assert.match(ddl, /confidence_basis_points between 0 and 10000/);
  assert.match(ddl, /\(status = 'superseded'\) = \(superseded_by is not null\)/);
});

test("embedding reindex work is model-versioned and replay-safe", () => {
  for (const column of [
    "model_provider",
    "model_name",
    "model_version",
    "source_content_digest",
    "attempt",
    "available_at",
  ]) {
    assert.match(ddl, new RegExp(`\\b${column}\\b`));
  }
  assert.match(ddl, /primary key \(model_provider, model_name, model_version\)/);
  assert.match(ddl, /ai_memory_embedding_jobs_dedupe_uq/);
  assert.match(ddl, /status in \('pending','claimed','completed','failed','cancelled'\)/);
});

test("every relational memory path is structurally namespace-safe", () => {
  for (const constraint of [
    /foreign key \(superseded_by, namespace_id\) references ai_memory_records \(id, namespace_id\)/,
    /foreign key \(memory_id, namespace_id\) references ai_memory_records \(id, namespace_id\) on delete cascade/,
    /foreign key \(superseded_by, namespace_id\) references ai_memory_claims \(id, namespace_id\)/,
    /foreign key \(claim_id, namespace_id\) references ai_memory_claims \(id, namespace_id\) on delete cascade/,
    /foreign key \(from_memory_id, namespace_id\) references ai_memory_records \(id, namespace_id\) on delete cascade/,
    /foreign key \(to_memory_id, namespace_id\) references ai_memory_records \(id, namespace_id\) on delete cascade/,
    /foreign key \(replacement_memory_id, namespace_id\) references ai_memory_records \(id, namespace_id\) on delete restrict/,
  ]) {
    assert.match(ddl, constraint);
  }

  for (const table of [
    "ai_memory_embeddings",
    "ai_memory_embedding_jobs",
    "ai_memory_claim_evidence",
    "ai_memory_edges",
    "ai_memory_tombstones",
    "ai_memory_access_audit",
  ]) {
    assert.match(tableBody(table), /namespace_id uuid not null/);
  }
});

test("namespace policy and access decisions remain explicit and auditable", () => {
  assert.match(ddl, /read_policy jsonb/);
  assert.match(ddl, /write_policy jsonb/);
  assert.match(ddl, /retention_policy jsonb/);
  assert.match(ddl, /decision in \('allow','deny'\)/);
  assert.match(ddl, /reason_code/);
  assert.match(ddl, /policy_version/);
  assert.match(ddl, /query_digest/);
});

test("memory schema does not redefine authoritative coordination tables", () => {
  const forbidden = [
    "locks",
    "leases",
    "fencing_tokens",
    "elections",
    "barriers",
    "schedules",
    "semaphores",
  ];
  for (const table of forbidden) {
    assert.equal(tables.has(table), false, `memory schema must not own ${table}`);
  }
});
