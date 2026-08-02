# Customer Shared Auth session assurance

A cryptographically valid Shared Auth token is not, by itself, proof that the Fiducia customer application completed the user's current Supabase MFA requirement.

The customer app therefore binds the Shared Auth `sid` to a local `customer_sessions` row only after the app has:

1. verified the customer's provider token against the distinct `fiducia-customer` Supabase project;
2. checked the provider's current verified factor state;
3. completed TOTP step-up when a verified factor exists;
4. exchanged the resulting provider token through Shared Auth;
5. verified customer role and local organization membership;
6. recorded the Shared Auth session as local `aal2` with a bounded expiry.

Every later browser request carrying a Shared Auth cookie must match a non-revoked, unexpired local row for the same Supabase user. Shared Auth tokens exchanged outside this application do not have that row and fail the customer MFA gate.

Provider bearer requests continue to use the provider token's verified assurance plus a live factor lookup. Local organization authorization remains in `org_members`; neither Shared Auth roles nor provider metadata grant organization membership.
