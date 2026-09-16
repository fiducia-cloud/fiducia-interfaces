# Fiducia API route contracts

`fiducia-api.route-map.json` is the authoritative operation inventory for the public Fiducia HTTP/custom-RPC surface.

The route map owns stable operation keys, paths, methods, transport declarations, authorization posture, idempotency requirements, and bindings to existing DTO authorities. It intentionally does **not** duplicate the business payload schemas from `../schema/commercial_intake.schema.json`.

Rust request/response structs continue to be generated from the authored interface schemas in this repository. Product web/API servers may consume this route map through a pinned `ORESoftware/api-docs` toolchain to generate `ores-rpc-calls-http-tcp-pool` marker types. That transport projection is generated downstream; it is not another schema authority.

Rules:

- changing an HTTP/custom-RPC operation requires changing the route map;
- changing a request/response DTO requires changing the authored interface schema and regenerating language bindings;
- `idempotency-key` remains part of the route contract for mutating commercial-intake operations;
- the web server consumes typed client calls only and must not mount the custom-RPC server router;
- the API server is the server-side custom-RPC authority;
- product builds must pin the exact `api-docs` contract/tool SHA and must not fetch a floating `latest` contract during compilation.
