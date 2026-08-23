# Contract ownership

Two repos, two halves of one contract. Keeping the split explicit is what stops
either half from being quietly redefined by the other.

| Half | Lives in | Answers |
|---|---|---|
| **Payload schemas** — request and response bodies | this repo, under `schema/` or `schemas/` | "is this JSON valid?" |
| **Surface contract** — what every SDK must export | the paired `*-clients` repo, at `contract/surface.contract.json` | "does every language expose the same interface?" |
| **Meta-schema** — the shape a surface contract may take | published from here as [`schema/surface.schema.json`](surface.schema.json) | "is that contract document itself well-formed?" |

## Why the surface contract is not JSON Schema

JSON Schema validates JSON *data*. An SDK's exported interface is not JSON data,
so aiming JSON Schema at it directly is a category error. The split above uses it
where it fits and nowhere else: payload bodies are validated as data, and the
surface contract is a JSON *document* — which JSON Schema then validates
rigorously, with editor completion as a bonus.

## Vendoring

The clients repo copies the schemas here into its own `contract/schemas/` and
records each file's sha256. That keeps its CI hermetic while making drift
detectable from both directions:

- **from the clients side** — `contract/bin/check_surface.py` fails if a vendored
  copy was hand-edited, and warns when this repo has moved on
- **from this side** — `scripts/validate_schemas.py` fails if a sibling
  `*-clients` checkout is carrying a stale copy

After changing a schema here, re-vendor in the clients repo:

```sh
cd ../<product>-clients
python3 contract/bin/derive_contract.py --repo . --product <slug> \
    --interfaces-repo ../<product>-interfaces
```

## Checks

```sh
python3 scripts/validate_schemas.py                 # this repo
python3 scripts/validate_schemas.py --format github # CI annotations
python3 scripts/validate_schemas.py --consumers ../<product>-clients
```

Standard library only; `jsonschema`, when installed, adds full meta-schema
validation and checks each schema's own `examples` against it.
