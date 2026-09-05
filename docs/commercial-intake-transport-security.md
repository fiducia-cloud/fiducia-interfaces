# Commercial-intake transport and security boundary

The canonical schemas in `schema/commercial_intake.schema.json` define business
payloads. They do not authorize a public endpoint to accept unbounded JSON or to
trust caller-supplied audit metadata. Every quote, pre-interest, and enterprise
application transport must enforce this boundary before persistence.

## Endpoint contract

Use purpose-specific versioned routes beneath the reviewed Fiducia API origin:

- `POST /v1/commercial-intake/pre-interest`
- `POST /v1/commercial-intake/quotes`
- `POST /v1/commercial-intake/applications`

Marketing hosts may link or submit through the API/BFF, but must never hold a
service-role/database credential or write directly to persistence.

Each request must:

1. require `Content-Type: application/json` and reject ambiguous or duplicate
   framing;
2. enforce a route-specific compressed and decompressed body limit before JSON
   parsing;
3. validate the complete payload against the checked-in schema with unknown
   properties rejected;
4. require a bounded, high-entropy `Idempotency-Key` for quote and application
   creation and apply replay semantics before downstream side effects;
5. attach server-derived request metadata, including canonical source host,
   route version, schema version, received time, authenticated principal when
   present, and privacy-preserving network attribution;
6. record the exact privacy-notice, consent, and terms versions accepted by the
   submitter; and
7. return an enumeration-resistant receipt rather than echoing the submission.

Anonymous pre-interest is allowed only with explicit consent, abuse controls,
and no privileged response data. Authenticated enterprise submissions must use
the shared-auth boundary and fail closed when issuer, audience, or tenant checks
cannot be completed.

## Data minimization and secret denial

The intake is for requirements and procurement data, not credentials. Reject or
quarantine values that contain private-key markers, access-token shapes,
connection strings with embedded credentials, or other prohibited secrets. Do
not rely on UI copy alone. Server-side validation and redaction are mandatory.

Collect only fields required for qualification, architecture, security review,
pricing, procurement, contracting, or support planning. Associate each field
family with a documented purpose, retention period, access role, and deletion or
legal-hold rule. Attachments, when introduced, require a separate contract with
file count/size/type limits, malware scanning, content-disposition hardening,
quarantine, and object-level authorization.

## Browser and edge controls

- Permit only reviewed origins; never reflect arbitrary `Origin` values.
- Cookie-authenticated writes require same-site cookies and CSRF protection.
- Apply per-IP/network, per-account, per-tenant, and per-idempotency-key limits
  with bounded queues and typed retry responses.
- Cloudflare bot/WAF controls supplement rather than replace application-layer
  validation and authorization.
- Do not expose service-role credentials to Workers, Pages, browsers, mobile
  clients, logs, traces, analytics, or error bodies unless a narrowly reviewed
  server-side Worker is the intentional trust boundary.

## Logging and audit events

Emit structured event metadata and correlation identifiers, never full request
bodies or credentials. Redact contact, legal, billing, security, and free-text
fields by default. Persist append-only events for consent, receipt creation,
idempotent replay, quote revisions, approvals, contract-version acceptance,
support-tier changes, and administrator access.

Security telemetry must distinguish validation failure, abuse rejection,
authentication failure, authorization failure, persistence failure, and
idempotent replay without revealing whether a particular person or organization
already submitted data.

## Commercial and SLO semantics

A requested support response time, availability target, RTO/RPO, service credit,
or contract term is a non-binding preference. It becomes an obligation only
through an accepted, versioned order form or agreement approved by the required
parties. Compliance selections describe requested review scope and must never be
rendered as a certification claim.

The signed contract record must identify the exact MSA/SOW/order form/SLA/DPA,
service definition, support tier, severity matrix, measurement source, SLI and
SLO definitions, maintenance/exclusion rules, error-budget policy, remedies,
term, governing terms, and acceptance principals.

## Required verification

Before public activation, prove:

- validator parity for every generated language target;
- body, depth, string, array, and free-text bounds;
- idempotent replay and conflicting-replay behavior;
- RLS/authorization and append-only persistence behavior;
- telemetry redaction and secret-shape rejection;
- origin, CORS, cookie, CSRF, rate-limit, and bot-control behavior;
- retention/deletion/export/legal-hold behavior;
- outside-in DNS, TLS, routing, health, and fail-closed origin probes; and
- live SLI/SLO queries for every term offered in a signed SLA.
