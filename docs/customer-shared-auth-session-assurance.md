# Customer Shared Auth session assurance

A cryptographically valid Shared Auth token is not, by itself, proof that the Fiducia customer application completed the user's current Supabase MFA requirement.

The customer application therefore binds a Shared Auth `sid` to a local `customer_sessions` row only after it has:

1. verified the provider token against the distinct `fiducia-customer` Supabase project;
2. checked the provider's current verified-factor state;
3. completed TOTP step-up when a verified factor exists;
4. exchanged the resulting provider token through Shared Auth;
5. verified the Shared Auth customer role and local `org_members` membership;
6. stored the Shared Auth `sid`, `provider_project = 'fiducia-customer'`, local `aal2`, verification time, and a bounded expiry.

Every later browser request carrying a Shared Auth cookie must match a non-revoked, unexpired local row for the same local customer user. A Shared Auth token obtained outside this application has no such row and fails the customer MFA gate.

Provider bearer requests may use direct provider verification only for explicitly authentication-only behavior. They must use the configured customer Supabase project, current provider assurance, and a live factor lookup. Direct provider verification never manufactures a Shared Auth role or session binding.

Local organization authorization remains exclusively in `org_members`. Neither Shared Auth roles nor provider metadata grant organization membership. The admin Supabase project, admin database, and admin roles are outside this customer-plane trust boundary.
The customer app therefore binds the Shared Auth `sid` to a local `customer_sessions` row only after the app has:

1. verified the customer's provider token against the distinct `fiducia-customer` Supabase project;
2. checked the provider's current verified factor state;
3. completed TOTP step-up when a verified factor exists;
4. exchanged the resulting provider token through Shared Auth;
5. verified customer role and local organization membership;
6. recorded the Shared Auth session as local `aal2` with a bounded expiry.

Every later browser request carrying a Shared Auth cookie must match a non-revoked, unexpired local row for the same Supabase user. Shared Auth tokens exchanged outside this application do not have that row and fail the customer MFA gate.

Provider bearer requests continue to use the provider token's verified assurance plus a live factor lookup. Local organization authorization remains in `org_members`; neither Shared Auth roles nor provider metadata grant organization membership.
