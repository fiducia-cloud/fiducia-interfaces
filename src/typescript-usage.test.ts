// Compile-time smoke test: imports the generated TypeScript types to assert the
// emitted payload shapes are usable and named as expected.
import type {
  LockAcquireManyRequest,
  LockGrant,
  LockReleaseManyRequest,
} from "../generated/typescript/index";
import lockFixtures from "../fixtures/lock-payloads.json" with { type: "json" };

const acquire: LockAcquireManyRequest = {
  keys: ["orders/42", "inventory/sku-7"],
  holder: "worker-a",
  ttl_ms: 30_000,
  wait: false,
};

const grant: LockGrant = {
  acquired: true,
  lock_id: "lock-1",
  fencing_tokens: {
    "orders/42": 41,
    "inventory/sku-7": 42,
  },
  keys: acquire.keys,
  holders: 1,
  max: 1,
  available: 0,
};

const release: LockReleaseManyRequest = {
  lock_id: grant.lock_id ?? "lock-1",
};

void release;

// Cross-language wire parity (see fixtures/lock-payloads.json, the single
// source of truth also decoded by generated/rust/tests/lock_payloads.rs and
// validated at runtime by src/wire-parity.test.mjs): every valid lock fixture
// entry must be assignable to the generated type...
const fixtureAcquires: LockAcquireManyRequest[] =
  lockFixtures.valid.LockAcquireManyRequest;

// ...and the invalid entry (missing the required `keys` field) must be
// REJECTED by the compiler. If the generated type ever stops requiring
// `keys`, this @ts-expect-error itself becomes a compile error.
// @ts-expect-error — fixture omits the required `keys` field on purpose
const rejectedAcquire: LockAcquireManyRequest =
  lockFixtures.invalid.LockAcquireManyRequest[0];

void fixtureAcquires;
void rejectedAcquire;
