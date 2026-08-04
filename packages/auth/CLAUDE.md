# @fabrika/auth

The app-facing IAM SDK — what an application uses instead of hand-rolling auth. It depends only on
`@fabrika/auth-core`: the binding is typed as the `IamRpc` CONTRACT, so the SDK never imports the IAM
Worker. Assumes the root CLAUDE.md.

`createIam(env, opts)` is the single request-time entry point. It returns the management surface, the
middleware factories (`authMiddleware` / `apiKeyMiddleware` / `capabilityMiddleware`), and a dev
login handler — backed by the real `IAM` binding off-local, or by `FakeIamClient` plus synthetic
personas when `env.DEV` is truthy.

## Invariants

- **Verify tokens LOCALLY against the published JWKS.** The short-lived per-app `px_token` is checked
  in-process; the long-lived `px_session` SSO cookie is exchanged for a fresh one (`mintToken`) only
  when the permission token is missing or near expiry — about once per TTL, not per request. The JWKS
  is fetched once per isolate and cached per binding; an unknown `kid` triggers ONE refetch.
- **ONE `Iam`/`PropustkaAuth` instance per process, never per request** — the JWKS cache is keyed by
  that object in a WeakMap.
- **Gate matching is fail-closed**, and precedence is `gates.rules` ORDER: `public` is terminal and
  makes no binding call; `service` falls through when its credential is ABSENT and 401s when it is
  present-but-invalid; `human` falls through when the session is missing or expired, remembering a
  `loginUrl`. A request matching NO rule is denied — there is no edge in front anymore.
- **A DECIDED NEGATIVE IS A 200.** Over the HTTP transport (`HttpIamRpc`), `{ ok: false, reason }`
  means "IAM answered: no"; a non-200 means "IAM could not be consulted". Only the second is an
  incident and only the second throws. Never collapse the two.
- **`HttpIamRpc` is a transport, not a second IAM.** It holds no policy. `@fabrika/iam`'s
  `src/rpc-http.ts` is the wire contract; everything downstream of `IamRpc` is byte-for-byte the same
  code on both transports.
- **`reconcileSchema` (`src/provision.ts`) is a DEPLOY-time helper, never a runtime one.** It talks
  HTTP to the admin origin with an IAM-issued `px_` ADMIN key. It is idempotent: the endpoint upserts
  `origin='app'` rows and deletes app-origin rows absent from the body, and never touches
  `origin='custom'` policies.
- **Middleware may mutate `ctx`, short-circuit by returning a Response without calling `next()`, or
  wrap `next()` to append headers.** The `Middleware<Ctx>` shape is owned here and consumed by
  `@fabrika/app`; do not add a duplicate compatibility interface there.
- **Never log credentials, secret values, or request headers.**

## Notes

- The authz vocabulary each app declares (`AppSchema`: scope dimensions, action catalog, roles) is
  the app's own; the first reconcile is also how it registers itself in IAM.
- `FakeIamClient` backs dev only. It does not enforce a persona's `permissions` — real authorization
  is the IAM-issued token this SDK verifies.
