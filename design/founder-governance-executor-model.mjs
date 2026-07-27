// Non-production executor model for DEN-178.
//
// This models policy-gated execution semantics independently of any specific
// GitHub/cloud SDK. It is deliberately fail-closed and deterministic so the
// connector contract can be reviewed before provider credentials are involved.

import {
  canonicalJson,
  sha256Urn,
} from "./founder-governance-reference.mjs";
import { classifyAction } from "./founder-governance-state-model.mjs";

export function actionParametersHash(parameters) {
  return sha256Urn(canonicalJson(parameters));
}

export function executionIdempotencyKey(proposal) {
  return sha256Urn(
    canonicalJson({
      tenant_id: proposal.tenant_id,
      proposal_id: proposal.proposal_id,
      canonical_payload_hash: proposal.canonical_payload_hash,
      action_kind: proposal.action_kind,
      parameters_hash: proposal.parameters_hash,
    }),
  );
}

export class ExecutionLedger {
  constructor() {
    this.highestFencingTokenByScope = new Map();
    this.receiptByIdempotencyKey = new Map();
    this.pendingByIdempotencyKey = new Map();
  }

  highestFencingToken(fencingScope) {
    return this.highestFencingTokenByScope.get(fencingScope) ?? 0;
  }

  claim({ tenantId, fencingScope, idempotencyKey, fencingToken, proposalHash }) {
    if (typeof fencingScope !== "string" || fencingScope.trim() === "") {
      return { kind: "rejected", reason: "fencing_scope_invalid" };
    }
    if (!Number.isSafeInteger(fencingToken) || fencingToken <= 0) {
      return { kind: "rejected", reason: "fencing_token_invalid" };
    }

    const existingReceipt = this.receiptByIdempotencyKey.get(idempotencyKey);
    if (existingReceipt) return { kind: "receipt", receipt: existingReceipt };

    const highWater = this.highestFencingToken(fencingScope);
    if (fencingToken < highWater) {
      return { kind: "rejected", reason: "stale_fencing_token" };
    }

    const pending = this.pendingByIdempotencyKey.get(idempotencyKey);
    if (pending) {
      if (
        pending.tenant_id !== tenantId ||
        pending.fencing_scope !== fencingScope ||
        pending.canonical_payload_hash !== proposalHash
      ) {
        return { kind: "rejected", reason: "idempotency_conflict" };
      }
      if (fencingToken < pending.fencing_token) {
        return { kind: "rejected", reason: "stale_fencing_token" };
      }

      this.highestFencingTokenByScope.set(fencingScope, Math.max(highWater, fencingToken));
      if (fencingToken > pending.fencing_token) {
        const takenOver = Object.freeze({
          ...pending,
          fencing_token: fencingToken,
        });
        this.pendingByIdempotencyKey.set(idempotencyKey, takenOver);
        return { kind: "pending", pending: takenOver, taken_over: true };
      }
      return { kind: "pending", pending };
    }

    this.highestFencingTokenByScope.set(fencingScope, Math.max(highWater, fencingToken));
    const record = Object.freeze({
      tenant_id: tenantId,
      fencing_scope: fencingScope,
      idempotency_key: idempotencyKey,
      fencing_token: fencingToken,
      canonical_payload_hash: proposalHash,
    });
    this.pendingByIdempotencyKey.set(idempotencyKey, record);
    return { kind: "claimed", pending: record };
  }

  recordReceipt(idempotencyKey, receipt) {
    this.pendingByIdempotencyKey.delete(idempotencyKey);
    this.receiptByIdempotencyKey.set(idempotencyKey, Object.freeze(receipt));
    return this.receiptByIdempotencyKey.get(idempotencyKey);
  }
}

export class SimulatedProvider {
  constructor() {
    this.state = {};
    this.applyCount = 0;
    this.behaviorByActionKind = new Map();
    this.requestLog = [];
  }

  setBehavior(actionKind, behavior) {
    this.behaviorByActionKind.set(actionKind, behavior);
  }

  apply({ actionKind, parameters, idempotencyKey }) {
    const prior = this.requestLog.find((entry) => entry.idempotency_key === idempotencyKey);
    if (prior) return structuredClone(prior.result);

    this.applyCount += 1;
    const behavior = this.behaviorByActionKind.get(actionKind) ?? "succeeded";
    let result;

    if (behavior === "throw_before_apply") {
      throw new Error("simulated provider transport failure");
    }
    if (behavior === "fail_before_apply") {
      result = { outcome: "failed", provider_request_id: `req-${this.applyCount}` };
    } else {
      applyProviderMutation(this.state, actionKind, parameters);
      if (behavior === "throw_after_apply") {
        this.requestLog.push({
          idempotency_key: idempotencyKey,
          action_kind: actionKind,
          parameters: structuredClone(parameters),
          result: { outcome: "unknown", provider_request_id: `req-${this.applyCount}` },
        });
        throw new Error("simulated provider response loss after apply");
      }
      if (behavior === "apply_then_timeout") {
        result = { outcome: "unknown", provider_request_id: `req-${this.applyCount}` };
      } else {
        result = { outcome: "succeeded", provider_request_id: `req-${this.applyCount}` };
      }
    }

    this.requestLog.push({
      idempotency_key: idempotencyKey,
      action_kind: actionKind,
      parameters: structuredClone(parameters),
      result: structuredClone(result),
    });
    return result;
  }

