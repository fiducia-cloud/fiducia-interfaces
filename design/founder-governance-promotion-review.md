# Founder governance canonical-promotion review

Status: **revise and retain draft**  
Review issue: DEN-474  
Parent: DEN-283  
Reviewed implementation: `fiducia-cloud/fiducia-interfaces` PR #24, merge commit `08c99aa5933236a0e0ebe584f7b2e861f5b3d1ac`

## Decision

Do **not** add the Founder Control Plane schemas to `schema/index.json` yet.

The current work has strong executable evidence for the intended safety and liveness properties, including bounded adversarial enumeration, non-weakening policy replacement, notice and evidence guards, continuity anti-self-dealing, stale-generation and fencing rejection, ambiguous provider-result preservation, and drift freezes. Those models should remain permanent CI gates.

The wire and storage contracts are not yet stable enough to generate into every supported SDK. The following authority-bearing boundaries are still being implemented:

1. real `webauthn-rs` registration and authentication state;
2. confidentiality and integrity protection for opaque ceremony state;
3. credential status, generation, replacement, counter, and backup-state semantics;
4. the authenticated verified-assertion receipt from `fiducia-auth`;
5. current-state revalidation and exactly-once approval append in the Founder Control Plane;
6. provider-specific request, precondition, reconciliation, and bypass semantics.

Promoting before those contracts stabilize would create a misleading compatibility promise and encourage downstream consumers to depend on incomplete authority semantics.

## Artifact disposition

| Artifact class | Decision | Rationale |
|---|---|---|
| Governance and transition JSON Schemas | Revise and retain draft | Credential lifecycle, verified assertion, approval append, recovery, and provider boundaries are incomplete. |
| Valid/invalid examples | Revise and retain draft | Fixtures must track the final reviewed schemas. |
| Policy, proposal, and transition reference semantics | Retain permanently as noncanonical executable specifications | These are fail-closed verification oracles, not generated client runtime code. |
| Continuity, death/succession, executor, and adversarial models | Retain permanently as noncanonical executable specifications | They provide counterexamples, safety evidence, and liveness witnesses. |
| Versioning and residual-assumption documents | Retain permanently as noncanonical documentation | Future promotion and rollback depend on these limits being explicit. |
| Focused and repository-wide tests | Retain as mandatory CI gates | Promotion must never bypass or silently remove the model evidence. |

The machine-readable per-file disposition is in `founder-governance-promotion-review.json`.

## Security review

### Passed at the executable-model level

- Unknown versions and unsupported canonicalization fail closed.
- Policy replacement cannot reduce protected quorum, notice, delay, expiry, or anti-self-dealing restrictions.
- Participant IDs, roles, and credentials are resolved against tenant-controlled state rather than trusted from approval payloads.
- Notice and evidence requirements are explicit and mutation-tested.
- Continuity authority cannot issue equity, weaken policy, delete audit history, transfer IP, or perform configured related-party value transfers.
- Stale continuity generations and stale fencing tokens cannot execute.
- Unknown provider outcomes remain pending or unknown until current provider state supplies evidence.
- Changed or missing protected provider state produces freeze-and-reconcile behavior.

### Deferred before canonical promotion

- Real browser/WebAuthn cryptographic verification and opaque-state protection: DEN-493.
- Credential lifecycle, atomic replacement, counter and backup-state policy: DEN-494.
- Browser, restart, replica, storage, key-rotation, and redaction matrix: DEN-495.
- Verified assertion receipt authentication and exactly-once final approval append: DEN-496.
- Provider-specific GitHub and Cloudflare bypass and reconciliation review: DEN-207 and DEN-209.
- Qualified legal review of public ownership, fiduciary, death, incapacity, estate, and governance claims.

## CI evidence state

The final PR head for PR #24 passed the focused Founder Control Plane workflow and repository-wide CI before merge. PR #24 is merged.

The repository workflows are configured to run on `push` to `main`, but the connected workflow lookup currently exposes only pull-request-triggered runs. DEN-491 therefore retains the explicit post-merge evidence gate rather than treating the absence of returned push runs as proof of success or failure.

Canonical promotion remains blocked until authoritative main-branch evidence is attached through an available Actions interface or an explicit repository policy establishes the required-check evidence used at merge as authoritative.

## Promotion prerequisites

Before changing `status` to `canonical` or setting a promotion marker:

1. Close the post-merge main-CI evidence gap.
2. Complete DEN-493, DEN-494, DEN-495, and DEN-496.
3. Revise the schemas to include the reviewed credential and verified-assertion boundaries.
4. Review which objects are true cross-service wire/storage contracts.
5. Add only those approved schemas to `schema/index.json`.
6. Regenerate Rust, Rust-WASM, TypeScript/Zod, Dart, Python, and Go.
7. Prove zero generated drift in hosted CI.
8. Run the rollback drill below.
9. Re-run the adversarial explorer and all semantic tests against the promoted contracts.
10. Record an explicit security-review approval and legal-claims boundary.

## Rollback drill

The canonical migration must be additive and reversible:

1. Preserve the pre-promotion schema index and generated artifacts.
2. Deploy readers that understand old and candidate contract versions before enabling candidate writes.
3. Shadow-validate candidate objects without authorizing effects.
4. Enable candidate writes only for disposable tenants.
5. Verify old-version reads, historical receipt verification, stale-worker fencing, and candidate rollback.
6. Disable candidate writes before rolling readers back.
7. Never rewrite signed proposals, approvals, transitions, authorities, or receipts in place.
8. Keep original bytes or a verifiable original content hash for every historical object.

This drill is planned but not yet executed. Its successful evidence is a canonical-promotion prerequisite.

## Nonclaims

A future canonical technical contract will not establish legal ownership, determine death or incapacity, appoint an estate representative, prove corporate office, or replace operating agreements, shareholder agreements, board authority, estate planning, courts, registrars, banks, cap-table systems, or provider support recovery.
