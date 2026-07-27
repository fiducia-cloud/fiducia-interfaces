import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_PARTICIPANTS,
  STATES,
  TRANSITION_RULES,
  applyTransition,
  authorizeAction,
  authorizeTransition,
  reachableStates,
  subsets,
  transitionRule,
} from "../design/founder-governance-state-model.mjs";

const PARTICIPANT_IDS = DEFAULT_PARTICIPANTS.map((participant) => participant.participant_id);
const DAY = 24 * 60 * 60 * 1000;

function transitionRequest(overrides = {}) {
  return {
    transition_id: "transition-1",
    from_state: "normal",
    to_state: "temporarily_unavailable",
    expected_generation: 7,
    subject_participant_id: "founder-b",
    approver_ids: ["founder-a", "guardian-1"],
    notice_recipient_ids: ["founder-a", "founder-b", "guardian-1"],
    evidence_refs: ["sha256:evidence-1"],
    external_attestation_refs: [],
    mediation_completed: false,
    created_at_ms: 1_000_000,
    expires_at_ms: 1_000_000 + 10 * DAY,
    ...overrides,
  };
}

test("every state is reachable from normal through an explicit transition path", () => {
  assert.deepEqual([...reachableStates("normal")].sort(), [...STATES].sort());
});

test("transition catalog has unique directed edges and no self-renewal edges", () => {
  const keys = TRANSITION_RULES.map((rule) => `${rule.from}->${rule.to}`);
  assert.equal(new Set(keys).size, keys.length);
  assert.ok(TRANSITION_RULES.every((rule) => rule.from !== rule.to));
});

test("no single participant can authorize a constitutional action in any state", () => {
  for (const state of STATES) {
    for (const participantId of PARTICIPANT_IDS) {
      assert.equal(
        authorizeAction({
          state,
          action_kind: "constitutional.issue_equity",
          participant_ids: [participantId],
          context: {
            bounded: true,
            equivalent_access_only: true,
            defensive_only: true,
            preapproved: true,
            legal_authority_attested: true,
          },
        }),
        false,
        `${participantId} alone authorized constitutional action in ${state}`,
      );
    }
  }
});

test("unknown actions fail closed instead of inheriting routine authority", () => {
  assert.equal(
    authorizeAction({
      state: "normal",
      action_kind: "provider.new_unclassified_root_action",
      participant_ids: ["founder-a", "founder-b", "guardian-1"],
      context: { bounded: true },
    }),
    false,
  );
});

test("normal sensitive and constitutional actions require both distinct founders", () => {
  for (const actionKind of [
    "sensitive.rotate_secret",
    "constitutional.weaken_policy",
  ]) {
    assert.equal(
      authorizeAction({
        state: "normal",
        action_kind: actionKind,
        participant_ids: ["founder-a"],
      }),
      false,
    );
    assert.equal(
      authorizeAction({
        state: "normal",
        action_kind: actionKind,
        participant_ids: ["founder-a", "founder-a"],
      }),
      false,
    );
    assert.equal(
      authorizeAction({
        state: "normal",
        action_kind: actionKind,
        participant_ids: ["founder-a", "founder-b"],
      }),
      true,
    );
  }
});

test("temporary unavailability preserves bounded routine liveness", () => {
  assert.equal(
    authorizeAction({
      state: "temporarily_unavailable",
      action_kind: "routine.pay_existing_vendor",
      participant_ids: ["founder-a"],
      context: { bounded: true },
    }),
    true,
  );
  assert.equal(
    authorizeAction({
      state: "temporarily_unavailable",
      action_kind: "routine.pay_existing_vendor",
      participant_ids: ["founder-a"],
      context: { bounded: false },
    }),
    false,
  );
});

test("continuity sensitive authority requires founder, guardian, scope, and bounds", () => {
  const base = {
    state: "temporarily_unavailable",
    action_kind: "sensitive.rotate_secret",
    participant_ids: ["founder-a", "guardian-1"],
    context: { bounded: true, equivalent_access_only: true },
  };
  assert.equal(authorizeAction(base), true);
  assert.equal(
    authorizeAction({ ...base, participant_ids: ["founder-a", "founder-b"] }),
    false,
  );
  assert.equal(
    authorizeAction({ ...base, context: { bounded: true, equivalent_access_only: false } }),
    false,
  );
});

test("emergency authority is defensive and never becomes constitutional authority", () => {
  assert.equal(
    authorizeAction({
      state: "provisional_incapacity",
      action_kind: "emergency.revoke_compromised_credential",
      participant_ids: ["founder-a", "guardian-1"],
      context: { defensive_only: true },
    }),
    true,
  );
  assert.equal(
    authorizeAction({
      state: "provisional_incapacity",
      action_kind: "emergency.revoke_compromised_credential",
      participant_ids: ["founder-a", "guardian-1"],
      context: { defensive_only: false },
    }),
    false,
  );
  assert.equal(
    authorizeAction({
      state: "provisional_incapacity",
      action_kind: "constitutional.transfer_ip",
      participant_ids: ["founder-a", "guardian-1", "estate-1"],
      context: { defensive_only: true, legal_authority_attested: true },
    }),
    false,
  );
});

