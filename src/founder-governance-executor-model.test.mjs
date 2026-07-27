import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ExecutionLedger,
  SimulatedProvider,
  actionParametersHash,
  detectProviderDrift,
  executeProtectedAction,
} from "../design/founder-governance-executor-model.mjs";

const NOW = 1785436800000;

function proposal(overrides = {}) {
  const parameters = overrides.parameters ?? { commit_sha: "abc123" };
  return {
    parameters,
    value: {
      tenant_id: "company-123",
      proposal_id: "proposal-exec-1",
      action_kind: "routine.deploy",
      action_class: "routine",
      parameters_hash: actionParametersHash(parameters),
      policy_id: "deploy-policy",
      policy_version: 1,
      policy_hash: `sha256:${"a".repeat(64)}`,
      canonical_payload_hash: `sha256:${"b".repeat(64)}`,
      ...overrides.value,
    },
  };
}

function capability(overrides = {}) {
  return {
    tenant_id: "company-123",
    authority_id: "authority-1",
    status: "active",
    state_generation: 8,
    allowed_action_kinds: ["routine.deploy", "routine.pay_existing_vendor"],
    constraints: {
      equivalent_access_only: true,
      ownership_changes_allowed: false,
      policy_weakening_allowed: false,
      audit_deletion_allowed: false,
      related_party_transfers_allowed: false,
      allowed_action_kinds: ["routine.deploy", "routine.pay_existing_vendor"],
      denied_action_kinds: [
        "constitutional.issue_equity",
        "constitutional.weaken_policy",
        "constitutional.transfer_ip",
      ],
    },
    issued_at_ms: NOW - 1000,
    expires_at_ms: NOW + 3_600_000,
    ...overrides,
  };
}

function execute(overrides = {}) {
  const built = overrides.built ?? proposal();
  return executeProtectedAction({
    proposal: built.value,
    parameters: built.parameters,
    authorization: {
      authorized: true,
      mode: "delegated_authority",
      proposal_hash: built.value.canonical_payload_hash,
      ...overrides.authorization,
    },
    capability: overrides.capability ?? capability(),
    currentGeneration: overrides.currentGeneration ?? 8,
    fencingToken: overrides.fencingToken ?? 11,
    ledger: overrides.ledger ?? new ExecutionLedger(),
    provider: overrides.provider ?? new SimulatedProvider(),
    nowMs: overrides.nowMs ?? NOW,
  });
}

test("unsatisfied quorum and altered parameters fail before provider execution", () => {
  const provider = new SimulatedProvider();
  assert.equal(
    execute({ provider, authorization: { authorized: false } }).safe_reason_code,
    "approval_quorum_unsatisfied",
  );
  assert.equal(provider.applyCount, 0);

  const built = proposal();
  built.parameters.commit_sha = "mutated";
  assert.equal(
    execute({ built, provider }).safe_reason_code,
    "proposal_parameters_mismatch",
  );
  assert.equal(provider.applyCount, 0);
});

test("valid delegated action executes once and duplicate delivery returns one receipt", () => {
  const provider = new SimulatedProvider();
  const ledger = new ExecutionLedger();
  const first = execute({ provider, ledger });
  const second = execute({ provider, ledger });

  assert.equal(first.outcome, "succeeded");
  assert.deepEqual(second, first);
  assert.equal(provider.applyCount, 1);
  assert.equal(provider.state.deployment_sha, "abc123");
});

test("stale fencing token cannot begin after a newer generation executor", () => {
  const provider = new SimulatedProvider();
  const ledger = new ExecutionLedger();
  const first = execute({ provider, ledger, fencingToken: 20 });
  assert.equal(first.outcome, "succeeded");

  const secondProposal = proposal({
    parameters: { commit_sha: "def456" },
    value: {
      proposal_id: "proposal-exec-2",
      canonical_payload_hash: `sha256:${"c".repeat(64)}`,
    },
  });
  const stale = execute({
    built: secondProposal,
    provider,
    ledger,
    fencingToken: 19,
  });
  assert.equal(stale.outcome, "rejected");
  assert.equal(stale.safe_reason_code, "stale_fencing_token");
  assert.equal(provider.state.deployment_sha, "abc123");
});

test("provider apply-then-timeout reconciles without applying twice", () => {
  const provider = new SimulatedProvider();
  provider.setBehavior("routine.deploy", "apply_then_timeout");
  const ledger = new ExecutionLedger();

  const receipt = execute({ provider, ledger });
  assert.equal(receipt.outcome, "succeeded");
  assert.equal(receipt.reconciled, true);
  assert.equal(provider.applyCount, 1);
  assert.equal(provider.state.deployment_sha, "abc123");

  const duplicate = execute({ provider, ledger });
  assert.deepEqual(duplicate, receipt);
  assert.equal(provider.applyCount, 1);
});

test("expired, wrong-generation, and overbroad delegated authority fail closed", () => {
  assert.equal(
    execute({ capability: capability({ expires_at_ms: NOW }) }).safe_reason_code,
    "delegated_authority_invalid",
  );
  assert.equal(
    execute({ currentGeneration: 9 }).safe_reason_code,
    "delegated_authority_invalid",
  );
  assert.equal(
    execute({
      capability: capability({
        constraints: {
          ...capability().constraints,
          ownership_changes_allowed: true,
        },
      }),
    }).safe_reason_code,
    "delegated_authority_invalid",
  );
});

test("continuity capability can never execute a constitutional action", () => {
  const parameters = { issue_id: "equity-1" };
  const built = proposal({
    parameters,
    value: {
      action_kind: "constitutional.issue_equity",
      action_class: "constitutional",
      parameters_hash: actionParametersHash(parameters),
      canonical_payload_hash: `sha256:${"d".repeat(64)}`,
    },
  });
  const cap = capability({
    allowed_action_kinds: ["constitutional.issue_equity"],
    constraints: {
      ...capability().constraints,
      allowed_action_kinds: ["constitutional.issue_equity"],
      denied_action_kinds: [],
    },
  });
  const result = execute({ built, capability: cap });
  assert.equal(result.outcome, "rejected");
  assert.equal(result.safe_reason_code, "delegated_authority_invalid");
});

test("off-platform protected-state changes produce critical drift alerts", () => {
  const alerts = detectProviderDrift({
    expectedState: {
      org_owner: "fiducia-executor",
      cloud_admin: "fiducia-executor",
      deployment_sha: "abc123",
    },
    actualState: {
      org_owner: "founder-personal-account",
      cloud_admin: "fiducia-executor",
      deployment_sha: "abc123",
    },
    protectedFields: ["org_owner", "cloud_admin"],
  });
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].field, "org_owner");
  assert.equal(alerts[0].severity, "critical");
  assert.equal(alerts[0].recommended_action, "freeze_and_reconcile");
});
