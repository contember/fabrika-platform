# Browser acceptance invariants

Every authored scenario must preserve these properties:

1. Browser mutations use `http://control.fabrika.localhost:18080/operations/api/rpc`.
   Tests do not call the private Operations operator API.
2. Authenticated contexts contain a real IAM `px_session`, scoped to the shared
   `fabrika.localhost` parent the way IAM issues it. Anonymous contexts contain
   none, and the browser stack runs with IAM's local login bypass OFF so an
   anonymous browser really is one. External OIDC is not part of this local
   witness.
3. Every request is authorized by the proxy, against the same gates production
   uses. A scenario never asserts that an application refused something the
   proxy should have refused first, and never presents a credential the proxy
   would not have injected — the browser holds an opaque session and nothing
   else. The principal a scenario is signed in as comes from
   `readBrowserPrincipal()`, not from a token.
4. The `operations-notes` principal sees exactly its supported application
   scope. Direct
   identifiers and aggregate responses must not reveal the hidden sibling.
5. Assertions use unique fixture markers and persisted state after navigation
   or reload. They do not rely on whole-table counts, random IDs, scenario order,
   or transient success text.
6. The SDK scenario treats ingest HTTP 202 plus the persisted grouped issue as
   acceptance. `Sentry.flush()` alone is not delivery evidence.
7. The SDK witness is limited to `@sentry/browser` 10.69.0 error-event envelopes.
   It does not claim tracing, replay, sessions, logs, metrics, or general Sentry
   protocol compatibility.
8. Operations disruption remains bounded to the Operations plane and always
   restores the service before test exit.
9. Browser state, credentials, DSNs, reports, screenshots, videos, and local
   databases remain uncommitted and must not appear in logs.
