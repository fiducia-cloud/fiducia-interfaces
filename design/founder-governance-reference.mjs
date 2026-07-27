// Non-canonical executable semantics for DEN-158/DEN-176 discovery.
// This module is intentionally outside the generated schema surface.
// It provides conservative safety checks; production authorization must fail closed.

import { createHash } from "node:crypto";

function sortedUnique(values = []) {
  return [...new Set(values)].sort();
}

function isSubset(subset, superset) {
  const allowed = new Set(superset);
  return subset.every((value) => allowed.has(value));
}

function valueOr(value, fallback) {
  return value === undefined ? fallback : value;
}

export function canonicalJson(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const entries = Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`);
  return `{${entries.join(",")}}`;
}

export function sha256Urn(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function proposalPayloadHash(proposal) {
  const { canonical_payload_hash: _ignored, ...payload } = proposal;
  return sha256Urn(canonicalJson(payload));
}

export function ruleForState(policy, state) {
  return policy.state_rules.find((rule) => rule.state === state);
}

export function approvalMatchesProposal(proposal, approval) {
  return (
    approval.tenant_id === proposal.tenant_id &&
    approval.proposal_id === proposal.proposal_id &&
    approval.canonical_payload_hash === proposal.canonical_payload_hash
  );
}

export function isRuleAtLeastAsStrong(current, candidate) {
  if (!current || !candidate || current.state !== candidate.state) return false;

  // A previously prohibited state cannot become permitted.
  if (!current.permitted && candidate.permitted) return false;

  const currentQuorum = current.quorum;
  const candidateQuorum = candidate.quorum;
  if (candidateQuorum.minimum_approvals < currentQuorum.minimum_approvals) return false;

  if (
    !isSubset(
      sortedUnique(currentQuorum.required_participant_ids),
      sortedUnique(candidateQuorum.required_participant_ids),
    )
  ) {
    return false;
  }
  if (
    !isSubset(
      sortedUnique(currentQuorum.required_roles),
      sortedUnique(candidateQuorum.required_roles),
    )
  ) {
    return false;
  }

  // Longer delays are stricter; shorter delegated authority is stricter.
  if (valueOr(candidate.cooldown_ms, 0) < valueOr(current.cooldown_ms, 0)) return false;
  if (
    valueOr(candidate.challenge_window_ms, 0) <
    valueOr(current.challenge_window_ms, 0)
  ) {
    return false;
  }
  if (
    current.authority_ttl_ms !== undefined &&
    (candidate.authority_ttl_ms === undefined ||
      candidate.authority_ttl_ms > current.authority_ttl_ms)
  ) {
    return false;
  }

  const oldConstraints = current.constraints;
  const nextConstraints = candidate.constraints;

  // true is stricter only for equivalent_access_only.
  if (oldConstraints.equivalent_access_only && !nextConstraints.equivalent_access_only) {
    return false;
  }

  // false is stricter for authority-granting booleans.
  for (const field of [
    "ownership_changes_allowed",
    "policy_weakening_allowed",
    "audit_deletion_allowed",
    "related_party_transfers_allowed",
  ]) {
    if (!oldConstraints[field] && nextConstraints[field]) return false;
  }

  if (
    oldConstraints.maximum_amount_minor_units !== undefined &&
    (nextConstraints.maximum_amount_minor_units === undefined ||
      nextConstraints.maximum_amount_minor_units >
        oldConstraints.maximum_amount_minor_units)
  ) {
    return false;
  }

  const oldAllowed = oldConstraints.allowed_action_kinds;
  const nextAllowed = nextConstraints.allowed_action_kinds;
  if (oldAllowed !== undefined) {
    if (nextAllowed === undefined || !isSubset(nextAllowed, oldAllowed)) return false;
  }

  const oldDenied = sortedUnique(oldConstraints.denied_action_kinds);
  const nextDenied = sortedUnique(nextConstraints.denied_action_kinds);
  if (!isSubset(oldDenied, nextDenied)) return false;

  return true;
}

export function isPolicyReplacementNonWeakening(current, candidate) {
  if (candidate.tenant_id !== current.tenant_id) return false;
  if (candidate.policy_id !== current.policy_id) return false;
  if (candidate.action_kind !== current.action_kind) return false;
  if (candidate.action_class !== current.action_class) return false;
  if (candidate.version <= current.version) return false;
  if (candidate.replaces_policy_hash !== current.policy_hash) return false;

  const currentByState = new Map(current.state_rules.map((rule) => [rule.state, rule]));
  const candidateByState = new Map(candidate.state_rules.map((rule) => [rule.state, rule]));

  for (const [state, currentRule] of currentByState) {
    if (!isRuleAtLeastAsStrong(currentRule, candidateByState.get(state))) return false;
  }

  // Absence means prohibited. A new state may only be added explicitly prohibited.
  for (const [state, candidateRule] of candidateByState) {
    if (!currentByState.has(state) && candidateRule.permitted) return false;
  }

  return true;
}

export function approvalsSatisfyProposal(policy, proposal, approvals, nowMs) {
  if (proposal.policy_id !== policy.policy_id) return false;
  if (proposal.policy_version !== policy.version) return false;
  if (proposal.policy_hash !== policy.policy_hash) return false;
  if (proposal.action_kind !== policy.action_kind) return false;
  if (proposal.action_class !== policy.action_class) return false;
  if (proposal.canonical_payload_hash !== proposalPayloadHash(proposal)) return false;
  if (proposal.expires_at_ms <= nowMs) return false;

  const rule = ruleForState(policy, proposal.continuity_state);
  if (!rule?.permitted) return false;

  const earliestExecutionMs =
    proposal.created_at_ms +
    Math.max(valueOr(rule.cooldown_ms, 0), valueOr(rule.challenge_window_ms, 0));
  if (nowMs < earliestExecutionMs) return false;

  const uniqueByParticipant = new Map();
  for (const approval of approvals) {
    if (!approvalMatchesProposal(proposal, approval)) continue;
    if (approval.approved_at_ms < proposal.created_at_ms) continue;
    if (approval.approved_at_ms > nowMs) continue;
    uniqueByParticipant.set(approval.participant_id, approval);
  }

  const accepted = [...uniqueByParticipant.values()];
  if (accepted.length < rule.quorum.minimum_approvals) return false;

  const participantIds = new Set(accepted.map((approval) => approval.participant_id));
  for (const participantId of rule.quorum.required_participant_ids ?? []) {
    if (!participantIds.has(participantId)) return false;
  }

  const roles = new Set(accepted.map((approval) => approval.participant_role));
  for (const role of rule.quorum.required_roles ?? []) {
    if (!roles.has(role)) return false;
  }

  return true;
}
