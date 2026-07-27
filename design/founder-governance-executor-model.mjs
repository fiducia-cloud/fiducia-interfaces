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
    this.highestFencingTokenByTenant = new Map();
    this.receiptByIdempotencyKey = new Map();
    this.pendingByIdempotencyKey = new Map();
  }

  highestFencingToken(tenantId) {
    return this.highestFencingTokenByTenant.get(tenantId) ?? 0;
  }

  claim({ tenantId, idempotencyKey, fencingToken, proposalHash }) {
    const existingReceipt = this.receiptByIdempotencyKey.get(idempotencyKey);
    if (existingReceipt) return { kind: "receipt", receipt: existingReceipt };

    const pending = this.pendingByIdempotencyKey.get(idempotencyKey);
    if (pending) {
      if (
        pending.fencing_token !== fencingToken ||
        pending.canonical_payload_hash !== proposalHash
      ) {
        return { kind: "rejected", reason: "idempotency_conflict" };
      }
      return { kind: "pending", pending };
    }

    const highWater = this.highestFencingToken(tenantId);
    if (fencingToken < highWater) {
      return { kind: "rejected", reason: "stale_fencing_token" };
    }

    this.highestFencingTokenByTenant.set(tenantId, Math.max(highWater, fencingToken));
    const record = Object.freeze({
      tenant_id: tenantId,
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
  constructor(initialState = {}) {
    this.state = structuredClone(initialState);
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
    const behavior = this.behaviorByActionKind.get(actionKind) ?? "succeed";
    let result;

    if (behavior === "fail_before_apply") {
      result = { outcome: "failed", provider_request_id: `req-${this.applyCount}` };
    } else {
      applyProviderMutation(this.state, actionKind, parameters);
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

function capabilityAllows({ capability, proposal, currentGeneration, nowMs }) {
  if (!capability) return false;
  if (capability.tenant_id !== proposal.tenant_id) return false;
  if (capability.status !== "active") return false;
  if (capability.expires_at_ms <= nowMs) return false;
  if (capability.state_generation !== currentGeneration) return false;
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
  if (!classifyAction(proposal.action_kind)) return false;
  if (proposal.parameters_hash !== actionParametersHash(parameters)) return false;
  return true;
}

function buildReceipt({
  proposal,
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
    fencing_token: fencingToken,
    idempotency_key: idempotencyKey,
    provider_request_id: providerResult.provider_request_id,
    outcome: providerResult.outcome,
    reconciled: providerResult.reconciled === true,
    executed_at_ms: executedAtMs,
  };
  return {
    ...unsigned,
    receipt_hash: sha256Urn(canonicalJson(unsigned)),
  };
}

export function executeProtectedAction({
  proposal,
  parameters,
  authorization,
  capability,
  currentGeneration,
  fencingToken,
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
  if (!proposalIsInternallyConsistent(proposal, parameters)) {
    return { outcome: "rejected", safe_reason_code: "proposal_parameters_mismatch" };
  }

  if (authorization.mode === "delegated_authority") {
    if (!capabilityAllows({ capability, proposal, currentGeneration, nowMs })) {
      return { outcome: "rejected", safe_reason_code: "delegated_authority_invalid" };
    }
  } else if (authorization.mode !== "direct_quorum") {
    return { outcome: "rejected", safe_reason_code: "authorization_mode_invalid" };
  }

  const idempotencyKey = executionIdempotencyKey(proposal);
  const claim = ledger.claim({
    tenantId: proposal.tenant_id,
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
    providerResult = provider.apply({
      actionKind: proposal.action_kind,
      parameters,
      idempotencyKey,
    });
    if (providerResult.outcome === "unknown") {
      providerResult = provider.reconcile({
        actionKind: proposal.action_kind,
        parameters,
        idempotencyKey,
      });
    }
  }

  const receipt = buildReceipt({
    proposal,
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

export function detectProviderDrift({ expectedState, actualState, protectedFields }) {
  const alerts = [];
  for (const field of protectedFields) {
    if (canonicalJson(expectedState[field]) === canonicalJson(actualState[field])) continue;
    alerts.push(
      Object.freeze({
        field,
        expected_hash: sha256Urn(canonicalJson(expectedState[field])),
        actual_hash: sha256Urn(canonicalJson(actualState[field])),
        severity: "critical",
        recommended_action: "freeze_and_reconcile",
      }),
    );
  }
  return alerts;
}
