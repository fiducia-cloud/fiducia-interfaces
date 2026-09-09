# Opportunity packet admission and approval boundary

Linear: DEN-3330

## Purpose

Fiducia's opportunity workflow spans fundraising, computing credits, AI/API
credits, conference proposals, and provider-linked job applications. This
contract prevents those lanes from silently widening into unsupported company,
employment, legal, financial, travel, publicity, or relocation representations.

## State rules

A `prepared` packet has no approval digest or approval/submission timestamp.
Every later state requires the completed packet to have been shown to Alex and
explicitly approved, with a lowercase SHA-256 digest binding the approval to
that exact packet. Submitted and post-submission states additionally require a
submission timestamp no earlier than the approval timestamp.

The contract is deliberately not an authorization to send. It is admissible
data for a downstream submission tool, which must still use a verified official
route and retain provider receipt evidence before counting formal intake.

## Independent authorities

TypeSpec and JSON Schema Draft 2020-12 remain peer authorities. CI uses
`ORESoftware/typespec-json-schema-validator` to compile TypeSpec, create a
comparison-only JSON Schema witness, validate both sources, replay shared valid
and invalid instances, compare declaration semantics, emit Contract IR, and
prove that current-input, complete-inventory admission rejects altered evidence.
No source overwrites or outranks the other.

## Runtime boundary

TypeScript, Rust, Go, and Dart consumers may project this contract only after a
fresh passed receipt and admissible Contract IR cover all seven declarations.
The generated witness is never a publication authority. A stopped TJSV run,
stale digest, sparse inventory, source mutation, or fallback attempt blocks
runtime projection and consequential submission.

## Deliberate exclusions

This packet does not assert eligibility, funding, traction, revenue, location,
legal status, employment history, work authorization, compensation expectations,
or relocation intent. It carries only separately verified facts and explicit
unresolved facts. It cannot accept legal terms, payment, travel, recording or
publicity, or relocation commitments.
