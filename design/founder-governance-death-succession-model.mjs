// Executable death/succession process model for DEN-175. Technical process only:
// Fiducia does not determine legal death, estate authority, or ownership.
const DAY = 86_400_000;
const HASH = /^sha256:[0-9a-f]{64}$/;

export const DEATH_STATES = Object.freeze([
  "normal", "temporarily_unavailable", "provisional_incapacity",
  "confirmed_long_term_incapacity", "death_claim_pending",
  "death_confirmed", "succession", "restored",
]);

const NOTICE = ["founder-a", "founder-b", "guardian-1", "estate-1"];
const claim = (from) => ({ from, to: "death_claim_pending", approvals: 2,
  roles: ["founder", "guardian"], notice: NOTICE, death: 1, attestations: 1,
  delay: 72 * 3_600_000, excludeSubject: true });

export const DEATH_TRANSITIONS = Object.freeze([
  ...["normal", "temporarily_unavailable", "provisional_incapacity",
    "confirmed_long_term_incapacity"].map(claim),
  { from: "death_claim_pending", to: "death_confirmed", approvals: 3,
    roles: ["founder", "guardian", "estate_representative"], notice: NOTICE,
    death: 1, attestations: 2, delay: 7 * DAY, excludeSubject: true },
  { from: "death_confirmed", to: "succession", approvals: 3,
    roles: ["founder", "guardian", "estate_representative"], notice: NOTICE,
    death: 1, attestations: 1, delay: 72 * 3_600_000,
    legal: true, excludeSubject: true },
  { from: "death_claim_pending", to: "restored", approvals: 2,
    roles: ["founder", "guardian"], notice: NOTICE, identity: 1,
    attestations: 1, delay: 0, requireSubject: true },
  { from: "death_confirmed", to: "restored", approvals: 3,
    roles: ["founder", "guardian", "estate_representative"], notice: NOTICE,
    identity: 1, attestations: 2, delay: 72 * 3_600_000,
    legal: true, requireSubject: true },
]);

const mapById = (participants) => {
  const out = new Map();
  for (const p of participants ?? []) {
    if (!p?.participant_id || out.has(p.participant_id)) return null;
    out.set(p.participant_id, p);
  }
  return out;
};
const active = (p) => p?.status === "active";
const roles = (people) => new Set(people.flatMap((p) => p.roles ?? []));
const ruleFor = (from, to) => {
  const found = DEATH_TRANSITIONS.filter((r) => r.from === from && r.to === to);
  return found.length === 1 ? found[0] : null;
};
const evidenceCount = (items, kind, now) => {
  const ids = new Set(); let count = 0;
  for (const e of items ?? []) {
    if (!e?.evidence_id || ids.has(e.evidence_id) || !HASH.test(e.content_hash) ||
        !e.issuer || e.issued_at_ms > now || (e.expires_at_ms ?? Infinity) <= now) return -1;
    ids.add(e.evidence_id); if (e.kind === kind) count += 1;
  }
  return count;
};

export function authorizeDeathTransition({ currentState, currentGeneration, request,
  participants, nowMs }) {
  const rule = ruleFor(currentState, request?.to_state);
  if (!rule || request.from_state !== currentState ||
      request.expected_generation !== currentGeneration ||
      request.created_at_ms > nowMs || request.expires_at_ms <= nowMs ||
      request.expires_at_ms <= request.created_at_ms ||
      nowMs < request.created_at_ms + rule.delay) return false;

  const directory = mapById(participants); if (!directory) return false;
  const subject = directory.get(request.subject_participant_id);
  const requester = directory.get(request.requested_by_participant_id);
  if (!subject?.roles?.includes("founder") || !active(requester)) return false;

  const ids = [...new Set(request.approver_ids ?? [])];
  const approvers = ids.map((id) => directory.get(id));
  if (approvers.some((p) => !active(p)) || approvers.length < rule.approvals) return false;
  const have = roles(approvers);
  if (!rule.roles.every((role) => have.has(role))) return false;
  if (rule.excludeSubject && ids.includes(subject.participant_id)) return false;
  if (rule.requireSubject && !ids.includes(subject.participant_id)) return false;
  if (!rule.notice.every((id) => new Set(request.notice_recipient_ids ?? []).has(id))) return false;
  if (rule.death && evidenceCount(request.evidence, "death_record", nowMs) < rule.death) return false;
  if (rule.identity && evidenceCount(request.evidence, "identity_verification", nowMs) < rule.identity) return false;
  if ((request.external_attestation_refs?.length ?? 0) < rule.attestations) return false;
  if (rule.legal && !request.process_assertions?.includes("legal_authority_attested")) return false;
  return true;
}

export function applyDeathTransition(args) {
  if (!authorizeDeathTransition(args)) return null;
  return Object.freeze({ state: args.request.to_state,
    generation: args.currentGeneration + 1,
    transition_id: args.request.transition_id, effective_at_ms: args.nowMs });
}

const selected = (ids, participants) => {
  const d = mapById(participants); if (!d) return null;
  const people = [...new Set(ids ?? [])].map((id) => d.get(id));
  return people.some((p) => !active(p)) ? null : people;
};
const hasRoles = (people, needed) => { const have = roles(people); return needed.every((r) => have.has(r)); };

export function authorizeDeathStateAction({ state, actionClass, participantIds,
  participants, context = {} }) {
  const people = selected(participantIds, participants);
  if (!people || !DEATH_STATES.includes(state)) return false;
  if (["death_claim_pending", "death_confirmed"].includes(state)) {
    if (actionClass === "routine") return context.bounded === true && context.preapproved === true && hasRoles(people, ["founder"]);
    if (actionClass === "emergency") return context.defensive_only === true && hasRoles(people, ["founder", "guardian"]);
    return false;
  }
  if (state !== "succession") return false;
  if (actionClass === "routine") return context.bounded === true && roles(people).has("estate_representative");
  if (actionClass === "sensitive") return hasRoles(people, ["founder", "estate_representative"]);
  if (actionClass === "constitutional") return context.legal_authority_attested === true && hasRoles(people, ["founder", "guardian", "estate_representative"]);
  if (actionClass === "recovery") return context.equivalent_access_only === true && hasRoles(people, ["guardian", "estate_representative"]);
  return actionClass === "emergency" && context.defensive_only === true && hasRoles(people, ["founder", "guardian"]);
}
