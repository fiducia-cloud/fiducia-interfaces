# schema — JSON Schema source of truth

The Draft 2020-12 JSON Schemas that define fiducia.cloud's API payload types (KV,
locks/semaphores/RW, rate limiting, scheduling, elections, discovery, barriers,
budgets, claims, counters, decisions, effects, handoffs, idempotency, tasks, plus the
`common` envelopes). `src/generate.mjs` turns these into idiomatic per-language types
under `generated/`.

Edit these to change a payload shape, then regenerate. `index.json` lists every schema
file (alphabetised) and is what the generator loads; keep it in sync when adding a schema.
