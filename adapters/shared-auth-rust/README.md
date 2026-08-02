# Fiducia Shared Auth guard

This adapter is the deployable authentication boundary shared by the Fiducia customer and admin Rust applications.

It implements the public Shared Auth protocol rather than importing source from the private `shared-auth/shared-auth-lib` repository. That keeps normal Fiducia container builds free of source-control credentials while preserving the same security contract:

- verify existing Shared Auth ES256 JWTs locally against a cached JWKS;
- pin issuer, audience, provider, provider tenant, project and Supabase subject;
- when presented only a Supabase access token, race Shared Auth exchange/introspection against direct verification at exactly one configured Supabase project;
- return a redacted Shared Auth access-token upgrade only when the Shared Auth arm wins;
- never return or persist a refresh token;
- permit direct Supabase success only through `Guard::authenticate`;
- require Shared Auth roles through `Guard::authorize`, degrading rather than inferring privilege from provider metadata;
- distinguish anonymous, invalid, forbidden and temporarily degraded decisions.

Applications remain responsible for their own cookie names, `Secure`/`HttpOnly`/`SameSite` attributes, CSRF binding, local user/session mirrors and local organization/operator authorization records.

## Required runtime configuration

Each application supplies its own values for:

- Shared Auth base URL, issuer, audience and introspection secret;
- that application's Supabase URL, publishable key and project name;
- the Shared Auth roles accepted by that application;
- bounded arm/race timeouts and JWKS cache lifetime.

Customer and admin must never share the same project name or Supabase URL.

## Validation

`.github/workflows/shared-auth-adapter.yml` resolves the dependency graph, runs Rust formatting, clippy and all mock-authority tests on Rust 1.95, and audits the resolved lockfile. The tests cover local JWT verification, provider exchange and session rotation, direct-provider authentication fallback, privileged fail-closed behavior, role denial, cross-project rejection and credential-free requests.
