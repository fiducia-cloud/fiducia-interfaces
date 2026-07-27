import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import Ajv2020 from "ajv/dist/2020.js";

import {
  approvalsSatisfyProposal,
  isPolicyReplacementNonWeakening,
  proposalPayloadHash,
} from "../design/founder-governance-reference.mjs";

const schema = JSON.parse(
  readFileSync(new URL("../design/founder-governance.schema.json", import.meta.url), "utf8"),
);
const examples = JSON.parse(
  readFileSync(new URL("../design/founder-governance.examples.json", import.meta.url), "utf8"),
);

const ajv = new Ajv2020({ allErrors: true, strict: true });
ajv.addSchema(schema);

const validateDef = (name, value) => {
  const validate = ajv.compile({ $ref: `${schema.$id}#/$defs/${name}` });
  const valid = validate(value);
  assert.equal(valid, true, JSON.stringify(validate.errors, null, 2));
};

function materializeProposalAndApprovals() {
  const proposal = structuredClone(examples.valid.proposal);
  proposal.canonical_payload_hash = proposalPayloadHash(proposal);

  const approvals = structuredClone(examples.valid.approvals);
  for (const approval of approvals) {
    approval.canonical_payload_hash = proposal.canonical_payload_hash;
  }
  return { proposal, approvals };
}

test("draft governance examples validate against Draft 2020-12", () => {
  const { policy, receipt } = examples.valid;
  const { proposal, approvals } = materializeProposalAndApprovals();

  validateDef("GovernancePolicy", policy);
  validateDef("GovernanceProposal", proposal);
  for (const approval of approvals) validateDef("GovernanceApproval", approval);
  validateDef("GovernanceExecutionReceipt", receipt);
});

test("schema rejects malformed hashes, duplicate roles, and unknown properties", () => {
  const invalid = structuredClone(examples.valid.policy);
  invalid.policy_hash = "sha256:not-a-real-hash";
  invalid.state_rules[0].quorum.required_roles = ["founder", "founder"];
  invalid.unreviewed_escape_hatch = true;

  const validate = ajv.compile({ $ref: `${schema.$id}#/$defs/GovernancePolicy` });
  assert.equal(validate(invalid), false);
  const keywords = new Set(validate.errors.map((error) => error.keyword));
  assert.ok(keywords.has("pattern"));
  assert.ok(keywords.has("uniqueItems"));
  assert.ok(keywords.has("additionalProperties"));
});

test("proposal hash commits to every proposal field except the hash itself", () => {
  const { proposal } = materializeProposalAndApprovals();
  const originalHash = proposal.canonical_payload_hash;

  const mutated = structuredClone(proposal);
  mutated.parameters_hash = `sha256:${"f".repeat(64)}`;
  assert.notEqual(proposalPayloadHash(mutated), originalHash);

  const relabeled = structuredClone(proposal);
  relabeled.continuity_state = "temporarily_unavailable";
  assert.notEqual(proposalPayloadHash(relabeled), originalHash);
});

test("policy replacement cannot reduce quorum or loosen self-dealing constraints", () => {
  const current = examples.valid.policy;

  const stronger = structuredClone(current);
  stronger.version = 2;
  stronger.replaces_policy_hash = current.policy_hash;
  stronger.policy_hash = `sha256:${"9".repeat(64)}`;
  stronger.state_rules[0].quorum.minimum_approvals = 3;
  stronger.state_rules[0].challenge_window_ms += 86_400_000;
  stronger.state_rules[0].authority_ttl_ms = 1_800_000;
  assert.equal(isPolicyReplacementNonWeakening(current, stronger), true);

  const weakerQuorum = structuredClone(stronger);
  weakerQuorum.state_rules[0].quorum.minimum_approvals = 1;
  assert.equal(isPolicyReplacementNonWeakening(current, weakerQuorum), false);

  const selfDealing = structuredClone(stronger);
  selfDealing.state_rules[0].constraints.ownership_changes_allowed = true;
  assert.equal(isPolicyReplacementNonWeakening(current, selfDealing), false);
});

test("normal execution requires two unique matching founder approvals after the delay", () => {
  const policy = examples.valid.policy;
  const { proposal, approvals } = materializeProposalAndApprovals();
  const readyAt = proposal.created_at_ms + 86_400_000;

  assert.equal(
    approvalsSatisfyProposal(policy, proposal, [approvals[0]], readyAt),
    false,
  );
  assert.equal(
    approvalsSatisfyProposal(policy, proposal, [approvals[0], approvals[0]], readyAt),
    false,
  );
  assert.equal(
    approvalsSatisfyProposal(policy, proposal, approvals, readyAt),
    true,
  );

  const mutatedApproval = structuredClone(approvals[1]);
  mutatedApproval.canonical_payload_hash = `sha256:${"0".repeat(64)}`;
  assert.equal(
    approvalsSatisfyProposal(policy, proposal, [approvals[0], mutatedApproval], readyAt),
    false,
  );
});

test("continuity execution requires both founder and guardian roles", () => {
  const policy = examples.valid.policy;
  const { proposal } = materializeProposalAndApprovals();
  proposal.continuity_state = "temporarily_unavailable";
  proposal.canonical_payload_hash = proposalPayloadHash(proposal);

  const founderApproval = {
    ...examples.valid.approvals[0],
    canonical_payload_hash: proposal.canonical_payload_hash,
    approved_at_ms: proposal.created_at_ms + 259_200_000,
  };
  const secondFounder = {
    ...examples.valid.approvals[1],
    canonical_payload_hash: proposal.canonical_payload_hash,
    approved_at_ms: proposal.created_at_ms + 259_200_000,
  };
  const guardianApproval = {
    ...secondFounder,
    participant_id: "guardian-1",
    participant_role: "guardian",
    credential_id: "webauthn-guardian-1",
  };
  const readyAt = proposal.created_at_ms + 259_200_000;

  assert.equal(
    approvalsSatisfyProposal(policy, proposal, [founderApproval, secondFounder], readyAt),
    false,
  );
  assert.equal(
    approvalsSatisfyProposal(policy, proposal, [founderApproval, guardianApproval], readyAt),
    true,
  );
});

test("a prohibited continuity state remains non-executable regardless of approvals", () => {
  const policy = examples.valid.policy;
  const { proposal, approvals } = materializeProposalAndApprovals();
  proposal.continuity_state = "confirmed_long_term_incapacity";
  proposal.canonical_payload_hash = proposalPayloadHash(proposal);
  for (const approval of approvals) {
    approval.canonical_payload_hash = proposal.canonical_payload_hash;
  }

  assert.equal(
    approvalsSatisfyProposal(
      policy,
      proposal,
      approvals,
      proposal.created_at_ms + 300_000_000,
    ),
    false,
  );
});
