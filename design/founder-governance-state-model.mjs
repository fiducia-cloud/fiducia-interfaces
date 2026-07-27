// Executable finite-state discovery model for DEN-175.
//
// These are conservative product defaults, not legal rules. The purpose is to
// make safety/liveness claims executable and to expose counterexamples early.

export const STATES = Object.freeze([
  "normal",
  "temporarily_unavailable",
  "provisional_incapacity",
  "confirmed_long_term_incapacity",
  "voluntary_exit",
  "nonparticipation",
  "active_deadlock",
  "succession",
  "restored",
]);

export const ACTIONS = Object.freeze({
  "routine.deploy": "routine",
  "routine.pay_existing_vendor": "routine",
  "sensitive.rotate_secret": "sensitive",
  "sensitive.change_cloud_admin": "sensitive",
  "constitutional.issue_equity": "constitutional",
  "constitutional.weaken_policy": "constitutional",
  "constitutional.transfer_ip": "constitutional",
  "recovery.replace_credential": "recovery",
  "emergency.revoke_compromised_credential": "emergency",
  "emergency.freeze_external_transfers": "emergency",
});

export const DEFAULT_PARTICIPANTS = Object.freeze([
  {
    participant_id: "founder-a",
    roles: ["founder"],
    status: "active",
  },
  {
    participant_id: "founder-b",
    roles: ["founder"],
    status: "active",
  },
  {
    participant_id: "guardian-1",
    roles: ["guardian"],
    status: "active",
  },
  {
    participant_id: "estate-1",
    roles: ["estate_representative"],
    status: "active",
  },
  {
    participant_id: "successor-1",
    roles: ["successor"],
    status: "active",
  },
  {
    participant_id: "operator-1",
    roles: ["operator"],
    status: "active",
  },
]);

const ALL_PROTECTED_NOTICE_IDS = Object.freeze([
  "founder-a",
  "founder-b",
  "guardian-1",
]);

