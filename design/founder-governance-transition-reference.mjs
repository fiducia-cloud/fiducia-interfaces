// Non-canonical executable semantics for DEN-176 transition-contract discovery.
// Production code must use a conforming RFC 8785 implementation and verify the
// actual WebAuthn/threshold cryptographic assertion before counting an approval.

import {
  canonicalJson,
  sha256Urn,
} from "./founder-governance-reference.mjs";

function participantMap(participants) {
  const result = new Map();
  for (const participant of participants) {
    if (result.has(participant.participant_id)) return null;
    result.set(participant.participant_id, participant);
  }
  return result;
}

function approvalIdentityIsAuthorized(transition, approval, participant, nowMs) {
  if (!participant) return false;
  if (participant.tenant_id !== transition.tenant_id) return false;
  if (participant.status !== "active") return false;
  if (participant.valid_from_ms > approval.approved_at_ms) return false;
  if (
    participant.valid_until_ms !== undefined &&
    participant.valid_until_ms <= approval.approved_at_ms
  ) {
    return false;
  }
  if (!participant.roles.includes(approval.participant_role)) return false;
  if (!participant.credential_ids.includes(approval.credential_id)) return false;
  if (approval.approved_at_ms > nowMs) return false;
  return true;
}

export function transitionPayloadHash(transition) {
  if (transition.canonicalization !== "jcs_rfc8785") {
    throw new Error("unsupported transition canonicalization");
  }
  const { canonical_transition_hash: _ignored, ...payload } = transition;
  return sha256Urn(canonicalJson(payload));
}

function transitionApprovalMatches(transition, approval) {
  return (
    approval.tenant_id === transition.tenant_id &&
    approval.transition_id === transition.transition_id &&
    approval.canonical_transition_hash === transition.canonical_transition_hash
  );
}

function deliveredNoticeRecipients(transition) {
  const recipients = new Set();
  for (const notice of transition.notices) {
    if (notice.status === "delivered" || notice.status === "acknowledged") {
      recipients.add(notice.recipient_participant_id);
    }
  }
  return recipients;
}

export function transitionApprovalsSatisfyProposal({
  transition,
  approvals,
  participants,
  currentGeneration,
  minimumApprovals,
  requiredParticipantIds = [],
  requiredRoles = [],
  nowMs,
}) {
  if (transition.from_state === transition.to_state) return false;
  if (transition.expected_generation !== currentGeneration) return false;
  if (transition.canonical_transition_hash !== transitionPayloadHash(transition)) return false;
  if (transition.expires_at_ms <= nowMs) return false;
  if (transition.earliest_effective_at_ms > nowMs) return false;

  const delivered = deliveredNoticeRecipients(transition);
  for (const participantId of transition.required_notice_participant_ids) {
    if (!delivered.has(participantId)) return false;
  }

  const requested = transition.requested_authority;
  if (requested) {
    const constraints = requested.constraints;
    if (!constraints.equivalent_access_only) return false;
    if (
      constraints.ownership_changes_allowed ||
      constraints.policy_weakening_allowed ||
      constraints.audit_deletion_allowed ||
      constraints.related_party_transfers_allowed
    ) {
      return false;
    }
    if (requested.authority_ttl_ms <= 0) return false;
  }

  const directory = participantMap(participants);
  if (!directory) return false;

  const uniqueByParticipant = new Map();
  for (const approval of approvals) {
    if (!transitionApprovalMatches(transition, approval)) continue;
    if (approval.approved_at_ms < transition.created_at_ms) continue;
    const participant = directory.get(approval.participant_id);
    if (!approvalIdentityIsAuthorized(transition, approval, participant, nowMs)) continue;
    uniqueByParticipant.set(approval.participant_id, approval);
  }

  const accepted = [...uniqueByParticipant.values()];
  if (accepted.length < minimumApprovals) return false;

  const participantIds = new Set(accepted.map((approval) => approval.participant_id));
  for (const participantId of requiredParticipantIds) {
    if (!participantIds.has(participantId)) return false;
  }

  const roles = new Set(accepted.map((approval) => approval.participant_role));
  for (const role of requiredRoles) {
    if (!roles.has(role)) return false;
  }

  return true;
}
