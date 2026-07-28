// Deterministic bounded adversarial explorer for DEN-473.
//
// This is not a proof about external providers or legal authority. It exhaustively
// checks the finite product defined below against the executable discovery models
// and emits minimal structured counterexamples instead of stopping at first failure.

import {
  ACTIONS,
  DEFAULT_PARTICIPANTS,
  STATES,
  TRANSITION_RULES,
  applyTransition,
  authorizeAction,
  authorizeTransition,
  subsets,
} from "./founder-governance-state-model.mjs";
import {
  ExecutionLedger,
  SimulatedProvider,
  actionParametersHash,
  detectProviderDrift,
  executeProtectedAction,
} from "./founder-governance-executor-model.mjs";

const CONTEXT_FIELDS = Object.freeze([
  "bounded",
  "equivalent_access_only",
  "defensive_only",
  "preapproved",
  "legal_authority_attested",
]);

const CONTINUITY_STATES = new Set([
  "temporarily_unavailable",
  "provisional_incapacity",
  "confirmed_long_term_incapacity",
  "voluntary_exit",
  "nonparticipation",
  "active_deadlock",
]);

const DAY_MS = 24 * 60 * 60 * 1000;

function booleanContexts() {
  return Array.from({ length: 2 ** CONTEXT_FIELDS.length }, (_, mask) =>
    Object.fromEntries(
      CONTEXT_FIELDS.map((field, index) => [field, (mask & (1 << index)) !== 0]),
    ),
  );
}

function participantVariants() {
  const variants = [{ id: "all-active", participants: structuredClone(DEFAULT_PARTICIPANTS) }];
  for (const participant of DEFAULT_PARTICIPANTS) {
    for (const status of ["suspended", "revoked"]) {
      const participants = structuredClone(DEFAULT_PARTICIPANTS);
      participants.find((candidate) => candidate.participant_id === participant.participant_id).status =
        status;
      variants.push({ id: `${participant.participant_id}:${status}`, participants });
    }
  }
  return variants;
}

function activeSelectedCount(participantIds, participants) {
  const selected = new Set(participantIds);
  return participants.filter(
    (participant) => selected.has(participant.participant_id) && participant.status === "active",
  ).length;
}

function counterexample(kind, details) {
  return Object.freeze({ kind, ...details });
}

export function exploreActionAuthorization() {
  const participantIds = DEFAULT_PARTICIPANTS.map((participant) => participant.participant_id);
  const participantSets = subsets(participantIds);
  const contexts = booleanContexts();
  const failures = [];
  let cases = 0;
  let authorizedCases = 0;

  for (const variant of participantVariants()) {
    for (const state of STATES) {
      for (const [actionKind, actionClass] of Object.entries(ACTIONS)) {
        for (const selected of participantSets) {
          for (const context of contexts) {
            cases += 1;
            const authorized = authorizeAction({
              state,
              action_kind: actionKind,
              participant_ids: selected,
              participants: variant.participants,
              context,
            });
            if (!authorized) continue;
            authorizedCases += 1;

            const activeCount = activeSelectedCount(selected, variant.participants);
            if (actionClass === "constitutional" && activeCount <= 1) {
              failures.push(
                counterexample("unilateral_constitutional_action", {
                  variant: variant.id,
                  state,
                  action_kind: actionKind,
                  participant_ids: selected,
                  context,
                }),
              );
            }
            if (CONTINUITY_STATES.has(state) && actionClass === "constitutional") {
              failures.push(
                counterexample("continuity_constitutional_action", {
                  variant: variant.id,
                  state,
                  action_kind: actionKind,
                  participant_ids: selected,
                  context,
                }),
              );
            }
            if (
              CONTINUITY_STATES.has(state) &&
              actionClass === "recovery" &&
              context.equivalent_access_only !== true
            ) {
              failures.push(
                counterexample("recovery_without_equivalent_access", {
                  variant: variant.id,
                  state,
                  participant_ids: selected,
                  context,
                }),
              );
            }
            if (
              CONTINUITY_STATES.has(state) &&
              actionClass === "emergency" &&
              context.defensive_only !== true
            ) {
              failures.push(
                counterexample("emergency_without_defensive_scope", {
                  variant: variant.id,
                  state,
                  participant_ids: selected,
                  context,
                }),
              );
            }
          }
        }
      }
    }
  }

  for (const variant of participantVariants().filter((candidate) => candidate.id !== "all-active")) {
    const [mutatedParticipantId] = variant.id.split(":");
    for (const state of STATES) {
      for (const actionKind of Object.keys(ACTIONS)) {
        for (const selected of participantSets.filter((set) => !set.includes(mutatedParticipantId))) {
          const withInactive = [...selected, mutatedParticipantId];
          for (const context of contexts) {
            const without = authorizeAction({
              state,
              action_kind: actionKind,
              participant_ids: selected,
              participants: variant.participants,
              context,
            });
            const withCandidate = authorizeAction({
              state,
              action_kind: actionKind,
              participant_ids: withInactive,
              participants: variant.participants,
              context,
            });
            if (!without && withCandidate) {
              failures.push(
                counterexample("inactive_participant_increased_authority", {
                  variant: variant.id,
                  state,
                  action_kind: actionKind,
                  participant_ids: withInactive,
                  context,
                }),
              );
            }
          }
        }
      }
    }
  }

  const witnesses = {
    bounded_routine_continuity: authorizeAction({
      state: "temporarily_unavailable",
      action_kind: "routine.deploy",
      participant_ids: ["founder-a"],
      context: { bounded: true },
    }),
    equivalent_access_recovery: authorizeAction({
      state: "provisional_incapacity",
      action_kind: "recovery.replace_credential",
      participant_ids: ["founder-a", "guardian-1"],
      context: { equivalent_access_only: true },
    }),
    defensive_emergency: authorizeAction({
      state: "nonparticipation",
      action_kind: "emergency.freeze_external_transfers",
      participant_ids: ["founder-a", "guardian-1"],
      context: { defensive_only: true },
    }),
    deadlock_preapproved_routine: authorizeAction({
      state: "active_deadlock",
      action_kind: "routine.pay_existing_vendor",
      participant_ids: ["operator-1"],
      context: { bounded: true, preapproved: true },
    }),
    succession_constitutional_process: authorizeAction({
      state: "succession",
      action_kind: "constitutional.transfer_ip",
      participant_ids: ["founder-a", "guardian-1", "estate-1"],
      context: { legal_authority_attested: true },
    }),
  };

  return Object.freeze({ cases, authorizedCases, failures, witnesses });
}