test("active deadlock allows only preapproved bounded routine operations", () => {
  const base = {
    state: "active_deadlock",
    action_kind: "routine.deploy",
    participant_ids: ["operator-1"],
  };
  assert.equal(authorizeAction({ ...base, context: { bounded: true, preapproved: true } }), true);
  assert.equal(authorizeAction({ ...base, context: { bounded: true, preapproved: false } }), false);
});

test("all approval subsets preserve the constitutional singleton safety property", () => {
  for (const ids of subsets(PARTICIPANT_IDS)) {
    if (new Set(ids).size > 1) continue;
    for (const state of STATES) {
      assert.equal(
        authorizeAction({
          state,
          action_kind: "constitutional.weaken_policy",
          participant_ids: ids,
          context: { legal_authority_attested: true },
        }),
        false,
      );
    }
  }
});

test("a valid normal-to-temporary transition requires founder and guardian after the challenge window", () => {
  const request = transitionRequest();
  const readyAt = request.created_at_ms + 3 * DAY;
  assert.equal(
    authorizeTransition({
      current_state: "normal",
      current_generation: 7,
      request,
      now_ms: readyAt,
    }),
    true,
  );

  const applied = applyTransition({
    current_state: "normal",
    current_generation: 7,
    request,
    now_ms: readyAt,
  });
  assert.deepEqual(applied, {
    state: "temporarily_unavailable",
    generation: 8,
    transition_id: "transition-1",
    effective_at_ms: readyAt,
  });
});

test("transition requests fail closed on stale generation, missing guardian, evidence, notice, or delay", () => {
  const request = transitionRequest();
  const readyAt = request.created_at_ms + 3 * DAY;

  const cases = [
    { current_generation: 8 },
    { request: { ...request, approver_ids: ["founder-a"] } },
    { request: { ...request, evidence_refs: [] } },
    { request: { ...request, notice_recipient_ids: ["founder-a", "guardian-1"] } },
    { now_ms: readyAt - 1 },
  ];

  for (const testCase of cases) {
    assert.equal(
      authorizeTransition({
        current_state: "normal",
        current_generation: testCase.current_generation ?? 7,
        request: testCase.request ?? request,
        now_ms: testCase.now_ms ?? readyAt,
      }),
      false,
    );
  }
});

test("voluntary exit requires the subject founder's own approval", () => {
  const rule = transitionRule("normal", "voluntary_exit");
  assert.ok(rule?.subject_must_approve);

  const request = transitionRequest({
    to_state: "voluntary_exit",
    subject_participant_id: "founder-b",
    approver_ids: ["founder-a"],
    notice_recipient_ids: ["founder-a", "founder-b"],
  });
  assert.equal(
    authorizeTransition({
      current_state: "normal",
      current_generation: 7,
      request,
      now_ms: request.created_at_ms,
    }),
    false,
  );

  request.approver_ids = ["founder-b"];
  assert.equal(
    authorizeTransition({
      current_state: "normal",
      current_generation: 7,
      request,
      now_ms: request.created_at_ms,
    }),
    true,
  );
});

test("confirmed incapacity cannot reach succession without an estate representative", () => {
  const createdAt = 1_000_000;
  const request = transitionRequest({
    from_state: "confirmed_long_term_incapacity",
    to_state: "succession",
    approver_ids: ["founder-a", "guardian-1"],
    evidence_refs: ["e1", "e2"],
    external_attestation_refs: ["legal-attestation"],
    created_at_ms: createdAt,
    expires_at_ms: createdAt + 20 * DAY,
  });
  const readyAt = createdAt + 7 * DAY;

  assert.equal(
    authorizeTransition({
      current_state: "confirmed_long_term_incapacity",
      current_generation: 7,
      request,
      now_ms: readyAt,
    }),
    false,
  );

  request.approver_ids.push("estate-1");
  assert.equal(
    authorizeTransition({
      current_state: "confirmed_long_term_incapacity",
      current_generation: 7,
      request,
      now_ms: readyAt,
    }),
    true,
  );
});

test("nonparticipation cannot be declared without cure delay and mediation", () => {
  const createdAt = 1_000_000;
  const request = transitionRequest({
    to_state: "nonparticipation",
    evidence_refs: ["notice-1", "notice-2", "notice-3"],
    mediation_completed: false,
    created_at_ms: createdAt,
    expires_at_ms: createdAt + 90 * DAY,
  });
  const readyAt = createdAt + 45 * DAY;

  assert.equal(
    authorizeTransition({
      current_state: "normal",
      current_generation: 7,
      request,
      now_ms: readyAt,
    }),
    false,
  );

  request.mediation_completed = true;
  assert.equal(
    authorizeTransition({
      current_state: "normal",
      current_generation: 7,
      request,
      now_ms: readyAt,
    }),
    true,
  );
});
