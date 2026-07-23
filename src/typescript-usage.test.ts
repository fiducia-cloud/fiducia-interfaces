// Compile-time smoke tests for the generated coordination lifecycle types.
import type {
  FileLeaseAcquireRequest,
  FileLeaseRenewRequest,
  FileLeaseQuery,
  LockAcquireManyRequest,
  LockAcquireRequest,
  LockAcquireResponse,
  LockCancelRequest,
  LockCancelResponse,
  LockReleaseRequest,
  LockReleaseResponse,
  LockRenewRequest,
  LockRenewResponse,
  SemaphoreAcquireRequest,
  SemaphoreAcquireResponse,
  SemaphoreCancelRequest,
  SemaphoreCancelResponse,
  SemaphoreReleaseRequest,
  SemaphoreReleaseResponse,
  SemaphoreRenewRequest,
  SemaphoreRenewResponse,
  SyncChangeEvent,
  SyncPullPage,
  SyncQueuedWrite,
  SyncWriteAcknowledgement,
} from "../generated/typescript/index";
import lockFixtures from "../fixtures/lock-payloads.json" with { type: "json" };

const acquire: LockAcquireRequest = {
  keys: ["orders/42", "inventory/sku-7"],
  holder: "worker-a",
  request_id: "attempt-union-09b2f8c4",
  ttl_ms: 30_000,
  wait: true,
  wait_timeout_ms: 5_000,
};

const granted: LockAcquireResponse = {
  acquired: true,
  queued: false,
  keys: acquire.keys ?? [],
  holder: acquire.holder,
  fencing_token: 41,
  lease_expires_ms: 1_767_225_600_000,
  revision: 120,
};

const renew: LockRenewRequest = {
  keys: granted.keys,
  holder: granted.holder,
  fencing_token: granted.fencing_token ?? 0,
  ttl_ms: 30_000,
};
const release: LockReleaseRequest = {
  holder: granted.holder,
  fencing_token: granted.fencing_token ?? 0,
};
const cancel: LockCancelRequest = {
  keys: granted.keys,
  holder: granted.holder,
  request_id: acquire.request_id,
};

const semaphoreAcquire: SemaphoreAcquireRequest = {
  key: "pools/db/primary",
  holder: "worker-a",
  request_id: "attempt-semaphore-1a2b3c4d",
  limit: 3,
  ttl_ms: 30_000,
  wait: true,
  wait_timeout_ms: 5_000,
};
const semaphoreRenew: SemaphoreRenewRequest = {
  key: semaphoreAcquire.key,
  holder: semaphoreAcquire.holder,
  fencing_token: 51,
  ttl_ms: 30_000,
};
const semaphoreRelease: SemaphoreReleaseRequest = {
  key: semaphoreAcquire.key,
  holder: semaphoreAcquire.holder,
  fencing_token: semaphoreRenew.fencing_token,
};
const semaphoreCancel: SemaphoreCancelRequest = {
  key: semaphoreAcquire.key,
  holder: "worker-d",
  request_id: "attempt-semaphore-queued-5e6f7a8b",
};

const syncWrite: SyncQueuedWrite = {
  id: "api-key-1",
  table: "api_keys",
  op: "upsert",
  payload: { id: "api-key-1", version: 1 },
  base_version: 0,
  key: "write-api-key-1",
};
const syncChange: SyncChangeEvent = {
  table: syncWrite.table,
  op: syncWrite.op,
  id: syncWrite.id,
  version: 1,
  row: syncWrite.payload,
  at_ms: 1_767_225_600_000,
  write_key: syncWrite.key,
  sync_sequence: 42,
};
const syncAcknowledgement: SyncWriteAcknowledgement = {
  id: syncWrite.id,
  committed_version: syncChange.version,
};
const syncPage: SyncPullPage = {
  changes: [syncChange],
  next_cursor: syncChange.sync_sequence ?? 0,
  has_more: false,
};

