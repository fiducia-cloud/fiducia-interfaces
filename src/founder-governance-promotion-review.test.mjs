import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";

const root = new URL("../", import.meta.url);
const readJson = (path) => JSON.parse(readFileSync(new URL(path, root), "utf8"));

const promotion = readJson("design/founder-governance-promotion.json");
const review = readJson("design/founder-governance-promotion-review.json");

const dispositionPaths = review.artifact_dispositions.map((entry) => entry.path);
const dispositionByPath = new Map(
  review.artifact_dispositions.map((entry) => [entry.path, entry]),
);

test("DEN-474 records one explicit disposition for every pre-review design artifact", () => {
  assert.equal(review.contract_version, "1.0");
  assert.equal(review.object_kind, "founder_governance_promotion_review");
  assert.equal(review.review_issue, "DEN-474");
  assert.equal(review.parent_issue, "DEN-283");
  assert.equal(review.reviewed_merge_commit, "08c99aa5933236a0e0ebe584f7b2e861f5b3d1ac");
  assert.equal(new Set(dispositionPaths).size, dispositionPaths.length);

  const reviewMetadata = new Set([
    promotion.promotion_review_file,
    promotion.promotion_review_report,
  ]);
  const reviewableArtifacts = promotion.design_files.filter(
    (path) => !reviewMetadata.has(path),
  );

  assert.deepEqual([...dispositionPaths].sort(), [...reviewableArtifacts].sort());
  for (const path of reviewableArtifacts) {
    assert.equal(existsSync(new URL(path, root)), true, `missing reviewed artifact ${path}`);
    assert.ok(dispositionByPath.has(path), `missing disposition for ${path}`);
  }
});

test("current review explicitly rejects premature canonical promotion", () => {
  assert.equal(review.decision, "revise_and_retain_draft");
  assert.equal(review.canonical_promotion_approved, false);
  assert.equal(promotion.status, "draft");
  assert.equal(promotion.promotion_marker, null);
  assert.deepEqual(promotion.canonical_schema_files, []);
  assert.equal(promotion.promotion_decision, review.decision);

  for (const disposition of review.artifact_dispositions) {
    assert.ok(
      [
        "revise_and_retain_draft",
        "retain_noncanonical_executable_specification",
        "retain_noncanonical_documentation",
      ].includes(disposition.disposition),
      `${disposition.path} has unsupported disposition ${disposition.disposition}`,
    );
  }
});

test("wire schemas remain draft while executable models stay mandatory CI evidence", () => {
  for (const path of promotion.draft_schema_files) {
    assert.equal(
      dispositionByPath.get(path)?.disposition,
      "revise_and_retain_draft",
      `${path} must remain draft`,
    );
  }

  for (const path of [
    "design/founder-governance-reference.mjs",
    "design/founder-governance-state-model.mjs",
    "design/founder-governance-transition-reference.mjs",
    "design/founder-governance-executor-model.mjs",
    "design/founder-governance-death-succession-model.mjs",
    "design/founder-governance-adversarial-explorer.mjs",
  ]) {
    assert.equal(
      dispositionByPath.get(path)?.disposition,
      "retain_noncanonical_executable_specification",
      `${path} must remain a noncanonical executable specification`,
    );
  }
});

test("deferred security boundaries and rollback drill block promotion", () => {
  assert.equal(
    review.security_review.secret_free_receipts_and_telemetry,
    "deferred_to_DEN_493_DEN_494_DEN_495",
  );
  assert.equal(
    review.security_review.verified_assertion_to_approval_boundary,
    "deferred_to_DEN_496",
  );
  assert.equal(
    review.security_review.provider_specific_bypass_review,
    "deferred_to_DEN_207_DEN_209",
  );

  for (const blocker of [
    "authoritative_main_branch_ci_evidence",
    "DEN-493_webauthn_adapter_and_protected_state",
    "DEN-494_credential_lifecycle",
    "DEN-495_browser_replica_failure_matrix",
    "DEN-496_verified_receipt_approval_append",
    "generated_artifact_review",
    "rollback_drill",
  ]) {
    assert.ok(review.blocking_requirements.includes(blocker), `missing blocker ${blocker}`);
  }

  assert.equal(review.rollback_policy.status, "planned_not_executed");
  assert.ok(review.rollback_policy.requirements.length >= 5);
});
