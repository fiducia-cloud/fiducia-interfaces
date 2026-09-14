# Fleet contract dependency boundary

Fiducia owns its consensus, lease-provider, and service-specific wire/domain contracts. Fleet consumers that merely need locking, leases, or fencing should depend on `oresoftware/ores-locks-and-leases` rather than importing Fiducia directly.

## Fleet dependency rules

- Keep Fiducia-specific Raft/SMR/provider contracts in this org.
- Reuse genuinely fleet-generic semantic primitives from `oresoftware/ores-interfaces` where appropriate.
- Expose Fiducia as a provider behind `oresoftware/ores-locks-and-leases` for consumers whose requirement is coordination rather than Fiducia itself.
- Kubernetes/NATS/Redis deployment topology belongs in `oresoftware/k8s-libs-and-shared-defs`, while semantic message contracts remain with their proper contract authority.
- Independently authored TypeSpec and JSON Schema Draft 2020-12 authorities are checked with `oresoftware/typespec-json-schema-validator`; neither is rewritten from the other to force agreement.
- `oresoftware/ores-cli` is governance tooling and should validate the exact zed-pkg resolved dependency graph.
- `.zpkg.toml` expresses intent; `.zpkg.lock` identifies the exact execution dependency. Tip-of-default-branch validation is a separate canary, not a replacement for locked validation.

## Anti-cycle rule

Fiducia domain packages may consume generic shared primitives, but shared fleet packages must not depend back on Fiducia runtime implementations. Applications needing generic coordination consume the locks/leases abstraction.