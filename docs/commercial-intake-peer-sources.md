# Commercial-intake peer-source provenance

## Current disposition

Commercial-intake contract promotion is **STOPPED_FOR_EVALUATION**. The stop is deliberate and fail-closed: it does not mean the individual schemas are invalid, and it does not make either schema the automatic winner.

Two independently authored authorities are pinned at `fiducia-cloud/fiducia-infra@6d3891ddb3eba135d8c7e128f5f5e16935b4ba25`:

- TypeSpec `quote-system/contracts/main.tsp` owns HTTP operations, methods, paths, transport headers, request/response transport shapes, and public versus administrative API audiences.
- JSON Schema Draft 2020-12 `quote-system/contracts/commercial-intake.schema.json` owns payload validation, exact JSON wire names, document discriminators, fixtures, and compatibility constraints.

The current `fiducia-interfaces` publication snapshot is pinned separately. Its commercial-intake JSON Schema has a different immutable Git blob identity and a different document/model organization from the JSON Schema authority above. That mismatch is recorded, fingerprinted, and blocks certification; the checker never copies one source over the other.

## Files

- `provenance/commercial-intake.peer-sources.json` pins repositories, commits, paths, Git blob identities, expected contract markers, the open discrepancy, blocked promotions, and the evidence required to resume promotion.
- `provenance/peer-contract-sources.schema.json` is the Draft 2020-12 meta-contract for the manifest.
- `src/check-peer-contract-sources.mjs` validates the meta-contract, enforces semantic policy rules, verifies local publication bytes, and optionally verifies every immutable GitHub pin.
- `.github/workflows/commercial-intake-peer-sources.yml` runs unit/negative tests plus local and remote verification.

## Commands

From the repository root:

```bash
npm ci --ignore-scripts --no-audit --no-fund
node --test src/check-peer-contract-sources.test.mjs
node src/check-peer-contract-sources.mjs --offline
GITHUB_TOKEN='ephemeral-actions-token' node src/check-peer-contract-sources.mjs --remote
```

The token is optional for public repositories but avoids anonymous API rate limits. The checker uses it only in the `Authorization` request header and never includes it in receipts or logs.

A successful checker process means the recorded evidence is internally consistent and every requested immutable pin was verified. The receipt may still report `STOPPED_FOR_EVALUATION`; that status means promotion remains blocked until the discrepancy's resolution criteria are met.

## Fail-closed rules

The checker rejects:

- anything other than exactly one TypeSpec authority and one JSON Schema authority;
- generated output being declared an authority;
- mutable branch names or abbreviated commit/blob identities in pinned references;
- missing expected TypeSpec/JSON Schema markers;
- a JSON Schema document that is not Draft 2020-12 or lacks `$defs`;
- a publication relationship that disagrees with the pinned Git blob identities;
- divergent publication bytes without an open discrepancy;
- a stale or fabricated discrepancy fingerprint;
- `PASS` while any discrepancy remains open;
- repository-relative paths that are absolute, use backslashes, or traverse parents.

## Semantic reconciliation

Hash equality is necessary for an exact-copy claim but is not semantic parity. The next parity engine must compare at least:

- model and field identity, wire-name mapping, requiredness, nullability, defaults, bounds, formats, patterns, enums, unions, and discriminators;
- methods, versioned paths, path parameters, body types, status families, public/admin visibility, idempotency headers, and optimistic-concurrency preconditions;
- generated Rust, TypeScript, Go, and Dart interfaces and runtime validators;
- SQL catalogs and migrations generated independently from both authorities;
- Diesel and SeaORM projections and transaction/state-machine behavior.

Per the project directive, that deeper semantic/catalog engine should be implemented in Rust. It must emit deterministic discrepancy receipts and stop for review instead of choosing TypeSpec, JSON Schema, Diesel, or SeaORM wholesale.

## Future contract home

The intended long-term package is `fiducia-lib-core`. Until that repository exists and is explicitly adopted, `fiducia-interfaces` is an interim publication boundary only. Moving the manifest later must preserve immutable source pins, discrepancy history, and consumer release evidence; it must not create a third canonical schema copy.

## Non-production boundary

This provenance lane reads source files and emits deterministic evidence. It does not create or modify DNS records, Cloudflare routes, Workers, databases, migrations, customer registrations, quotes, signatures, contracts, or production services.