function approversForRule(rule) {
  const selected = new Set(rule.required_participant_ids ?? []);
  for (const role of rule.required_roles ?? []) {
    const participant = DEFAULT_PARTICIPANTS.find((candidate) => candidate.roles.includes(role));
    if (!participant) throw new Error(`no participant for required role ${role}`);
    selected.add(participant.participant_id);
  }
  if (rule.subject_must_approve) selected.add("founder-a");
  for (const participant of DEFAULT_PARTICIPANTS) {
    if (selected.size >= rule.minimum_approvals) break;
    selected.add(participant.participant_id);
  }
  return [...selected];
}

function validTransitionRequest(rule, generation = 7) {
  const readyDelay = Math.max(rule.cooldown_ms ?? 0, rule.challenge_window_ms ?? 0);
  const createdAt = 1_000_000;
  const now = createdAt + readyDelay + 1;
  const subject = rule.subject_must_approve ? "founder-a" : "founder-b";
  return {
    now,
    request: {
      transition_id: `${rule.from}->${rule.to}`,
      from_state: rule.from,
      to_state: rule.to,
      expected_generation: generation,
      subject_participant_id: subject,
      approver_ids: approversForRule(rule),
      notice_recipient_ids: [...(rule.required_notice_ids ?? [])],
      evidence_refs: Array.from({ length: rule.minimum_evidence ?? 0 }, (_, index) => `e-${index}`),
      external_attestation_refs: Array.from(
        { length: rule.minimum_external_attestations ?? 0 },
        (_, index) => `a-${index}`,
      ),
      mediation_completed: rule.mediation_required === true,
      created_at_ms: createdAt,
      expires_at_ms: now + DAY_MS,
    },
  };
}