export const TRANSITION_RULES = Object.freeze([
  {
    from: "normal",
    to: "temporarily_unavailable",
    minimum_approvals: 2,
    required_roles: ["founder", "guardian"],
    required_notice_ids: ALL_PROTECTED_NOTICE_IDS,
    minimum_evidence: 1,
    cooldown_ms: 72 * 60 * 60 * 1000,
    challenge_window_ms: 72 * 60 * 60 * 1000,
  },
  {
    from: "temporarily_unavailable",
    to: "restored",
    minimum_approvals: 2,
    required_roles: ["founder", "guardian"],
    required_notice_ids: ALL_PROTECTED_NOTICE_IDS,
    minimum_evidence: 1,
    cooldown_ms: 0,
    challenge_window_ms: 0,
  },
  {
    from: "temporarily_unavailable",
    to: "provisional_incapacity",
    minimum_approvals: 2,
    required_roles: ["founder", "guardian"],
    required_notice_ids: ALL_PROTECTED_NOTICE_IDS,
    minimum_evidence: 2,
    cooldown_ms: 7 * 24 * 60 * 60 * 1000,
    challenge_window_ms: 7 * 24 * 60 * 60 * 1000,
    minimum_external_attestations: 1,
  },
  {
    from: "provisional_incapacity",
    to: "restored",
    minimum_approvals: 2,
    required_roles: ["founder", "guardian"],
    required_notice_ids: ALL_PROTECTED_NOTICE_IDS,
    minimum_evidence: 1,
    cooldown_ms: 0,
    challenge_window_ms: 0,
  },
  {
    from: "provisional_incapacity",
    to: "confirmed_long_term_incapacity",
    minimum_approvals: 2,
    required_roles: ["founder", "guardian"],
    required_notice_ids: ALL_PROTECTED_NOTICE_IDS,
    minimum_evidence: 2,
    cooldown_ms: 30 * 24 * 60 * 60 * 1000,
    challenge_window_ms: 30 * 24 * 60 * 60 * 1000,
    minimum_external_attestations: 2,
  },
  {
    from: "confirmed_long_term_incapacity",
    to: "succession",
    minimum_approvals: 3,
    required_roles: ["founder", "guardian", "estate_representative"],
    required_notice_ids: ALL_PROTECTED_NOTICE_IDS,
    minimum_evidence: 2,
    cooldown_ms: 7 * 24 * 60 * 60 * 1000,
    challenge_window_ms: 7 * 24 * 60 * 60 * 1000,
    minimum_external_attestations: 1,
  },
  {
    from: "normal",
    to: "voluntary_exit",
    minimum_approvals: 1,
    required_roles: ["founder"],
    required_notice_ids: ["founder-a", "founder-b"],
    minimum_evidence: 1,
    cooldown_ms: 0,
    challenge_window_ms: 0,
    subject_must_approve: true,
  },
  {
    from: "voluntary_exit",
    to: "succession",
    minimum_approvals: 2,
    required_roles: ["founder", "guardian"],
    required_notice_ids: ALL_PROTECTED_NOTICE_IDS,
    minimum_evidence: 1,
    cooldown_ms: 0,
    challenge_window_ms: 0,
  },
  {
    from: "normal",
    to: "nonparticipation",
    minimum_approvals: 2,
    required_roles: ["founder", "guardian"],
    required_notice_ids: ALL_PROTECTED_NOTICE_IDS,
    minimum_evidence: 3,
    cooldown_ms: 45 * 24 * 60 * 60 * 1000,
    challenge_window_ms: 45 * 24 * 60 * 60 * 1000,
    mediation_required: true,
  },
  {
    from: "nonparticipation",
    to: "restored",
    minimum_approvals: 2,
    required_roles: ["founder", "guardian"],
    required_notice_ids: ALL_PROTECTED_NOTICE_IDS,
    minimum_evidence: 1,
    cooldown_ms: 0,
    challenge_window_ms: 0,
  },
  {
    from: "nonparticipation",
    to: "active_deadlock",
    minimum_approvals: 2,
    required_roles: ["founder", "guardian"],
    required_notice_ids: ALL_PROTECTED_NOTICE_IDS,
    minimum_evidence: 1,
    cooldown_ms: 0,
    challenge_window_ms: 0,
    mediation_required: true,
  },
  {
    from: "normal",
    to: "active_deadlock",
    minimum_approvals: 2,
    required_roles: ["founder"],
    required_participant_ids: ["founder-a", "founder-b"],
    required_notice_ids: ["founder-a", "founder-b"],
    minimum_evidence: 1,
    cooldown_ms: 0,
    challenge_window_ms: 0,
    mediation_required: true,
  },
  {
    from: "active_deadlock",
    to: "restored",
    minimum_approvals: 2,
    required_roles: ["founder"],
    required_participant_ids: ["founder-a", "founder-b"],
    required_notice_ids: ["founder-a", "founder-b"],
    minimum_evidence: 1,
    cooldown_ms: 0,
    challenge_window_ms: 0,
  },
  {
    from: "succession",
    to: "restored",
    minimum_approvals: 2,
    required_roles: ["founder", "estate_representative"],
    required_notice_ids: ALL_PROTECTED_NOTICE_IDS,
    minimum_evidence: 1,
    cooldown_ms: 0,
    challenge_window_ms: 0,
  },
]);

function participantDirectory(participants) {
  const directory = new Map();
  for (const participant of participants) {
    if (directory.has(participant.participant_id)) return null;
    directory.set(participant.participant_id, participant);
  }
  return directory;
}

function authorizedParticipants(participantIds, participants) {
  const directory = participantDirectory(participants);
  if (!directory) return null;

  const result = [];
  for (const participantId of new Set(participantIds)) {
    const participant = directory.get(participantId);
    if (!participant || participant.status !== "active") continue;
    result.push(participant);
  }
  return result;
}

