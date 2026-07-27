import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import {
  approvalsSatisfyProposal,
  canonicalJson,
  isPolicyReplacementNonWeakening,
  policyPayloadHash,
  proposalPayloadHash,
} from "../design/founder-governance-reference.mjs";

const schema = JSON.parse(readFileSync(new URL("../design/founder-governance.schema.json", import.meta.url), "utf8"));
const examples = JSON.parse(readFileSync(new URL("../design/founder-governance.examples.json", import.meta.url), "utf8"));
const ajv = new Ajv2020({ allErrors: true, strict: true });
ajv.addSchema(schema);
const validateDef = (name, value) => {
  const validate = ajv.compile({ $ref: `${schema.$id}#/$defs/${name}` });
  assert.equal(validate(value), true, JSON.stringify(validate.errors, null, 2));
};
const materialize = () => {
  const proposal = structuredClone(examples.valid.proposal);
  proposal.canonical_payload_hash = proposalPayloadHash(proposal);
  const approvals = structuredClone(examples.valid.approvals).map((approval) => ({
    ...approval,
    canonical_payload_hash: proposal.canonical_payload_hash,
  }));
  return { proposal, approvals };
};
const rehash = (policy) => { policy.policy_hash = policyPayloadHash(policy); return policy; };

test("draft examples validate and keep provider-root actions manual-only", () => {
  const { participants, policy, receipt } = examples.valid;
  const { proposal, approvals } = materialize();
  for (const participant of participants) validateDef("GovernanceParticipant", participant);
  validateDef("GovernancePolicy", policy);
  validateDef("GovernanceProposal", proposal);
  for (const approval of approvals) validateDef("GovernanceApproval", approval);
  validateDef("GovernanceExecutionReceipt", receipt);
  assert.equal(policy.action_kind, "github.ruleset.update_evaluate");
  for (const rule of policy.state_rules.filter((candidate) => candidate.permitted)) {
    assert.ok(rule.constraints.denied_action_kinds.includes("github.change_org_owner"));
  }
});

test("canonical JSON is deterministic and rejects non-JSON values", () => {
  assert.equal(canonicalJson({ z: 2, a: [true, null, "x"] }), '{"a":[true,null,"x"],"z":2}');
  assert.equal(canonicalJson({ n: -0 }), '{"n":0}');
  for (const bad of [{ x: undefined }, { x: NaN }, { x: Infinity }]) {
    assert.throws(() => canonicalJson(bad));
  }
  const cyclic = {}; cyclic.self = cyclic;
  assert.throws(() => canonicalJson(cyclic), /cyclic/);
});

test("policy and proposal hashes bind every authorization-relevant field", () => {
  const policy = examples.valid.policy;
  assert.equal(policy.policy_hash, policyPayloadHash(policy));
  const weakened = structuredClone(policy);
  weakened.state_rules[0].quorum.minimum_approvals = 1;
  assert.notEqual(policyPayloadHash(weakened), policy.policy_hash);

  const { proposal } = materialize();
  const original = proposal.canonical_payload_hash;
  const mutated = structuredClone(proposal);
  mutated.parameters_hash = `sha256:${"f".repeat(64)}`;
  assert.notEqual(proposalPayloadHash(mutated), original);
});

test("policy replacement requires a valid hash and cannot weaken quorum, notice, or constraints", () => {
  const current = examples.valid.policy;
  const stronger = structuredClone(current);
  stronger.version = 2;
  stronger.replaces_policy_hash = current.policy_hash;
  stronger.state_rules[0].quorum.minimum_approvals = 3;
  stronger.state_rules[0].challenge_window_ms += 86_400_000;
  stronger.state_rules[0].authority_ttl_ms = 1_800_000;
  rehash(stronger);
  assert.equal(isPolicyReplacementNonWeakening(current, stronger), true);

  for (const mutate of [
    (candidate) => { candidate.state_rules[0].quorum.minimum_approvals = 1; },
    (candidate) => { candidate.state_rules[0].notice_participant_ids = ["founder-a"]; },
    (candidate) => { candidate.state_rules[0].constraints.ownership_changes_allowed = true; },
  ]) {
    const candidate = structuredClone(stronger); mutate(candidate); rehash(candidate);
    assert.equal(isPolicyReplacementNonWeakening(current, candidate), false);
  }
  const staleHash = structuredClone(stronger);
  staleHash.state_rules[0].challenge_window_ms += 1;
  assert.equal(isPolicyReplacementNonWeakening(current, staleHash), false);
});

