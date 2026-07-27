// Non-canonical executable semantics for DEN-158/DEN-176 discovery.
// This module is intentionally outside the generated schema surface.
// It provides conservative safety checks; production authorization must fail closed.
// Production hashing must use a conforming RFC 8785 implementation and production
// approval evaluation must verify the actual cryptographic assertion.

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

function hasUniqueStateRules(policy) {
  if (!policy || !Array.isArray(policy.state_rules)) return false;
  const states = policy.state_rules.map((rule) => rule.state);
  return new Set(states).size === states.length;
}

function participantMap(participants) {
  if (!Array.isArray(participants)) return null;
  const result = new Map();
  for (const participant of participants) {
    if (!participant || result.has(participant.participant_id)) return null;
    result.set(participant.participant_id, participant);
  }
  return result;
}

function participantIsActiveForTenant(participant, tenantId, nowMs) {
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

function approvalIdentityIsAuthorized(proposal, approval, participant, nowMs) {
  if (!participantIsActiveForTenant(participant, proposal.tenant_id, nowMs)) return false;
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

function assertJsonValue(value, path = "$", ancestors = new Set()) {
  if (value === null) return;

  const kind = typeof value;
  if (kind === "string" || kind === "boolean") return;
  if (kind === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError(`non-finite JSON number at ${path}`);
    }
    return;
  }
  if (kind !== "object") {
    throw new TypeError(`non-JSON value at ${path}: ${kind}`);
  }

  if (ancestors.has(value)) {
    throw new TypeError(`cyclic JSON value at ${path}`);
  }
  ancestors.add(value);

  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      if (!(index in value)) {
        throw new TypeError(`sparse JSON array at ${path}[${index}]`);
      }
      assertJsonValue(value[index], `${path}[${index}]`, ancestors);
    }
    ancestors.delete(value);
    return;
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`non-plain JSON object at ${path}`);
  }
  for (const key of Object.keys(value)) {
    assertJsonValue(value[key], `${path}.${key}`, ancestors);
  }
  ancestors.delete(value);
}

function canonicalJsonUnchecked(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJsonUnchecked).join(",")}]`;
  }
  const entries = Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJsonUnchecked(value[key])}`);
  return `{${entries.join(",")}}`;
}

export function canonicalJson(value) {
  assertJsonValue(value);
  return canonicalJsonUnchecked(value);
}

export function sha256Urn(value) {
  if (typeof value !== "string") {
    throw new TypeError("sha256Urn input must be a string");
  }
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

export function policyPayloadHash(policy) {
  const { policy_hash: _ignored, ...payload } = policy;
  return sha256Urn(canonicalJson(payload));
}

export function proposalPayloadHash(proposal) {
  if (proposal.canonicalization !== "jcs_rfc8785") {
    throw new Error("unsupported proposal canonicalization");
  }
  const { canonical_payload_hash: _ignored, ...payload } = proposal;
  // This deterministic JSON subset is intentionally fail-closed. Promotion to a
  // canonical contract still requires cross-language RFC 8785 golden vectors.
  return sha256Urn(canonicalJson(payload));
}

export function ruleForState(policy, state) {
  if (!hasUniqueStateRules(policy)) return undefined;
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

  if (
    !isSubset(
      sortedUnique(current.notice_participant_ids),
      sortedUnique(candidate.notice_participant_ids),
    )
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
  if (!hasUniqueStateRules(current) || !hasUniqueStateRules(candidate)) return false;
  try {
    if (current.policy_hash !== policyPayloadHash(current)) return false;
    if (candidate.policy_hash !== policyPayloadHash(candidate)) return false;
  } catch {
    return false;
  }
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

export function approvalsSatisfyProposal(
  policy,
  proposal,
  approvals,
  participants,
  nowMs,
) {
  if (!hasUniqueStateRules(policy)) return false;
  try {
    if (policy.policy_hash !== policyPayloadHash(policy)) return false;
    if (proposal.canonical_payload_hash !== proposalPayloadHash(proposal)) return false;
  } catch {
    return false;
  }
  if (proposal.tenant_id !== policy.tenant_id) return false;
  if (proposal.policy_id !== policy.policy_id) return false;
  if (proposal.policy_version !== policy.version) return false;
  if (proposal.policy_hash !== policy.policy_hash) return false;
  if (proposal.action_kind !== policy.action_kind) return false;
  if (proposal.action_class !== policy.action_class) return false;
  if (proposal.created_at_ms > nowMs) return false;
  if (proposal.expires_at_ms <= proposal.created_at_ms) return false;
  if (proposal.expires_at_ms <= nowMs) return false;

  const rule = ruleForState(policy, proposal.continuity_state);
  if (!rule?.permitted) return false;

  const earliestExecutionMs =
    proposal.created_at_ms +
    Math.max(valueOr(rule.cooldown_ms, 0), valueOr(rule.challenge_window_ms, 0));
  if (nowMs < earliestExecutionMs) return false;

  const directory = participantMap(participants);
  if (!directory) return false;
  const proposer = directory.get(proposal.proposer_participant_id);
  if (!participantIsActiveForTenant(proposer, proposal.tenant_id, nowMs)) return false;

  const uniqueByParticipant = new Map();
  for (const approval of approvals) {
    if (!approvalMatchesProposal(proposal, approval)) continue;
    if (approval.approved_at_ms < proposal.created_at_ms) continue;
    const participant = directory.get(approval.participant_id);
    if (!approvalIdentityIsAuthorized(proposal, approval, participant, nowMs)) continue;
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
