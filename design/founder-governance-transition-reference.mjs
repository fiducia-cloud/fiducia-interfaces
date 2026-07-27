// Non-canonical executable semantics for DEN-176 transition-contract discovery.
// Production code must use a conforming RFC 8785 implementation and verify the
// actual WebAuthn/threshold cryptographic assertion before counting an approval.

import {
  canonicalJson,
  sha256Urn,
} from "./founder-governance-reference.mjs";
import {
  ACTIONS,
  classifyAction,
} from "./founder-governance-state-model.mjs";

const SHA256_URN = /^sha256:[0-9a-f]{64}$/;

function participantMap(participants) {
  if (!Array.isArray(participants)) return null;
  const result = new Map();
  for (const participant of participants) {
    if (!participant || result.has(participant.participant_id)) return null;
    result.set(participant.participant_id, participant);
  }
  return result;
}

function participantIsActive(participant, tenantId, nowMs) {
  if (!participant) return false;
  if (participant.tenant_id !== tenantId) return false;
  if (participant.status !== "active") return false;
  if (participant.valid_from_ms > nowMs) return false;
  if (
    participant.valid_until_ms !== undefined &&
    participant.valid_until_ms <= nowMs
  ) {
    return false;
  }
  return true;
}

function approvalIdentityIsAuthorized(transition, approval, participant, nowMs) {
  if (!participantIsActive(participant, transition.tenant_id, nowMs)) return false;
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

function hasUniqueValues(values) {
  return Array.isArray(values) && new Set(values).size === values.length;
}

function evidenceIsValid(evidence, nowMs) {
  if (!Array.isArray(evidence) || evidence.length === 0) return false;
  const ids = new Set();
  for (const item of evidence) {
    if (!item || ids.has(item.evidence_id)) return false;
    ids.add(item.evidence_id);
    if (!SHA256_URN.test(item.content_hash)) return false;
    if (item.issued_at_ms > nowMs) return false;
    if (item.expires_at_ms !== undefined && item.expires_at_ms <= nowMs) return false;
  }
  return true;
}

function noticeIsDelivered(notice) {
  if (!notice || !["delivered", "acknowledged"].includes(notice.status)) return false;
  if (!SHA256_URN.test(notice.payload_hash)) return false;
  if (!notice.provider_reference || notice.provider_reference.trim() === "") return false;
  if (!Number.isInteger(notice.sent_at_ms) || !Number.isInteger(notice.delivered_at_ms)) {
    return false;
  }
  if (notice.delivered_at_ms < notice.sent_at_ms) return false;
  if (notice.status === "acknowledged") {
    if (!Number.isInteger(notice.acknowledged_at_ms)) return false;
    if (notice.acknowledged_at_ms < notice.delivered_at_ms) return false;
  }
  return true;
}

function deliveredNoticeRecipients(transition) {
  if (!Array.isArray(transition.notices)) return null;
  const noticeIds = new Set();
  const recipients = new Set();
  for (const notice of transition.notices) {
    if (!notice || noticeIds.has(notice.notice_id)) return null;
    noticeIds.add(notice.notice_id);
    if (noticeIsDelivered(notice)) {
      recipients.add(notice.recipient_participant_id);
    }
  }
  return recipients;
}

function sameStringSet(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right)) return false;
  if (new Set(left).size !== left.length || new Set(right).size !== right.length) return false;
  if (left.length !== right.length) return false;
  const values = new Set(left);
  return right.every((value) => values.has(value));
}

function requestedAuthorityIsSafe({
  transition,
  requested,
  directory,
  nowMs,
  maximumAuthorityTtlMs,
}) {
  if (!requested) return true;
  if (!Number.isInteger(maximumAuthorityTtlMs) || maximumAuthorityTtlMs <= 0) return false;
  if (!Number.isInteger(requested.authority_ttl_ms) || requested.authority_ttl_ms <= 0) {
    return false;
  }
  if (requested.authority_ttl_ms > maximumAuthorityTtlMs) return false;
  if (transition.earliest_effective_at_ms + requested.authority_ttl_ms > transition.expires_at_ms) {
    return false;
  }

  const grantee = directory.get(requested.grantee_participant_id);
  if (!participantIsActive(grantee, transition.tenant_id, nowMs)) return false;
  if (
    transition.to_state !== "restored" &&
    requested.grantee_participant_id === transition.subject_participant_id
  ) {
    return false;
  }

  const constraints = requested.constraints;
  if (!constraints?.equivalent_access_only) return false;
  if (
    constraints.ownership_changes_allowed ||
    constraints.policy_weakening_allowed ||
    constraints.audit_deletion_allowed ||
    constraints.related_party_transfers_allowed
  ) {
    return false;
  }
  if (!sameStringSet(requested.allowed_action_kinds, constraints.allowed_action_kinds)) {
    return false;
  }

  const constitutionalKinds = Object.entries(ACTIONS)
    .filter(([, actionClass]) => actionClass === "constitutional")
    .map(([actionKind]) => actionKind);
  const denied = new Set(constraints.denied_action_kinds ?? []);
  if (!constitutionalKinds.every((actionKind) => denied.has(actionKind))) return false;

  for (const actionKind of requested.allowed_action_kinds) {
    const actionClass = classifyAction(actionKind);
    if (!actionClass || actionClass === "constitutional") return false;
  }
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

export function transitionApprovalsSatisfyProposal({
  transition,
  approvals,
  participants,
  currentGeneration,
  currentPolicyId,
  currentPolicyVersion,
  currentPolicyHash,
  minimumApprovals,
  requiredParticipantIds = [],
  requiredRoles = [],
  maximumAuthorityTtlMs,
  nowMs,
}) {
  if (!transition || transition.from_state === transition.to_state) return false;
  if (transition.expected_generation !== currentGeneration) return false;
  if (transition.policy_id !== currentPolicyId) return false;
  if (transition.policy_version !== currentPolicyVersion) return false;
  if (transition.policy_hash !== currentPolicyHash) return false;
  try {
    if (transition.canonical_transition_hash !== transitionPayloadHash(transition)) return false;
  } catch {
    return false;
  }
  if (transition.created_at_ms > nowMs) return false;
  if (transition.earliest_effective_at_ms < transition.created_at_ms) return false;
  if (transition.expires_at_ms <= transition.earliest_effective_at_ms) return false;
  if (transition.expires_at_ms <= nowMs) return false;
  if (transition.earliest_effective_at_ms > nowMs) return false;
  if (!hasUniqueValues(transition.required_notice_participant_ids)) return false;
  if (!evidenceIsValid(transition.evidence, nowMs)) return false;
  if (!transition.process_assertions?.includes("notice_completed")) return false;

  const delivered = deliveredNoticeRecipients(transition);
  if (!delivered) return false;
  for (const participantId of transition.required_notice_participant_ids) {
    if (!delivered.has(participantId)) return false;
  }

  const directory = participantMap(participants);
  if (!directory) return false;
  const requester = directory.get(transition.requested_by_participant_id);
  if (!participantIsActive(requester, transition.tenant_id, nowMs)) return false;
  const subject = directory.get(transition.subject_participant_id);
  if (!subject || subject.tenant_id !== transition.tenant_id || subject.status === "revoked") {
    return false;
  }

  if (
    !requestedAuthorityIsSafe({
      transition,
      requested: transition.requested_authority,
      directory,
      nowMs,
      maximumAuthorityTtlMs,
    })
  ) {
    return false;
  }

  if (!Number.isInteger(minimumApprovals) || minimumApprovals <= 0) return false;
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
