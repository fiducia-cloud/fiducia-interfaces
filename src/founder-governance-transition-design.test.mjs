import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import { transitionApprovalsSatisfyProposal, transitionPayloadHash } from "../design/founder-governance-transition-reference.mjs";

const baseSchema = JSON.parse(readFileSync(new URL("../design/founder-governance.schema.json", import.meta.url), "utf8"));
const transitionSchema = JSON.parse(readFileSync(new URL("../design/founder-governance-transition.schema.json", import.meta.url), "utf8"));
const examples = JSON.parse(readFileSync(new URL("../design/founder-governance-transition.examples.json", import.meta.url), "utf8"));
const governance = JSON.parse(readFileSync(new URL("../design/founder-governance.examples.json", import.meta.url), "utf8"));
const ajv = new Ajv2020({ allErrors: true, strict: true });
ajv.addSchema(baseSchema); ajv.addSchema(transitionSchema);
const validateDef = (name, value) => {
  const validate = ajv.compile({ $ref: `${transitionSchema.$id}#/$defs/${name}` });
  assert.equal(validate(value), true, JSON.stringify(validate.errors, null, 2));
};
const materialize = () => {
  const transition = structuredClone(examples.valid.transition);
  transition.canonical_transition_hash = transitionPayloadHash(transition);
  const approvals = structuredClone(examples.valid.transition_approvals).map((approval) => ({
    ...approval, canonical_transition_hash: transition.canonical_transition_hash,
  }));
  return { transition, approvals };
};
const evaluate = (built = materialize(), overrides = {}) => ({
  transition: built.transition,
  approvals: overrides.approvals ?? built.approvals,
  participants: overrides.participants ?? governance.valid.participants,
  currentGeneration: overrides.currentGeneration ?? built.transition.expected_generation,
  currentPolicyId: overrides.currentPolicyId ?? built.transition.policy_id,
  currentPolicyVersion: overrides.currentPolicyVersion ?? built.transition.policy_version,
  currentPolicyHash: overrides.currentPolicyHash ?? built.transition.policy_hash,
  minimumApprovals: overrides.minimumApprovals ?? 2,
  requiredParticipantIds: overrides.requiredParticipantIds ?? [],
  requiredRoles: overrides.requiredRoles ?? ["founder", "guardian"],
  maximumAuthorityTtlMs: overrides.maximumAuthorityTtlMs ?? 3_600_000,
  nowMs: overrides.nowMs ?? built.transition.earliest_effective_at_ms,
});
const rebind = (built) => {
  built.transition.canonical_transition_hash = transitionPayloadHash(built.transition);
  built.approvals.forEach((approval) => { approval.canonical_transition_hash = built.transition.canonical_transition_hash; });
  return built;
};

test("transition examples validate against Draft 2020-12", () => {
  const { transition, approvals } = materialize();
  validateDef("ContinuityTransitionProposal", transition);
  approvals.forEach((approval) => validateDef("ContinuityTransitionApproval", approval));
  validateDef("ContinuityTransitionReceipt", examples.valid.transition_receipt);
  validateDef("DelegatedAuthority", examples.valid.delegated_authority);
});

test("a valid transition is bound to generation, current policy, quorum, and exact hash", () => {
  const base = evaluate();
  assert.equal(transitionApprovalsSatisfyProposal(base), true);
  for (const override of [
    { currentGeneration: 8 },
    { currentPolicyVersion: 2 },
    { currentPolicyHash: `sha256:${"9".repeat(64)}` },
    { approvals: [base.approvals[0]] },
  ]) assert.equal(transitionApprovalsSatisfyProposal({ ...base, ...override }), false);

  const mutated = materialize();
  mutated.transition.evidence[0].content_hash = `sha256:${"f".repeat(64)}`;
  assert.equal(transitionApprovalsSatisfyProposal(evaluate(mutated)), false);
});

test("notice proof requires unique receipts, provider reference, and coherent delivery timestamps", () => {
  const cases = [
    (built) => { built.transition.notices[1].status = "sent"; },
    (built) => { delete built.transition.notices[0].provider_reference; },
    (built) => { built.transition.notices[0].delivered_at_ms = built.transition.notices[0].sent_at_ms - 1; },
    (built) => { built.transition.notices.push(structuredClone(built.transition.notices[0])); },
  ];
  for (const mutate of cases) {
    const built = materialize(); mutate(built); rebind(built);
    assert.equal(transitionApprovalsSatisfyProposal(evaluate(built)), false);
  }
});

test("evidence must be unique, current, content-addressed, and issued before evaluation", () => {
  const cases = [
    (built) => built.transition.evidence.push(structuredClone(built.transition.evidence[0])),
    (built) => { built.transition.evidence[0].content_hash = "not-a-hash"; },
    (built) => { built.transition.evidence[0].expires_at_ms = built.transition.earliest_effective_at_ms; },
    (built) => { built.transition.evidence[0].issued_at_ms = built.transition.earliest_effective_at_ms + 1; },
  ];
  for (const mutate of cases) {
    const built = materialize(); mutate(built); rebind(built);
    assert.equal(transitionApprovalsSatisfyProposal(evaluate(built)), false);
  }
});

test("delegated authority is equivalent-access only, bounded, typed, and cannot target the unavailable subject", () => {
  const cases = [
    (built) => { built.transition.requested_authority.constraints.ownership_changes_allowed = true; },
    (built) => { built.transition.requested_authority.constraints.allowed_action_kinds = ["routine.deploy"]; },
    (built) => {
      built.transition.requested_authority.allowed_action_kinds = ["provider.unclassified_root"];
      built.transition.requested_authority.constraints.allowed_action_kinds = ["provider.unclassified_root"];
    },
    (built) => {
      built.transition.requested_authority.allowed_action_kinds = ["constitutional.issue_equity"];
      built.transition.requested_authority.constraints.allowed_action_kinds = ["constitutional.issue_equity"];
    },
    (built) => { built.transition.requested_authority.authority_ttl_ms = 3_600_001; },
    (built) => { built.transition.requested_authority.grantee_participant_id = built.transition.subject_participant_id; },
  ];
  for (const mutate of cases) {
    const built = materialize(); mutate(built); rebind(built);
    assert.equal(transitionApprovalsSatisfyProposal(evaluate(built)), false);
  }
});

test("requester, approvers, roles, and credentials must remain authorized at execution", () => {
  const built = materialize();
  const expired = structuredClone(governance.valid.participants);
  expired.find((p) => p.participant_id === "guardian-1").valid_until_ms = built.transition.earliest_effective_at_ms;
  assert.equal(transitionApprovalsSatisfyProposal(evaluate(built, { participants: expired })), false);

  const revoked = structuredClone(governance.valid.participants);
  revoked.find((p) => p.participant_id === "founder-a").status = "revoked";
  assert.equal(transitionApprovalsSatisfyProposal(evaluate(materialize(), { participants: revoked })), false);

  const forged = materialize(); forged.approvals[1].participant_id = "founder-b"; forged.approvals[1].credential_id = "webauthn-credential-b";
  assert.equal(transitionApprovalsSatisfyProposal(evaluate(forged)), false);
});

test("transition time ordering fails closed", () => {
  const cases = [
    (built) => { built.transition.created_at_ms = built.transition.earliest_effective_at_ms + 1; },
    (built) => { built.transition.expires_at_ms = built.transition.earliest_effective_at_ms; },
  ];
  for (const mutate of cases) {
    const built = materialize(); mutate(built); rebind(built);
    assert.equal(transitionApprovalsSatisfyProposal(evaluate(built)), false);
  }
});
