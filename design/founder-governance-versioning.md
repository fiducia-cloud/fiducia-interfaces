# Founder governance contract versioning and migration

Status: discovery contract for DEN-158, DEN-176, and DEN-283. These rules govern promotion of the current non-canonical design artifacts; they do not create legal authority or ownership records.

## Separate version domains

Founder governance has several versions that must never be conflated:

1. **Contract version** identifies the wire/storage schema and semantic interpretation of a policy, proposal, approval, transition, delegated authority, receipt, or drift event.
2. **Policy version** identifies one tenant policy revision. It is monotonically increasing within a stable `policy_id` and is included in the policy hash.
3. **Continuity generation** fences state transitions and delegated authority. It increases whenever continuity state changes and is never rewritten by a schema migration.
4. **Credential generation/status** belongs to the participant registry and controls whether a credential may approve at evaluation time.
5. **Executor fencing token** belongs to a specific execution scope and prevents stale workers from producing effects.

Changing one domain must not silently advance, reset, or reinterpret another.

## Canonical envelope requirements

Before promotion, every canonical governance object must carry:

- `contract_version`, using a stable major/minor identifier such as `1.0`;
- an object-kind discriminator;
- tenant and object identifiers;
- canonicalization identifier;
- the exact policy version/hash or continuity generation relevant to authorization;
- creation and expiry timestamps where authority is time-bound.

The contract version and object kind are part of the canonical payload and therefore part of every signature/hash. They may not be inferred from an HTTP route, database table, or current server default.

## Compatibility policy

### Patch changes

A patch release may clarify documentation, add tests, tighten implementation checks already required by the existing semantics, or fix code generation without changing accepted wire values. Existing hashes and signatures must remain valid.

### Minor changes

Because the draft schemas use `additionalProperties: false`, adding a field is not automatically backward compatible. A minor release may add an optional field only through an explicit dual-decoder period:

1. new readers accept the old and new minor versions;
2. writers continue emitting the old version until reader readiness is proven;
3. writers switch to the new version behind a tenant/environment gate;
4. old-version writes are disabled only after rollback and recovery drills.

A new optional field that affects authorization, hashing, evidence, notice, expiry, or provider execution is a semantic change and requires a new proposal/transition plus fresh approvals. It cannot be defaulted into an already-approved object.

### Major changes

Any change to quorum meaning, action classification, continuity-state meaning, required evidence/notices, canonicalization, signature verification, delegated-authority scope, provider-effect semantics, or receipt interpretation requires a new major contract version.

Readers must fail closed on unsupported major versions. There is no automatic downgrade, field stripping, or reinterpretation under the newest semantics.

## Hash and approval invariants

- Policy hashes include contract version, action kind/class, every state rule, quorum, notice set, delay, authority TTL, and constraint.
- Proposal and transition hashes include contract version, object kind, policy version/hash, continuity generation, canonicalization identifier, nonce, timestamps, and all action/evidence/notice parameters.
- An approval is valid only for the exact hash and exact contract version it signed.
- Migration never rewrites an approved object in place.
- If semantic migration changes the canonical payload, the system creates a new object and requires fresh approvals.
- Historical receipts preserve the original contract version and interpretation forever.

## Migration procedure

Every canonical contract migration must have these phases:

1. **Inventory:** enumerate stored objects, active policies, pending proposals/transitions, unexpired delegated authorities, and unresolved executions by contract version.
2. **Dual-read:** deploy readers that understand both old and candidate versions while preserving each version's original validation rules.
3. **Shadow validation:** evaluate candidate representations without authorizing effects; compare decisions and record divergences.
4. **Additive write:** enable the candidate version for disposable/test tenants only. Never rewrite signed historical objects.
5. **Fresh authorization:** create replacement policies/proposals/transitions when semantics or hashes change and collect new approvals.
6. **Fenced rollout:** advance executor generation/fencing only after the new object is committed; stale executors remain unable to act.
7. **Rollback drill:** prove the previous reader/writer can be restored without losing auditability or reusing authority.
8. **Retirement:** disable old writes, then old reads only when no live or legally/audit-relevant object depends on them. Historical receipts remain readable.

## Pending and ambiguous work during migration

- Pending proposals and transitions stay pinned to the version in their signed payload.
- They may complete under that version only while the server still supports it and the policy permits it.
- They are never auto-upgraded.
- Unresolved provider executions retain their original idempotency key, fencing scope/token, and contract version until reconciliation reaches a terminal receipt.
- A migration cannot convert `unknown` into `failed` or `succeeded` without provider-state evidence.

## Policy replacement

A replacement policy must:

- use a greater policy version;
- name the exact replaced policy hash;
- pass the current policy's authorization rule;
- be at least as strong for every existing continuity state;
- add new states only as prohibited until separately approved;
- retain or strengthen notice, delay, expiry, quorum, and self-dealing constraints.

A contract-version change does not waive these requirements.

## Data storage and indexing

Storage keys include tenant, object kind, stable object id, and contract version. Indexes may point to the active policy or latest state generation, but the referenced object remains immutable. Database or KV migrations must preserve original bytes or a verifiable content hash so historical receipts can be independently checked.

## Unknown and malformed versions

Unknown major versions, missing version fields, malformed version identifiers, conflicting object-kind discriminators, or unsupported canonicalization identifiers fail closed before quorum evaluation or provider access. They produce an auditable non-secret rejection reason and no external mutation.

## Promotion gate

The drafts may move into `schema/index.json` only when all of the following are true:

- hosted CI is green for schema, examples, state models, transitions, executor, death/succession, and promotion tests;
- a reviewed RFC 8785 implementation produces identical golden hashes in at least Rust and TypeScript;
- contract-version fields and object-kind discriminators exist in every promoted object;
- dual-read/write and rollback procedures are documented and tested;
- generated Rust, Rust-WASM, TypeScript/Zod, Dart, Python, and Go artifacts are current;
- security review confirms fail-closed unknown-version behavior and fresh-approval requirements;
- product/legal documentation continues to state that these records are technical controls, not legal ownership determinations.