  reconcile({ actionKind, parameters, idempotencyKey }) {
    const prior = this.requestLog.find((entry) => entry.idempotency_key === idempotencyKey);
    if (!prior) return { outcome: "unknown" };
    if (providerStateMatches(this.state, actionKind, parameters)) {
      return {
        outcome: "succeeded",
        provider_request_id: prior.result.provider_request_id,
        reconciled: true,
      };
    }
    return {
      outcome: prior.result.outcome === "failed" ? "failed" : "unknown",
      provider_request_id: prior.result.provider_request_id,
      reconciled: true,
    };
  }
}

function applyProviderMutation(state, actionKind, parameters) {
  switch (actionKind) {
    case "routine.deploy":
      state.deployment_sha = parameters.commit_sha;
      return;
    case "routine.pay_existing_vendor":
      state.last_vendor_payment_id = parameters.payment_id;
      return;
    case "sensitive.rotate_secret":
      state.secret_version = parameters.secret_version;
      return;
    case "sensitive.change_cloud_admin":
      state.cloud_admin = parameters.principal_id;
      return;
    case "constitutional.issue_equity":
      state.last_equity_issue_id = parameters.issue_id;
      return;
    default:
      throw new Error(`unsupported simulated provider action: ${actionKind}`);
  }
}

function providerStateMatches(state, actionKind, parameters) {
  switch (actionKind) {
    case "routine.deploy":
      return state.deployment_sha === parameters.commit_sha;
    case "routine.pay_existing_vendor":
      return state.last_vendor_payment_id === parameters.payment_id;
    case "sensitive.rotate_secret":
      return state.secret_version === parameters.secret_version;
    case "sensitive.change_cloud_admin":
      return state.cloud_admin === parameters.principal_id;
    case "constitutional.issue_equity":
      return state.last_equity_issue_id === parameters.issue_id;
    default:
      return false;
  }
}

function capabilityAllows({ capability, proposal, authorization, currentGeneration, nowMs }) {
  if (!capability) return false;
  if (capability.tenant_id !== proposal.tenant_id) return false;
  if (capability.status !== "active") return false;
  if (capability.issued_at_ms > nowMs) return false;
  if (capability.expires_at_ms <= capability.issued_at_ms) return false;
  if (capability.expires_at_ms <= nowMs) return false;
  if (capability.state_generation !== currentGeneration) return false;
  if (authorization.participant_id !== capability.grantee_participant_id) return false;
  if (!capability.allowed_action_kinds.includes(proposal.action_kind)) return false;

  const actionClass = classifyAction(proposal.action_kind);
  if (!actionClass) return false;
  if (actionClass === "constitutional") return false;

  const constraints = capability.constraints;
  if (
    constraints.ownership_changes_allowed ||
    constraints.policy_weakening_allowed ||
    constraints.audit_deletion_allowed ||
    constraints.related_party_transfers_allowed
  ) {
    return false;
  }
  if (constraints.denied_action_kinds?.includes(proposal.action_kind)) return false;
  if (
    constraints.allowed_action_kinds &&
    !constraints.allowed_action_kinds.includes(proposal.action_kind)
  ) {
    return false;
  }
  return true;
}

function proposalIsInternallyConsistent(proposal, parameters) {
  const actionClass = classifyAction(proposal.action_kind);
  if (!actionClass) return false;
  if (proposal.action_class !== actionClass) return false;
  if (proposal.parameters_hash !== actionParametersHash(parameters)) return false;
  return true;
}

function buildReceipt({
  proposal,
  fencingScope,
  fencingToken,
  providerResult,
  idempotencyKey,
  executedAtMs,
}) {
  const unsigned = {
    tenant_id: proposal.tenant_id,
    proposal_id: proposal.proposal_id,
    canonical_payload_hash: proposal.canonical_payload_hash,
    policy_hash: proposal.policy_hash,
    executor_id: "founder-control-plane-simulated-executor",
    fencing_scope: fencingScope,
    fencing_token: fencingToken,
    idempotency_key: idempotencyKey,
    outcome: providerResult.outcome,
    reconciled: providerResult.reconciled === true,
    executed_at_ms: executedAtMs,
  };
  if (providerResult.provider_request_id !== undefined) {
    unsigned.provider_request_id = providerResult.provider_request_id;
  }
  if (providerResult.safe_reason_code !== undefined) {
    unsigned.safe_reason_code = providerResult.safe_reason_code;
  }
  return {
    ...unsigned,
    receipt_hash: sha256Urn(canonicalJson(unsigned)),
  };
}