// Every valid fixture remains assignable to its generated type.
const fixtureLockAcquire: LockAcquireRequest[] = lockFixtures.valid.LockAcquireRequest;
const fixtureLockAcquireMany: LockAcquireManyRequest[] = lockFixtures.valid.LockAcquireManyRequest;
const fixtureLockAcquireResponse: LockAcquireResponse[] = lockFixtures.valid.LockAcquireResponse;
const fixtureLockRenew: LockRenewRequest[] = lockFixtures.valid.LockRenewRequest;
const fixtureLockRenewResponse: LockRenewResponse[] = lockFixtures.valid.LockRenewResponse;
const fixtureLockRelease: LockReleaseRequest[] = lockFixtures.valid.LockReleaseRequest;
const fixtureLockReleaseResponse: LockReleaseResponse[] = lockFixtures.valid.LockReleaseResponse;
const fixtureLockCancel: LockCancelRequest[] = lockFixtures.valid.LockCancelRequest;
const fixtureLockCancelResponse: LockCancelResponse[] =
  lockFixtures.valid.LockCancelResponse.map((entry) => ({
    ...entry,
    reason: entry.reason as LockCancelResponse["reason"],
  }));
const fixtureSemaphoreAcquire: SemaphoreAcquireRequest[] = lockFixtures.valid.SemaphoreAcquireRequest;
const fixtureSemaphoreAcquireResponse: SemaphoreAcquireResponse[] =
  lockFixtures.valid.SemaphoreAcquireResponse.map((entry) => ({
    ...entry,
    // JSON-module imports widen strings; the schema fixture validator separately
    // proves this value is the generated one-value enum.
    reason: entry.reason as SemaphoreAcquireResponse["reason"],
  }));
const fixtureSemaphoreRenew: SemaphoreRenewRequest[] = lockFixtures.valid.SemaphoreRenewRequest;
const fixtureSemaphoreRenewResponse: SemaphoreRenewResponse[] = lockFixtures.valid.SemaphoreRenewResponse;
const fixtureSemaphoreRelease: SemaphoreReleaseRequest[] = lockFixtures.valid.SemaphoreReleaseRequest;
const fixtureSemaphoreReleaseResponse: SemaphoreReleaseResponse[] = lockFixtures.valid.SemaphoreReleaseResponse;
const fixtureSemaphoreCancel: SemaphoreCancelRequest[] = lockFixtures.valid.SemaphoreCancelRequest;
const fixtureSemaphoreCancelResponse: SemaphoreCancelResponse[] =
  lockFixtures.valid.SemaphoreCancelResponse.map((entry) => ({
    ...entry,
    reason: entry.reason as SemaphoreCancelResponse["reason"],
  }));
const fixtureFileLeaseAcquire: FileLeaseAcquireRequest[] = lockFixtures.valid.FileLeaseAcquireRequest;
const fixtureFileLeaseRenew: FileLeaseRenewRequest[] = lockFixtures.valid.FileLeaseRenewRequest;
const fixtureFileLeaseQuery: FileLeaseQuery[] = lockFixtures.valid.FileLeaseQuery;

// Required fields must stay required in all generated languages.
// @ts-expect-error — holder is required on the acquire wire.
const missingLockHolder: LockAcquireManyRequest = { keys: ["orders/42"] };
// @ts-expect-error — holder is required on the semaphore acquire wire.
const missingSemaphoreHolder: SemaphoreAcquireRequest = { key: "pool", limit: 3 };

void [
  renew,
  release,
  cancel,
  semaphoreRelease,
  semaphoreCancel,
  syncWrite,
  syncChange,
  syncAcknowledgement,
  syncPage,
  fixtureLockAcquire,
  fixtureLockAcquireMany,
  fixtureLockAcquireResponse,
  fixtureLockRenew,
  fixtureLockRenewResponse,
  fixtureLockRelease,
  fixtureLockReleaseResponse,
  fixtureLockCancel,
  fixtureLockCancelResponse,
  fixtureSemaphoreAcquire,
  fixtureSemaphoreAcquireResponse,
  fixtureSemaphoreRenew,
  fixtureSemaphoreRenewResponse,
  fixtureSemaphoreRelease,
  fixtureSemaphoreReleaseResponse,
  fixtureSemaphoreCancel,
  fixtureSemaphoreCancelResponse,
  fixtureFileLeaseAcquire,
  fixtureFileLeaseRenew,
  fixtureFileLeaseQuery,
  missingLockHolder,
  missingSemaphoreHolder,
];
