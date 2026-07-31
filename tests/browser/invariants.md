# Browser acceptance invariants

Every authored scenario must preserve these properties:

1. Browser mutations use `http://control.localhost:18080/operations/api/rpc`.
   Tests do not call the private Operations operator API.
2. Authenticated contexts contain a real IAM `px_session`. Anonymous contexts
   contain none. External OIDC is not part of this local witness.
3. The `operations-notes` principal sees exactly its supported application
   scope. Direct
   identifiers and aggregate responses must not reveal the hidden sibling.
4. Assertions use unique fixture markers and persisted state after navigation
   or reload. They do not rely on whole-table counts, random IDs, scenario order,
   or transient success text.
5. The SDK scenario treats ingest HTTP 202 plus the persisted grouped issue as
   acceptance. `Sentry.flush()` alone is not delivery evidence.
6. The SDK witness is limited to `@sentry/browser` 10.69.0 error-event envelopes.
   It does not claim tracing, replay, sessions, logs, metrics, or general Sentry
   protocol compatibility.
7. Operations disruption remains bounded to the Operations plane and always
   restores the service before test exit.
8. Browser state, credentials, DSNs, reports, screenshots, videos, and local
   databases remain uncommitted and must not appear in logs.
