import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import Ajv2020 from "ajv/dist/2020.js";

import {
  transitionApprovalsSatisfyProposal,
  transitionPayloadHash,
} from "../design/founder-governance-transition-reference.mjs";

const baseSchema = JSON.parse(
  readFileSync(new URL("../design/founder-governance.schema.json", import.meta.url), "utf8"),
);
const transitionSchema = JSON.parse(
  readFileSync(
    new URL("../design/founder-governance-transition.schema.json", import.meta.url),
    "utf8",
  ),
);
const examples = JSON.parse(
  readFileSync(
    new URL("../design/founder-governance-transition.examples.json", import.meta.url),
    "utf8",
  ),
);
const governanceExamples = JSON.parse(
  readFileSync(new URL("../design/founder-governance.examples.json", import.meta.url), "utf8"),
);

const ajv = new Ajv2020({ allErrors: true, strict: true });
ajv.addSchema(baseSchema);
ajv.addSchema(transitionSchema);

function validateDef(name, value) {
  const validate = ajv.compile({
    $ref: `${transitionSchema.$id}#/$defs/${name}`,
  });
  assert.equal(validate(value), true, JSON.stringify(validate.errors, null, 2));
}

function materialize() {
  const transition = structuredClone(examples.valid.transition);
  transition.canonical_transition_hash = transitionPayloadHash(transition);
  const approvals = structuredClone(examples.valid.transition_approvals);
  for (const approval of approvals) {
    approval.canonical_transition_hash = transition.canonical_transition_hash;
  }
  return { transition, approvals };
}

test("transition contract examples validate against Draft 2020-12", () => {
  const { transition, approvals } = materialize();
  validateDef("ContinuityTransitionProposal", transition);
  for (const approval of approvals) {
    validateDef("ContinuityTransitionApproval", approval);
  }
  validateDef("ContinuityTransitionReceipt", examples.valid.transition_receipt);
  validateDef("DelegatedAuthority", examples.valid.delegated_authority);
});

test("transition approvals bind evidence, notices, generation, and guardian role", () => {
  const { transition, approvals } = materialize();
  const nowMs = transition.earliest_effective_at_ms;
  const base = {
    transition,
    approvals,
    participants: governanceExamples.valid.participants,
    currentGeneration: 7,
    minimumApprovals: 2,
    requiredRoles: ["founder", "guardian"],
    nowMs,
  };

  assert.equal(transitionApprovalsSatisfyProposal(base), true);
  assert.equal(
    transitionApprovalsSatisfyProposal({ ...base, currentGeneration: 8 }),
    false,
  );
  assert.equal(
    transitionApprovalsSatisfyProposal({ ...base, approvals: [approvals[0]] }),
    false,
  );

  const forgedGuardian = structuredClone(approvals[1]);
  forgedGuardian.participant_id = "founder-b";
  forgedGuardian.credential_id = "webauthn-credential-b";
  assert.equal(
    transitionApprovalsSatisfyProposal({
      ...base,
      approvals: [approvals[0], forgedGuardian],
    }),
    false,
  );
});

test("transition mutation invalidates prior approvals", () => {
  const { transition, approvals } = materialize();
  transition.evidence[0].content_hash = `sha256:${"f".repeat(64)}`;
  assert.equal(
    transitionApprovalsSatisfyProposal({
      transition,
      approvals,
      participants: governanceExamples.valid.participants,
      currentGeneration: 7,
      minimumApprovals: 2,
      requiredRoles: ["founder", "guardian"],
      nowMs: transition.earliest_effective_at_ms,
    }),
    false,
  );
});

test("transition fails when any required notice lacks delivery evidence", () => {
  const { transition, approvals } = materialize();
  transition.notices.find(
    (notice) => notice.recipient_participant_id === "founder-b",
  ).status = "sent";
  transition.canonical_transition_hash = transitionPayloadHash(transition);
  for (const approval of approvals) {
    approval.canonical_transition_hash = transition.canonical_transition_hash;
  }

  assert.equal(
    transitionApprovalsSatisfyProposal({
      transition,
      approvals,
      participants: governanceExamples.valid.participants,
      currentGeneration: 7,
      minimumApprovals: 2,
      requiredRoles: ["founder", "guardian"],
      nowMs: transition.earliest_effective_at_ms,
    }),
    false,
  );
});

test("transition cannot request self-dealing delegated authority", () => {
  const { transition, approvals } = materialize();
  transition.requested_authority.constraints.ownership_changes_allowed = true;
  transition.canonical_transition_hash = transitionPayloadHash(transition);
  for (const approval of approvals) {
    approval.canonical_transition_hash = transition.canonical_transition_hash;
  }

  assert.equal(
    transitionApprovalsSatisfyProposal({
      transition,
      approvals,
      participants: governanceExamples.valid.participants,
      currentGeneration: 7,
      minimumApprovals: 2,
      requiredRoles: ["founder", "guardian"],
      nowMs: transition.earliest_effective_at_ms,
    }),
    false,
  );
});
