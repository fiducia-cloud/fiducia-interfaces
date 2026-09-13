# Transport parity canary

This canary exercises the next contract layer without changing the existing Fiducia opportunity packet authority.

## Authority and projection roles

`main.tsp` and `authored.schema.json` are independently authored structural peers for the request and response models. Neither is generated from the other. `service.tsp` gives the operation a stable TypeSpec identity. `behavior.contract.json` is a separate independently authored behavioral authority.

`openapi.json` and `service.proto` are transport projections of that admitted interface. `openapi.projection.json` and `protobuf.projection.json` are normalized TJSV compatibility inputs used to compare transport revisions without promoting generated artifacts to structural authority.

The operation identity is `evaluate_opportunity_admission` everywhere it can be represented directly. OpenAPI uses it as `operationId`. Protobuf keeps idiomatic RPC naming (`EvaluateOpportunityAdmission`) and binds the method back to the behavioral authority with the custom `ores.behavior.v1.operation_id` method option in `options.proto`.

## Behavior

The canary models one pure admission predicate from the existing opportunity safety boundary: the packet must have been shown and explicitly approved, while legal terms, payment obligations, travel commitments, recording/publicity consent, and relocation commitments remain false.

The CEL expression is authored once in `behavior.contract.json`. OpenAPI embeds the normalized behavior payload as `x-ores-behavior` because OpenAPI extensions are a natural carrier for operation metadata. Protobuf intentionally carries only the stable behavior operation ID; the CEL source is not duplicated into `.proto`.

## Naming

New request/response fields use snake_case. Protobuf fields also declare explicit snake_case `json_name` values so Protobuf JSON mapping cannot silently change the external names to lowerCamelCase.

## Admission path

The repository test `src/transport-parity-canary.test.mjs` checks structural field parity, stable operation identity, OpenAPI behavior payload identity, HTTP schema bindings, Protobuf field numbers and JSON names, RPC shape, the Protobuf-to-behavior operation binding, and the complete seven-boolean predicate truth table.

TJSV owns the canonical behavior/OpenAPI/Protobuf normalizers and compatibility algorithms; ores-cli owns fleet discovery and rollout enforcement. This repo is the consumer canary proving those surfaces can coexist without collapsing their authority roles.
