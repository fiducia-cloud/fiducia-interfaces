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
    grantee_participant_id: "founder-a",
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
  const currentGeneration = overrides.currentGeneration ?? 8;
  const fencingToken = overrides.fencingToken ?? 11;
  return executeProtectedAction({
    proposal: built.value,
    parameters: built.parameters,
    authorization: {
      authorized: true,
      mode: "delegated_authority",
      tenant_id: built.value.tenant_id,
      proposal_hash: built.value.canonical_payload_hash,
      policy_hash: built.value.policy_hash,
      policy_version: built.value.policy_version,
      state_generation: currentGeneration,
      participant_id: "founder-a",
      ...overrides.authorization,
    },
    capability: overrides.capability ?? capability(),
    currentGeneration,
    fencingScope: overrides.fencingScope ?? "connector:github-rulesets",
    fencingToken,
    activeFencingToken: overrides.activeFencingToken ?? fencingToken,
    ledger: overrides.ledger ?? new ExecutionLedger(),
    provider: overrides.provider ?? new SimulatedProvider(),
    nowMs: overrides.nowMs ?? NOW,
  });
}

class DelayedReconcileProvider extends SimulatedProvider {
  constructor() {
    super();
    this.reconcileCount = 0;
  }

  reconcile(args) {
    this.reconcileCount += 1;
    if (this.reconcileCount === 1) return { outcome: "unknown" };
    return super.reconcile(args);
  }
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

test("authorization is bound to tenant, policy, generation, and exact proposal", () => {
  const provider = new SimulatedProvider();
  for (const authorization of [
    { tenant_id: "other-company" },
    { policy_hash: `sha256:${"f".repeat(64)}` },
    { policy_version: 2 },
    { state_generation: 9 },
  ]) {
    assert.equal(
      execute({ provider, authorization }).safe_reason_code,
      "authorization_context_mismatch",
    );
  }
  assert.equal(provider.applyCount, 0);
});

test("proposal action class must match the registered action taxonomy", () => {
  const provider = new SimulatedProvider();
  const built = proposal({ value: { action_class: "sensitive" } });
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
  assert.equal(first.fencing_scope, "connector:github-rulesets");
});

test("executor must hold the currently active fencing token", () => {
  const provider = new SimulatedProvider();
  const result = execute({ provider, fencingToken: 11, activeFencingToken: 12 });
  assert.equal(result.outcome, "rejected");
  assert.equal(result.safe_reason_code, "stale_fencing_token");
  assert.equal(provider.applyCount, 0);
});

test("stale fencing token cannot begin after a newer scoped executor", () => {
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

test("independent connector fencing scopes do not incorrectly share a high-water mark", () => {
  const provider = new SimulatedProvider();
  const ledger = new ExecutionLedger();
  assert.equal(
    execute({ provider, ledger, fencingScope: "connector:github", fencingToken: 50 }).outcome,
    "succeeded",
  );

  const built = proposal({
    parameters: { commit_sha: "cloudflare-change" },
    value: {
      proposal_id: "proposal-exec-other-scope",
      canonical_payload_hash: `sha256:${"e".repeat(64)}`,
    },
  });
  assert.equal(
    execute({
      built,
      provider,
      ledger,
      fencingScope: "connector:cloudflare",
      fencingToken: 1,
    }).outcome,
    "succeeded",
  );
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

test("a higher-fenced executor can take over pending reconciliation without reapplying", () => {
  const provider = new DelayedReconcileProvider();
  provider.setBehavior("routine.deploy", "apply_then_timeout");
  const ledger = new ExecutionLedger();

  const pending = execute({ provider, ledger, fencingToken: 11 });
  assert.equal(pending.outcome, "unknown");
  assert.equal(provider.applyCount, 1);

  const reconciled = execute({
    provider,
    ledger,
    fencingToken: 12,
    activeFencingToken: 12,
  });
  assert.equal(reconciled.outcome, "succeeded");
  assert.equal(reconciled.reconciled, true);
  assert.equal(reconciled.fencing_token, 12);
  assert.equal(provider.applyCount, 1);
});

test("expired, wrong-generation, wrong-grantee, and overbroad authority fail closed", () => {
  assert.equal(
    execute({ capability: capability({ expires_at_ms: NOW }) }).safe_reason_code,
    "delegated_authority_invalid",
  );
  assert.equal(
    execute({ currentGeneration: 9 }).safe_reason_code,
    "delegated_authority_invalid",
  );
  assert.equal(
    execute({ authorization: { participant_id: "founder-b" } }).safe_reason_code,
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

test("provider exceptions remain pending and never trigger blind duplicate mutation", () => {
  const provider = new SimulatedProvider();
  provider.setBehavior("routine.deploy", "throw_before_apply");
  const ledger = new ExecutionLedger();

  const first = execute({ provider, ledger });
  assert.equal(first.outcome, "unknown");
  assert.equal(first.safe_reason_code, "provider_result_unknown");
  assert.equal(provider.applyCount, 1);

  const second = execute({ provider, ledger, fencingToken: 12, activeFencingToken: 12 });
  assert.equal(second.outcome, "unknown");
  assert.equal(provider.applyCount, 1);
});

test("off-platform protected-state changes and missing fields produce critical alerts", () => {
  const alerts = detectProviderDrift({
    expectedState: {
      org_owner: "fiducia-executor",
      cloud_admin: "fiducia-executor",
      deployment_sha: "abc123",
    },
    actualState: {
      org_owner: "founder-personal-account",
      deployment_sha: "abc123",
    },
    protectedFields: ["org_owner", "cloud_admin"],
  });
  assert.equal(alerts.length, 2);
  assert.deepEqual(
    alerts.map((alert) => alert.field).sort(),
    ["cloud_admin", "org_owner"],
  );
  assert.ok(alerts.every((alert) => alert.severity === "critical"));
  assert.ok(alerts.every((alert) => alert.recommended_action === "freeze_and_reconcile"));
});