export function exploreTransitions() {
  const failures = [];
  const witnesses = [];
  let negativeCases = 0;

  const edgeKeys = TRANSITION_RULES.map((rule) => `${rule.from}->${rule.to}`);
  if (new Set(edgeKeys).size !== edgeKeys.length) {
    failures.push(counterexample("duplicate_transition_edge", { edge_keys: edgeKeys }));
  }

  for (const rule of TRANSITION_RULES) {
    const { request, now } = validTransitionRequest(rule);
    const args = {
      current_state: rule.from,
      current_generation: request.expected_generation,
      request,
      now_ms: now,
    };
    if (!authorizeTransition(args)) {
      failures.push(counterexample("valid_transition_unreachable", { rule, request, now }));
      continue;
    }
    const applied = applyTransition(args);
    if (
      !applied ||
      applied.state !== rule.to ||
      applied.generation !== request.expected_generation + 1
    ) {
      failures.push(counterexample("transition_apply_invalid", { rule, request, applied }));
    } else {
      witnesses.push({ from: rule.from, to: rule.to, generation: applied.generation });
    }

    const mutations = [
      (candidate) => {
        candidate.expected_generation += 1;
      },
      (candidate) => {
        candidate.expires_at_ms = now;
      },
      (candidate) => {
        candidate.approver_ids = candidate.approver_ids.slice(1);
      },
      (candidate) => {
        candidate.notice_recipient_ids = candidate.notice_recipient_ids.slice(1);
      },
    ];
    if ((rule.minimum_evidence ?? 0) > 0) {
      mutations.push((candidate) => {
        candidate.evidence_refs = candidate.evidence_refs.slice(1);
      });
    }
    if ((rule.minimum_external_attestations ?? 0) > 0) {
      mutations.push((candidate) => {
        candidate.external_attestation_refs = candidate.external_attestation_refs.slice(1);
      });
    }
    if (rule.mediation_required) {
      mutations.push((candidate) => {
        candidate.mediation_completed = false;
      });
    }
    if (rule.subject_must_approve) {
      mutations.push((candidate) => {
        candidate.approver_ids = candidate.approver_ids.filter(
          (participantId) => participantId !== candidate.subject_participant_id,
        );
      });
    }

    for (const mutate of mutations) {
      const candidate = structuredClone(request);
      mutate(candidate);
      negativeCases += 1;
      if (
        authorizeTransition({
          current_state: rule.from,
          current_generation: request.expected_generation,
          request: candidate,
          now_ms: now,
        })
      ) {
        failures.push(counterexample("invalid_transition_authorized", { rule, candidate, now }));
      }
    }
  }

  return Object.freeze({ cases: TRANSITION_RULES.length + negativeCases, failures, witnesses });
}

function actionParameters(actionKind) {
  switch (actionKind) {
    case "routine.deploy":
      return { commit_sha: "abc123" };
    case "routine.pay_existing_vendor":
      return { payment_id: "payment-1" };
    case "sensitive.rotate_secret":
      return { secret_version: 2 };
    case "sensitive.change_cloud_admin":
      return { principal_id: "principal-2" };
    case "constitutional.issue_equity":
      return { issue_id: "equity-1" };
    case "constitutional.weaken_policy":
      return { policy_id: "policy-1" };
    case "constitutional.transfer_ip":
      return { transfer_id: "ip-1" };
    case "recovery.replace_credential":
      return { credential_id: "credential-2" };
    case "emergency.revoke_compromised_credential":
      return { credential_id: "credential-1" };
    case "emergency.freeze_external_transfers":
      return { freeze_id: "freeze-1" };
    default:
      throw new Error(`unknown action ${actionKind}`);
  }
}

function proposalFor(actionKind, parameters, suffix = "1") {
  return {
    tenant_id: "company-123",
    proposal_id: `proposal-${suffix}`,
    action_kind: actionKind,
    action_class: ACTIONS[actionKind],
    parameters_hash: actionParametersHash(parameters),
    policy_id: "policy-1",
    policy_version: 1,
    policy_hash: `sha256:${"a".repeat(64)}`,
    canonical_payload_hash: `sha256:${suffix.padEnd(64, "b").slice(0, 64)}`,
  };
}

function authorizationFor(proposal, generation, mode = "delegated_authority") {
  return {
    authorized: true,
    mode,
    tenant_id: proposal.tenant_id,
    proposal_hash: proposal.canonical_payload_hash,
    policy_hash: proposal.policy_hash,
    policy_version: proposal.policy_version,
    state_generation: generation,
    participant_id: "founder-a",
  };
}

function capabilityFor(actionKind, generation, overrides = {}) {
  return {
    tenant_id: "company-123",
    authority_id: "authority-1",
    grantee_participant_id: "founder-a",
    status: "active",
    state_generation: generation,
    allowed_action_kinds: [actionKind],
    constraints: {
      equivalent_access_only: true,
      ownership_changes_allowed: false,
      policy_weakening_allowed: false,
      audit_deletion_allowed: false,
      related_party_transfers_allowed: false,
      allowed_action_kinds: [actionKind],
      denied_action_kinds: [
        "constitutional.issue_equity",
        "constitutional.weaken_policy",
        "constitutional.transfer_ip",
      ],
    },
    issued_at_ms: 1_000,
    expires_at_ms: 100_000,
    ...overrides,
  };
}

