import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import { test } from "node:test";

const root = new URL("../", import.meta.url);
const readJson = (path) => JSON.parse(readFileSync(new URL(path, root), "utf8"));
const readText = (path) => readFileSync(new URL(path, root), "utf8");

const promotion = readJson("design/founder-governance-promotion.json");

function assertUnique(values, label) {
  assert.equal(new Set(values).size, values.length, `${label} contains duplicates`);
}

test("promotion manifest is complete, unique, and points to committed files", () => {
  assert.ok(["draft", "canonical"].includes(promotion.status));
  assert.equal(promotion.promotion_issue, "DEN-283");
  assert.equal(promotion.parent_issue, "DEN-158");
  assert.equal(promotion.canonicalization.identifier, "jcs_rfc8785");

  for (const [label, paths] of [
    ["draft_schema_files", promotion.draft_schema_files],
    ["design_files", promotion.design_files],
    ["test_files", promotion.test_files],
  ]) {
    assert.ok(Array.isArray(paths) && paths.length > 0, `${label} must be non-empty`);
    assertUnique(paths, label);
    for (const path of paths) {
      assert.equal(existsSync(new URL(path, root)), true, `missing ${path}`);
    }
  }

  assertUnique(promotion.constitutional_manual_only_actions, "manual-only actions");
  assertUnique(promotion.promotion_requirements, "promotion requirements");
});

test("draft contracts cannot silently enter the canonical generated schema index", () => {
  const index = readJson("schema/index.json");
  const canonical = new Set(index.schemas);

  if (promotion.status === "draft") {
    assert.equal(promotion.promotion_marker, null);
    assert.deepEqual(promotion.canonical_schema_files, []);
    for (const path of promotion.draft_schema_files) {
      assert.equal(
        canonical.has(basename(path)),
        false,
        `${path} entered schema/index.json without explicit promotion`,
      );
    }
  }
});

test("normal and dedicated CI both execute the founder-governance gate", () => {
  const packageJson = readJson("package.json");
  assert.match(packageJson.scripts.test, /node --test src\/\*\.test\.mjs/);
  assert.equal(
    packageJson.scripts["test:founder-governance"],
    "node --test src/founder-governance-*.test.mjs",
  );

  const workflow = readText(".github/workflows/founder-governance.yml");
  assert.match(workflow, /npm run test:founder-governance/);
  assert.match(workflow, /pull_request:/);
  assert.match(workflow, /branches: \[main\]/);

  const mainCi = readText(".github/workflows/ci.yml");
  assert.match(mainCi, /\.\/\.github\/workflows\/founder-governance\.yml/);
  assert.match(mainCi, /npm test/);
});

test("sandbox example cannot normalize a constitutional root action as sensitive", () => {
  const examples = readJson("design/founder-governance.examples.json");
  const policy = examples.valid.policy;
  const manualOnly = new Set(promotion.constitutional_manual_only_actions);

  assert.equal(policy.action_kind, "github.ruleset.update_evaluate");
  assert.equal(manualOnly.has(policy.action_kind), false);

  for (const rule of policy.state_rules.filter((candidate) => candidate.permitted)) {
    const denied = new Set(rule.constraints.denied_action_kinds ?? []);
    for (const action of manualOnly) {
      assert.equal(
        denied.has(action),
        true,
        `${action} must remain denied in permitted state ${rule.state}`,
      );
    }
  }
});