function hasRole(participants, role) {
  return participants.some((participant) => participant.roles.includes(role));
}

function hasAllRoles(participants, roles = []) {
  return roles.every((role) => hasRole(participants, role));
}

function hasParticipant(participants, participantId) {
  return participants.some((participant) => participant.participant_id === participantId);
}

function hasAllParticipants(participants, participantIds = []) {
  return participantIds.every((participantId) => hasParticipant(participants, participantId));
}

function normalAuthorization(actionClass, participants) {
  switch (actionClass) {
    case "routine":
      return hasRole(participants, "founder") || hasRole(participants, "operator");
    case "sensitive":
    case "constitutional":
      return hasAllParticipants(participants, ["founder-a", "founder-b"]);
    case "recovery":
    case "emergency":
      return hasAllRoles(participants, ["founder", "guardian"]);
    default:
      return false;
  }
}

function continuityAuthorization(actionClass, participants, context) {
  switch (actionClass) {
    case "routine":
      return (
        context.bounded === true &&
        (hasRole(participants, "founder") || hasRole(participants, "operator"))
      );
    case "sensitive":
      return (
        context.bounded === true &&
        context.equivalent_access_only === true &&
        hasAllRoles(participants, ["founder", "guardian"])
      );
    case "constitutional":
      return false;
    case "recovery":
      return (
        context.equivalent_access_only === true &&
        hasAllRoles(participants, ["founder", "guardian"])
      );
    case "emergency":
      return (
        context.defensive_only === true &&
        hasAllRoles(participants, ["founder", "guardian"])
      );
    default:
      return false;
  }
}

function confirmedIncapacityAuthorization(actionClass, participants, context) {
  if (actionClass === "routine") {
    return (
      context.bounded === true &&
      (hasRole(participants, "founder") || hasRole(participants, "operator"))
    );
  }
  if (actionClass === "recovery") {
    return (
      context.equivalent_access_only === true &&
      hasAllRoles(participants, ["founder", "guardian", "estate_representative"])
    );
  }
  if (actionClass === "emergency") {
    return (
      context.defensive_only === true &&
      hasAllRoles(participants, ["founder", "guardian"])
    );
  }
  return false;
}

function deadlockAuthorization(actionClass, participants, context) {
  if (actionClass === "routine") {
    return (
      context.bounded === true &&
      context.preapproved === true &&
      (hasRole(participants, "founder") || hasRole(participants, "operator"))
    );
  }
  if (actionClass === "emergency") {
    return (
      context.defensive_only === true &&
      hasAllRoles(participants, ["founder", "guardian"])
    );
  }
  return false;
}

function successionAuthorization(actionClass, participants, context) {
  switch (actionClass) {
    case "routine":
      return (
        context.bounded === true &&
        (hasRole(participants, "founder") ||
          hasRole(participants, "successor") ||
          hasRole(participants, "estate_representative"))
      );
    case "sensitive":
      return hasAllRoles(participants, ["founder", "estate_representative"]);
    case "constitutional":
      return (
        context.legal_authority_attested === true &&
        hasAllRoles(participants, ["founder", "guardian", "estate_representative"])
      );
    case "recovery":
      return (
        context.equivalent_access_only === true &&
        hasAllRoles(participants, ["guardian", "estate_representative"])
      );
    case "emergency":
      return (
        context.defensive_only === true &&
        hasAllRoles(participants, ["founder", "guardian"])
      );
    default:
      return false;
  }
}

export function classifyAction(actionKind) {
  return ACTIONS[actionKind] ?? null;
}

