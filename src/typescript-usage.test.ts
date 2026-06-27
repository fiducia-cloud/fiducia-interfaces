import type {
  LockAcquireManyRequest,
  LockGrant,
  LockReleaseManyRequest,
} from "../generated/typescript/index";

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
