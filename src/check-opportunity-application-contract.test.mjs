import assert from "node:assert/strict";
import { test } from "node:test";

import { checkOpportunityApplicationContract } from "./check-opportunity-application-contract.mjs";

test("production opportunity contract is complete, bounded, and credential-free", async () => {
  const receipt = await checkOpportunityApplicationContract();
  assert.deepEqual(receipt, {
    status: "PASS",
    validator: "ORESoftware/typespec-json-schema-validator@2281843126ab644607b11cf8281d84f382d68dfc",
    declarations: 7,
    validInstances: 3,
    invalidInstances: 10,
  });
});
