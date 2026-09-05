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
- `provenance/commercial-intake-parity-policy.json` is the reviewed model/operation comparison policy.
- `provenance/commercial-intake-parity-policy.schema.json` validates that policy independently with JSON Schema Draft 2020-12.
- `src/check-peer-contract-sources.mjs` validates the meta-contract, enforces semantic policy rules, verifies local publication bytes, and optionally verifies every immutable GitHub pin.
- `src/materialize-peer-contract-sources.mjs` fetches immutable authorities into runner-temporary storage after checking their Git blob identities and expected markers.
- `tools/commercial-intake-parity/` contains the dependency-free Rust semantic comparator and its fail-closed `--require-pass` mode.
- `.github/workflows/commercial-intake-peer-sources.yml` runs unit/negative tests, local and remote pin verification, Rust formatting/tests/lints, deterministic semantic comparison, and the negative certified-generation gate.

## Commands

From the repository root:

```bash
npm ci --ignore-scripts --no-audit --no-fund
node --test src/check-peer-contract-sources.test.mjs src/materialize-peer-contract-sources.test.mjs
node src/check-peer-contract-sources.mjs --offline
GITHUB_TOKEN='ephemeral-actions-token' node src/check-peer-contract-sources.mjs --remote
```

The token is optional for public repositories but avoids anonymous API rate limits. The checker and materializer use it only in an `Authorization` request header and never include it in receipts or logs.

A successful checker process means the recorded evidence is internally consistent and every requested immutable pin was verified. The receipt may still report `STOPPED_FOR_EVALUATION`; that status means promotion remains blocked until the discrepancy's resolution criteria are met.

Repository promotion gates also require a clean lockfile install and a high-severity dependency audit. A newly disclosed advisory therefore blocks promotion until the compatible dependency line is moved to a patched release and the exact updated lock passes package, interface, provenance, and audit checks.

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

Hash equality is necessary for an exact-copy claim but is not semantic parity. The Rust parity engine compares:

- reviewed TypeSpec-model to JSON-Schema-definition pairs;
- camel-case TypeSpec fields against snake-case JSON wire names, with explicit reviewed rename/exception sets only;
- field presence, requiredness, string literals, and enum values;
- HTTP methods, versioned paths, operation names, request-body models, public/admin visibility, `Idempotency-Key`, and `If-Match`;
- the identity of the local publication contract.

The current local `schema/commercial_intake.schema.json` is not silently treated as the lifecycle authority. It is classified as a **distinct lead/estimate intake contract** because it defines non-binding quote requests, lead registration, and enterprise-application intake, whereas the pinned peer authorities define versioned lifecycle documents, acceptance evidence, and service operations. That conceptual distinction is machine-checked; it does not waive the missing lifecycle publication or the remaining peer-authority mismatches.

The engine emits deterministic discrepancy receipts twice in CI. `--require-pass` writes the receipt and returns status 2 while any discrepancy remains, so certified interface/code generation cannot proceed by ignoring the stop state. The reviewed policy itself records the expected stop/pass state; an unexpected transition in either direction fails and requires a policy review.

The remaining reconciliation includes adding the missing versioned support-plan and SLA-policy transport models, resolving structural/wire-name differences such as application attestations, and then running generated Rust, TypeScript, Go, and Dart interfaces plus SQL/Diesel/SeaORM catalog checks from both authorities. Neither authority is generated from the other.

## Future contract home

The intended long-term package is `fiducia-lib-core`. Until that repository exists and is explicitly adopted, `fiducia-interfaces` is an interim publication boundary only. Moving the manifest later must preserve immutable source pins, discrepancy history, and consumer release evidence; it must not create a third canonical schema copy.

## Non-production boundary

This provenance lane reads source files and emits deterministic evidence. It does not create or modify DNS records, Cloudflare routes, Workers, databases, migrations, customer registrations, quotes, signatures, contracts, or production services.