function authorizationMatchesProposal({ authorization, proposal, currentGeneration }) {
  return (
    authorization?.authorized === true &&
    authorization.tenant_id === proposal.tenant_id &&
    authorization.proposal_hash === proposal.canonical_payload_hash &&
    authorization.policy_hash === proposal.policy_hash &&
    authorization.policy_version === proposal.policy_version &&
    authorization.state_generation === currentGeneration
  );
}

export function executeProtectedAction({
  proposal,
  parameters,
  authorization,
  capability,
  currentGeneration,
  fencingScope,
  fencingToken,
  activeFencingToken,
  ledger,
  provider,
  nowMs,
}) {
  if (authorization?.proposal_hash !== proposal.canonical_payload_hash) {
    return { outcome: "rejected", safe_reason_code: "authorization_hash_mismatch" };
  }
  if (authorization?.authorized !== true) {
    return { outcome: "rejected", safe_reason_code: "approval_quorum_unsatisfied" };
  }
  if (!authorizationMatchesProposal({ authorization, proposal, currentGeneration })) {
    return { outcome: "rejected", safe_reason_code: "authorization_context_mismatch" };
  }
  if (!proposalIsInternallyConsistent(proposal, parameters)) {
    return { outcome: "rejected", safe_reason_code: "proposal_parameters_mismatch" };
  }
  if (fencingToken !== activeFencingToken) {
    return { outcome: "rejected", safe_reason_code: "stale_fencing_token" };
  }

  if (authorization.mode === "delegated_authority") {
    if (
      !capabilityAllows({
        capability,
        proposal,
        authorization,
        currentGeneration,
        nowMs,
      })
    ) {
      return { outcome: "rejected", safe_reason_code: "delegated_authority_invalid" };
    }
  } else if (authorization.mode !== "direct_quorum") {
    return { outcome: "rejected", safe_reason_code: "authorization_mode_invalid" };
  }

  const idempotencyKey = executionIdempotencyKey(proposal);
  const claim = ledger.claim({
    tenantId: proposal.tenant_id,
    fencingScope,
    idempotencyKey,
    fencingToken,
    proposalHash: proposal.canonical_payload_hash,
  });

  if (claim.kind === "receipt") return claim.receipt;
  if (claim.kind === "rejected") {
    return { outcome: "rejected", safe_reason_code: claim.reason };
  }

  let providerResult;
  if (claim.kind === "pending") {
    providerResult = provider.reconcile({
      actionKind: proposal.action_kind,
      parameters,
      idempotencyKey,
    });
  } else {
    try {
      providerResult = provider.apply({
        actionKind: proposal.action_kind,
        parameters,
        idempotencyKey,
      });
    } catch {
      providerResult = provider.reconcile({
        actionKind: proposal.action_kind,
        parameters,
        idempotencyKey,
      });
      if (providerResult.outcome === "unknown") {
        providerResult = {
          ...providerResult,
          safe_reason_code: "provider_result_unknown",
        };
      }
    }
    if (
      providerResult.outcome === "unknown" &&
      providerResult.safe_reason_code === undefined
    ) {
      providerResult = provider.reconcile({
        actionKind: proposal.action_kind,
        parameters,
        idempotencyKey,
      });
    }
  }

  if (
    providerResult.outcome === "unknown" &&
    providerResult.safe_reason_code === undefined
  ) {
    providerResult = {
      ...providerResult,
      safe_reason_code: "provider_result_unknown",
    };
  }

  const receipt = buildReceipt({
    proposal,
    fencingScope,
    fencingToken,
    providerResult,
    idempotencyKey,
    executedAtMs: nowMs,
  });

  if (providerResult.outcome === "unknown") {
    return Object.freeze(receipt);
  }

  return ledger.recordReceipt(idempotencyKey, receipt);
}

function driftValue(state, field) {
  if (Object.prototype.hasOwnProperty.call(state, field)) {
    return { present: true, value: state[field] };
  }
  return { present: false };
}

export function detectProviderDrift({ expectedState, actualState, protectedFields }) {
  const alerts = [];
  for (const field of protectedFields) {
    const expected = driftValue(expectedState, field);
    const actual = driftValue(actualState, field);
    if (canonicalJson(expected) === canonicalJson(actual)) continue;
    alerts.push(
      Object.freeze({
        field,
        expected_hash: sha256Urn(canonicalJson(expected)),
        actual_hash: sha256Urn(canonicalJson(actual)),
        severity: "critical",
        recommended_action: "freeze_and_reconcile",
      }),
    );
  }
  return alerts;
}
