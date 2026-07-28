import assert from "node:assert/strict";
import { test } from "node:test";

import {
  exploreActionAuthorization,
  exploreExecutorSafety,
  exploreTransitions,
  runAdversarialStateSpace,
} from "../design/founder-governance-adversarial-explorer.mjs";

test("bounded adversarial state space has no takeover, self-dealing, stale, or evidence counterexample", () => {
  const result = runAdversarialStateSpace();
  assert.ok(result.cases > 1_000_000, `expected broad bounded coverage, got ${result.cases}`);
  assert.deepEqual(result.failures, []);
});

test("every declared continuity liveness property has a reachable witness", () => {
  const result = exploreActionAuthorization();
  assert.deepEqual(result.failures, []);
  assert.deepEqual(result.witnesses, {
    bounded_routine_continuity: true,
    equivalent_access_recovery: true,
    defensive_emergency: true,
    deadlock_preapproved_routine: true,
    succession_constitutional_process: true,
  });
});

test("every transition edge has a positive witness and each guard has negative coverage", () => {
  const result = exploreTransitions();
  assert.deepEqual(result.failures, []);
  assert.ok(result.witnesses.length >= 10);
  assert.ok(result.cases > result.witnesses.length * 4);
  assert.equal(
    new Set(result.witnesses.map((witness) => `${witness.from}->${witness.to}`)).size,
    result.witnesses.length,
  );
});

test("executor exploration keeps constitutional, stale, ambiguous, and drift behavior fail closed", () => {
  const result = exploreExecutorSafety();
  assert.ok(result.cases >= 6);
  assert.deepEqual(result.failures, []);
});
