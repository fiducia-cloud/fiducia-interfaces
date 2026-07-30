import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import {
  ACTIONS,
  authorizeAction,
} from "../design/founder-governance-state-model.mjs";

const EXAMPLE_PATH = new URL(
  "../design/founder-governance-action-class.examples.json",
  import.meta.url,
);
const REQUIRED_CLASSES = Object.freeze([
  "routine",
  "sensitive",
  "constitutional",
  "recovery",
  "emergency",
]);

async function loadExamples() {
  return JSON.parse(await readFile(EXAMPLE_PATH, "utf8"));
}

test("DEN-176 publishes valid and invalid fixtures for every action class", async () => {
  const document = await loadExamples();
  assert.equal(document.contract_version, "1.0");
  assert.equal(document.object_kind, "founder_governance_action_class_examples");
  assert.equal(document.review_issue, "DEN-176");
  assert.match(document.claim_boundary, /noncanonical/i);

  const dispositions = new Map(
    REQUIRED_CLASSES.map((actionClass) => [
      actionClass,
      { authorized: 0, rejected: 0 },
    ]),
  );

  const ids = new Set();
  for (const example of document.examples) {
    assert.equal(typeof example.id, "string");
    assert.ok(example.id.length > 0);
    assert.equal(ids.has(example.id), false, `duplicate example id ${example.id}`);
    ids.add(example.id);

    assert.ok(
      dispositions.has(example.action_class),
      `unknown action class ${example.action_class}`,
    );
    assert.equal(
      ACTIONS[example.request.action_kind],
      example.action_class,
      `${example.id} does not bind its declared action class`,
    );

    const actual = authorizeAction(example.request);
    assert.equal(actual, example.expected_authorized, example.id);
    const counts = dispositions.get(example.action_class);
    counts[actual ? "authorized" : "rejected"] += 1;
  }

  for (const [actionClass, counts] of dispositions) {
    assert.ok(counts.authorized > 0, `${actionClass} lacks a valid fixture`);
    assert.ok(counts.rejected > 0, `${actionClass} lacks an invalid fixture`);
  }
});

test("continuity examples never elevate constitutional authority", async () => {
  const document = await loadExamples();
  const fixture = document.examples.find(
    (example) => example.id === "constitutional-invalid-continuity-mode",
  );
  assert.ok(fixture, "missing constitutional continuity rejection fixture");
  assert.notEqual(fixture.request.state, "normal");
  assert.equal(fixture.action_class, "constitutional");
  assert.equal(fixture.expected_authorized, false);
  assert.equal(authorizeAction(fixture.request), false);
});