test("normal execution requires two unique authorized founders and a live proposer", () => {
  const { participants, policy } = examples.valid;
  const { proposal, approvals } = materialize();
  const readyAt = proposal.created_at_ms + 86_400_000;
  assert.equal(approvalsSatisfyProposal(policy, proposal, [approvals[0]], participants, readyAt), false);
  assert.equal(approvalsSatisfyProposal(policy, proposal, [approvals[0], approvals[0]], participants, readyAt), false);
  assert.equal(approvalsSatisfyProposal(policy, proposal, approvals, participants, readyAt), true);

  const unknown = structuredClone(proposal);
  unknown.proposer_participant_id = "unknown";
  unknown.canonical_payload_hash = proposalPayloadHash(unknown);
  const rebound = approvals.map((approval) => ({ ...approval, canonical_payload_hash: unknown.canonical_payload_hash }));
  assert.equal(approvalsSatisfyProposal(policy, unknown, rebound, participants, readyAt), false);
});

test("tenant, role, credential, revocation, and current expiry are enforced", () => {
  const { policy } = examples.valid;
  const { proposal, approvals } = materialize();
  const readyAt = proposal.created_at_ms + 86_400_000;

  const wrongTenant = structuredClone(proposal);
  wrongTenant.tenant_id = "other";
  wrongTenant.canonical_payload_hash = proposalPayloadHash(wrongTenant);
  assert.equal(approvalsSatisfyProposal(policy, wrongTenant, approvals, examples.valid.participants, readyAt), false);

  const revoked = structuredClone(examples.valid.participants); revoked[1].status = "revoked";
  assert.equal(approvalsSatisfyProposal(policy, proposal, approvals, revoked, readyAt), false);
  const expired = structuredClone(examples.valid.participants); expired[1].valid_until_ms = readyAt;
  assert.equal(approvalsSatisfyProposal(policy, proposal, approvals, expired, readyAt), false);
  const forged = structuredClone(approvals); forged[1].participant_role = "guardian";
  assert.equal(approvalsSatisfyProposal(policy, proposal, forged, examples.valid.participants, readyAt), false);
  const unregistered = structuredClone(approvals); unregistered[1].credential_id = "unknown";
  assert.equal(approvalsSatisfyProposal(policy, proposal, unregistered, examples.valid.participants, readyAt), false);
});

test("continuity requires founder plus guardian and prohibited states stay blocked", () => {
  const { participants, policy } = examples.valid;
  const { proposal } = materialize();
  proposal.continuity_state = "temporarily_unavailable";
  proposal.canonical_payload_hash = proposalPayloadHash(proposal);
  const readyAt = proposal.created_at_ms + 259_200_000;
  const founder = { ...examples.valid.approvals[0], canonical_payload_hash: proposal.canonical_payload_hash, approved_at_ms: readyAt };
  const guardian = { ...examples.valid.approvals[1], participant_id: "guardian-1", participant_role: "guardian", credential_id: "webauthn-guardian-1", canonical_payload_hash: proposal.canonical_payload_hash, approved_at_ms: readyAt };
  assert.equal(approvalsSatisfyProposal(policy, proposal, [founder, guardian], participants, readyAt), true);

  proposal.continuity_state = "confirmed_long_term_incapacity";
  proposal.canonical_payload_hash = proposalPayloadHash(proposal);
  founder.canonical_payload_hash = proposal.canonical_payload_hash;
  guardian.canonical_payload_hash = proposal.canonical_payload_hash;
  assert.equal(approvalsSatisfyProposal(policy, proposal, [founder, guardian], participants, readyAt + 1), false);
});