export function authorizeAction({
  state,
  action_kind,
  participant_ids,
  participants = DEFAULT_PARTICIPANTS,
  context = {},
}) {
  if (!STATES.includes(state)) return false;
  const actionClass = classifyAction(action_kind);
  if (!actionClass) return false;
  const authorized = authorizedParticipants(participant_ids, participants);
  if (!authorized) return false;

  if (state === "normal" || state === "restored") {
    return normalAuthorization(actionClass, authorized);
  }
  if (
    state === "temporarily_unavailable" ||
    state === "provisional_incapacity" ||
    state === "nonparticipation"
  ) {
    return continuityAuthorization(actionClass, authorized, context);
  }
  if (state === "confirmed_long_term_incapacity") {
    return confirmedIncapacityAuthorization(actionClass, authorized, context);
  }
  if (state === "active_deadlock") {
    return deadlockAuthorization(actionClass, authorized, context);
  }
  if (state === "succession") {
    return successionAuthorization(actionClass, authorized, context);
  }
  if (state === "voluntary_exit") {
    // Freeze non-routine changes until the signed transition takes effect.
    return (
      actionClass === "routine" &&
      context.bounded === true &&
      (hasRole(authorized, "founder") || hasRole(authorized, "operator"))
    );
  }
  return false;
}

export function transitionRule(from, to) {
  const matches = TRANSITION_RULES.filter((rule) => rule.from === from && rule.to === to);
  return matches.length === 1 ? matches[0] : null;
}

export function authorizeTransition({
  current_state,
  current_generation,
  request,
  participants = DEFAULT_PARTICIPANTS,
  now_ms,
}) {
  if (!STATES.includes(current_state)) return false;
  if (request.from_state !== current_state) return false;
  if (request.to_state === current_state) return false;
  if (request.expected_generation !== current_generation) return false;
  if (request.expires_at_ms <= now_ms) return false;

  const rule = transitionRule(request.from_state, request.to_state);
  if (!rule) return false;

  const authorized = authorizedParticipants(request.approver_ids, participants);
  if (!authorized) return false;
  if (authorized.length < rule.minimum_approvals) return false;
  if (!hasAllRoles(authorized, rule.required_roles)) return false;
  if (!hasAllParticipants(authorized, rule.required_participant_ids)) return false;

  if (rule.subject_must_approve && !hasParticipant(authorized, request.subject_participant_id)) {
    return false;
  }

  if (!hasAllParticipants(
    request.notice_recipient_ids.map((participant_id) => ({ participant_id })),
    rule.required_notice_ids,
  )) {
    // hasAllParticipants normally consumes registry-shaped entries. Here it is used
    // as a set-containment helper over notice ids.
    return false;
  }

  if ((request.evidence_refs?.length ?? 0) < rule.minimum_evidence) return false;
  if (
    (request.external_attestation_refs?.length ?? 0) <
    (rule.minimum_external_attestations ?? 0)
  ) {
    return false;
  }
  if (rule.mediation_required && request.mediation_completed !== true) return false;

  const readyAt =
    request.created_at_ms + Math.max(rule.cooldown_ms, rule.challenge_window_ms);
  if (now_ms < readyAt) return false;

  return true;
}

export function applyTransition(args) {
  if (!authorizeTransition(args)) return null;
  return Object.freeze({
    state: args.request.to_state,
    generation: args.current_generation + 1,
    transition_id: args.request.transition_id,
    effective_at_ms: args.now_ms,
  });
}

export function subsets(values) {
  const result = [];
  for (let mask = 0; mask < 2 ** values.length; mask += 1) {
    const subset = [];
    for (let index = 0; index < values.length; index += 1) {
      if ((mask & (1 << index)) !== 0) subset.push(values[index]);
    }
    result.push(subset);
  }
  return result;
}

export function reachableStates(start = "normal") {
  const seen = new Set([start]);
  const queue = [start];
  while (queue.length > 0) {
    const from = queue.shift();
    for (const rule of TRANSITION_RULES) {
      if (rule.from !== from || seen.has(rule.to)) continue;
      seen.add(rule.to);
      queue.push(rule.to);
    }
  }
  return seen;
}
