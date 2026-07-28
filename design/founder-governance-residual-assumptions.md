# Founder governance adversarial explorer — bounds and residual assumptions

Status: noncanonical executable discovery evidence for DEN-473 / DEN-175.

## Finite bounds checked

The deterministic explorer enumerates the Cartesian product of:

- every declared continuity state;
- every declared action kind and action class;
- every subset of the six default participants;
- all-active participants plus each individual participant suspended and revoked;
- all combinations of bounded, equivalent-access-only, defensive-only, preapproved, and legal-authority-attested context flags;
- every declared transition edge with its positive witness and mutations of generation, expiry, quorum, notice, evidence, attestation, mediation, and subject approval;
- constitutional delegated-capability attempts, stale fencing, unknown provider outcomes, higher-fenced reconciliation, and changed or missing protected provider state.

The suite records structured counterexamples and fails if any are reachable.

## Safety properties

Within these bounds:

1. No one active participant can authorize a constitutional action.
2. No continuity state other than the explicitly modeled succession process can authorize a constitutional action.
3. Recovery in a continuity state requires equivalent-access-only authority.
4. Emergency continuity authority is defensive-only.
5. A suspended or revoked participant cannot increase authority.
6. Missing notice, evidence, independent attestation, mediation, subject approval, or generation freshness prevents a transition.
7. Delegated authority cannot execute a constitutional action even when its supplied capability is intentionally overbroad.
8. A stale fencing token cannot reach the provider.
9. An unknown provider result remains pending/unknown until provider-state evidence supports a terminal result.
10. Changed or missing protected provider fields produce critical freeze-and-reconcile alerts.

## Liveness witnesses

The explorer requires explicit reachable witnesses for:

- bounded routine operation during temporary unavailability;
- equivalent-access credential recovery during incapacity;
- defensive emergency action during nonparticipation;
- preapproved bounded routine operation during deadlock;
- the stronger founder + guardian + estate + externally attested succession process;
- every declared continuity transition edge.

## Assumptions not proved by this model

- Participant, guardian, estate-representative, successor, and external-attestor identities are provisioned through an independently reviewed process.
- Evidence references are authentic only after the separate evidence-verification boundary validates them.
- Notice delivery receipts accurately represent the configured delivery provider.
- Clocks remain within the deployment's declared skew bound; no property assumes perfectly synchronized clocks.
- Fiducia consensus, compare-and-set, idempotency, lease, and fencing primitives meet their separately tested contracts.
- The provider adapter regenerates a typed request from canonical parameters and does not expose arbitrary HTTP, shell, or agent execution.
- Provider reads used for reconciliation are authoritative for the protected field being checked.
- External provider support personnel, courts, corporate registries, banks, registrars, and cap-table systems may bypass connected technical controls.
- Fiducia does not determine legal death, incapacity, abandonment, estate authority, ownership, fiduciary status, or the legal validity of a transaction.

## Deliberately excluded state dimensions

- Arbitrary numbers of founders, guardians, estates, or successor classes.
- Byzantine compromise of Fiducia's own quorum beyond the separate consensus threat model.
- Cryptographic forgery of reviewed signature and WebAuthn implementations.
- Unbounded network scheduling or a proof of fairness under permanent partitions.
- Provider-specific authorization semantics before the GitHub and Cloudflare sandbox connectors exist.
- Legal and economic consequences of a technically approved action.

## Promotion consequence

A green bounded explorer is necessary but not sufficient for canonical promotion. Hosted CI evidence, cross-language canonicalization vectors, provider-specific bypass analysis, durable WebAuthn ceremonies, rollback testing, and explicit security review remain mandatory.
