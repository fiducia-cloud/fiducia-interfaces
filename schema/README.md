# schema — JSON Schema payload authority and publication source

The Draft 2020-12 JSON Schemas in this directory define fiducia.cloud payload types
(KV, locks/semaphores/RW, rate limiting, scheduling, elections, discovery, barriers,
budgets, claims, counters, decisions, effects, handoffs, idempotency, tasks, and common
envelopes). `src/generate.mjs` turns them into idiomatic per-language types and runtime
validators under `generated/`.

Edit these schemas to change this repository's JSON wire payloads, then regenerate.
`index.json` lists every schema file alphabetically and is what the generator loads; keep
it in sync when adding a schema.

JSON Schema is not a substitute for the independent TypeSpec HTTP/transport authority.
For commercial intake, the immutable peer-source pins and current publication divergence
are recorded in `provenance/commercial-intake.peer-sources.json`. Until that discrepancy
is resolved with reviewed semantic evidence, generated commercial-intake clients and SQL
or ORM projections must not be described as cross-authority certified. Do not copy one
source over the other merely to make hashes agree.