export function exploreExecutorSafety() {
  const failures = [];
  let cases = 0;

  for (const actionKind of Object.keys(ACTIONS).filter(
    (candidate) => ACTIONS[candidate] === "constitutional",
  )) {
    cases += 1;
    const parameters = actionParameters(actionKind);
    const proposal = proposalFor(actionKind, parameters, actionKind);
    const provider = new SimulatedProvider();
    const result = executeProtectedAction({
      proposal,
      parameters,
      authorization: authorizationFor(proposal, 8),
      capability: capabilityFor(actionKind, 8, {
        constraints: {
          equivalent_access_only: false,
          ownership_changes_allowed: true,
          policy_weakening_allowed: true,
          audit_deletion_allowed: true,
          related_party_transfers_allowed: true,
          allowed_action_kinds: [actionKind],
          denied_action_kinds: [],
        },
      }),
      currentGeneration: 8,
      fencingScope: "connector:sandbox",
      fencingToken: 11,
      activeFencingToken: 11,
      ledger: new ExecutionLedger(),
      provider,
      nowMs: 10_000,
    });
    if (result.outcome !== "rejected" || provider.applyCount !== 0) {
      failures.push(counterexample("delegated_constitutional_execution", { actionKind, result }));
    }
  }

  {
    cases += 1;
    const parameters = actionParameters("routine.deploy");
    const proposal = proposalFor("routine.deploy", parameters, "stale");
    const provider = new SimulatedProvider();
    const result = executeProtectedAction({
      proposal,
      parameters,
      authorization: authorizationFor(proposal, 8, "direct_quorum"),
      currentGeneration: 8,
      fencingScope: "connector:github",
      fencingToken: 10,
      activeFencingToken: 11,
      ledger: new ExecutionLedger(),
      provider,
      nowMs: 10_000,
    });
    if (result.safe_reason_code !== "stale_fencing_token" || provider.applyCount !== 0) {
      failures.push(counterexample("stale_executor_mutated_provider", { result }));
    }
  }

  {
    cases += 1;
    const parameters = actionParameters("routine.deploy");
    const proposal = proposalFor("routine.deploy", parameters, "unknown");
    const provider = new SimulatedProvider();
    provider.setBehavior("routine.deploy", "throw_before_apply");
    const ledger = new ExecutionLedger();
    const first = executeProtectedAction({
      proposal,
      parameters,
      authorization: authorizationFor(proposal, 8, "direct_quorum"),
      currentGeneration: 8,
      fencingScope: "connector:github",
      fencingToken: 11,
      activeFencingToken: 11,
      ledger,
      provider,
      nowMs: 10_000,
    });
    const second = executeProtectedAction({
      proposal,
      parameters,
      authorization: authorizationFor(proposal, 8, "direct_quorum"),
      currentGeneration: 8,
      fencingScope: "connector:github",
      fencingToken: 12,
      activeFencingToken: 12,
      ledger,
      provider,
      nowMs: 10_001,
    });
    if (
      first.outcome !== "unknown" ||
      second.outcome !== "unknown" ||
      provider.applyCount !== 1 ||
      ledger.receiptByIdempotencyKey.size !== 0 ||
      ledger.pendingByIdempotencyKey.size !== 1
    ) {
      failures.push(counterexample("unknown_provider_result_promoted_without_evidence", { first, second }));
    }
  }

  {
    cases += 1;
    const alerts = detectProviderDrift({
      expectedState: { org_owner: "fiducia-executor", cloud_admin: "fiducia-executor" },
      actualState: { org_owner: "founder-personal" },
      protectedFields: ["org_owner", "cloud_admin"],
    });
    if (
      alerts.length !== 2 ||
      alerts.some(
        (alert) =>
          alert.severity !== "critical" || alert.recommended_action !== "freeze_and_reconcile",
      )
    ) {
      failures.push(counterexample("protected_drift_not_frozen", { alerts }));
    }
  }

  return Object.freeze({ cases, failures });
}

export function runAdversarialStateSpace() {
  const action = exploreActionAuthorization();
  const transitions = exploreTransitions();
  const executor = exploreExecutorSafety();
  return Object.freeze({
    bounds: Object.freeze({
      states: STATES.length,
      actions: Object.keys(ACTIONS).length,
      participant_subsets: 2 ** DEFAULT_PARTICIPANTS.length,
      participant_status_variants: participantVariants().length,
      contexts: 2 ** CONTEXT_FIELDS.length,
      transition_rules: TRANSITION_RULES.length,
    }),
    cases: action.cases + transitions.cases + executor.cases,
    failures: Object.freeze([...action.failures, ...transitions.failures, ...executor.failures]),
    witnesses: Object.freeze({
      actions: action.witnesses,
      transitions: transitions.witnesses,
    }),
  });
}
