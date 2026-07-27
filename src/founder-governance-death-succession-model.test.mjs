import assert from "node:assert/strict";
import { test } from "node:test";
import { DEATH_TRANSITIONS, applyDeathTransition, authorizeDeathStateAction,
  authorizeDeathTransition } from "../design/founder-governance-death-succession-model.mjs";

const DAY = 86_400_000, NOW = 2_000_000_000;
const participants = [
  ["founder-a", "founder"], ["founder-b", "founder"],
  ["guardian-1", "guardian"], ["estate-1", "estate_representative"],
  ["operator-1", "operator"],
].map(([participant_id, role]) => ({ participant_id, roles: [role], status: "active" }));
const evidence = (kind, id = kind) => ({ evidence_id: id, kind,
  content_hash: `sha256:${"a".repeat(64)}`, issuer: "external-attestor", issued_at_ms: NOW - DAY });
const request = (overrides = {}) => ({ transition_id: "death-1", from_state: "normal",
  to_state: "death_claim_pending", expected_generation: 7, subject_participant_id: "founder-b",
  requested_by_participant_id: "founder-a", approver_ids: ["founder-a", "guardian-1"],
  notice_recipient_ids: ["founder-a", "founder-b", "guardian-1", "estate-1"],
  evidence: [evidence("death_record")], external_attestation_refs: ["attestation-1"],
  process_assertions: [], created_at_ms: NOW - 4 * DAY, expires_at_ms: NOW + 30 * DAY,
  ...overrides });
const authorize = (req, state = req.from_state, generation = 7, people = participants) =>
  authorizeDeathTransition({ currentState: state, currentGeneration: generation,
    request: req, participants: people, nowMs: NOW });

test("death transition graph is unique and includes correction paths", () => {
  const edges = DEATH_TRANSITIONS.map((r) => `${r.from}->${r.to}`);
  assert.equal(new Set(edges).size, edges.length);
  assert.ok(edges.includes("death_claim_pending->restored"));
  assert.ok(edges.includes("death_confirmed->restored"));
});

test("surviving founder plus guardian may open a delayed claim, never confirm alone", () => {
  assert.equal(authorize(request()), true);
  const applied = applyDeathTransition({ currentState: "normal", currentGeneration: 7,
    request: request(), participants, nowMs: NOW });
  assert.deepEqual(applied, { state: "death_claim_pending", generation: 8,
    transition_id: "death-1", effective_at_ms: NOW });
  const confirm = request({ from_state: "death_claim_pending", to_state: "death_confirmed",
    expected_generation: 8, approver_ids: ["founder-a", "guardian-1"],
    external_attestation_refs: ["a", "b"], created_at_ms: NOW - 8 * DAY });
  assert.equal(authorize(confirm, "death_claim_pending", 8), false);
  confirm.approver_ids.push("estate-1");
  assert.equal(authorize(confirm, "death_claim_pending", 8), true);
});

test("subject cannot approve their own death declaration", () => {
  assert.equal(authorize(request({ approver_ids: ["founder-b", "guardian-1"] })), false);
});

test("claim fails on stale generation, evidence, notice, or delay", () => {
  assert.equal(authorize(request(), "normal", 8), false);
  assert.equal(authorize(request({ evidence: [] })), false);
  assert.equal(authorize(request({ notice_recipient_ids: ["founder-a", "guardian-1", "estate-1"] })), false);
  assert.equal(authorize(request({ created_at_ms: NOW - DAY })), false);
});

test("living subject can reverse a false claim only through strong correction", () => {
  const correction = request({ from_state: "death_claim_pending", to_state: "restored",
    expected_generation: 8, approver_ids: ["founder-a", "guardian-1"],
    evidence: [evidence("identity_verification")], created_at_ms: NOW - DAY });
  assert.equal(authorize(correction, "death_claim_pending", 8), false);
  correction.approver_ids = ["founder-b", "guardian-1"];
  assert.equal(authorize(correction, "death_claim_pending", 8), true);
});

test("death-pending mode preserves bounded routine work only", () => {
  const base = { state: "death_claim_pending", participantIds: ["founder-a"], participants };
  assert.equal(authorizeDeathStateAction({ ...base, actionClass: "routine",
    context: { bounded: true, preapproved: true } }), true);
  assert.equal(authorizeDeathStateAction({ ...base, actionClass: "routine",
    context: { bounded: true, preapproved: false } }), false);
  assert.equal(authorizeDeathStateAction({ ...base, actionClass: "constitutional",
    context: { legal_authority_attested: true } }), false);
});

test("succession constitutional action needs founder, guardian, estate, and legal authority", () => {
  const base = { state: "succession", actionClass: "constitutional", participants,
    context: { legal_authority_attested: true } };
  assert.equal(authorizeDeathStateAction({ ...base,
    participantIds: ["founder-a", "estate-1"] }), false);
  assert.equal(authorizeDeathStateAction({ ...base,
    participantIds: ["founder-a", "guardian-1", "estate-1"] }), true);
});
