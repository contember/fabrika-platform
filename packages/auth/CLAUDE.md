# @fabrika/auth

The app-facing IAM SDK — what an application uses instead of hand-rolling auth. It depends only on
`@fabrika/auth-core`: the binding is typed as the `IamRpc` CONTRACT, so the SDK never imports the IAM
service. Assumes the root CLAUDE.md.

**This package does not enforce anything.** [ADR-0007](../../docs/decisions/0007-proxy-based-auth-enforcement.md)
made `@fabrika/proxy` the only enforcement point, and the duplicate in-process path is gone. There is
no gate evaluation here, no session→token exchange, no login bounce, and no cookie is ever written.

`createIam(env, opts)` is the single request-time entry point. It returns an `Iam` carrying:

| Member                                                   | Semantics                                                                                                   |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `authenticate(request)`                                  | Read the proxy-injected `PROXY_TOKEN_HEADER`, verify it LOCALLY against the JWKS, return an `AuthContext`.  |
| `redeemKey(token)`                                       | Redeem a share-link capability OFF the gate path (`px_` → one `mintFromKey`, cached; a JWT → local verify). |
| `listPrincipals` / `issueKey` / `issueJwt` / `revokeKey` | The management surface, delegated to `IamClient` (off-local) or `FakeIamClient` (dev).                      |
| `devLoginHandler()`                                      | The local persona-switch handler: `?as=<email>` → persona cookie → 302 `/`.                                 |

Around it: `anonymousContext()` (what an app sets on a `public`-gated request), `makeDevContext`,
`applyScope`, `requirePermission`, `UnauthenticatedError` / `ForbiddenError`, `TokenVerifier`,
`HttpIamRpc`, and the deploy-time `reconcileSchema`.

## Invariants

- **The proxy-injected token is NEVER trusted blindly.** `TokenVerifier` (`src/verify.ts`) checks the
  signature, `iss`, `aud` and `exp` against IAM's published JWKS on every request. A token for another
  app, from another issuer, or past its expiry is refused here even though the proxy already admitted it.
- **`verify` / `authenticate` / `redeemKey` are THREE-STATE.** A decided negative (`invalid_token`,
  `unknown_principal`) is not the same as "IAM could not be consulted" (`unavailable` → 503). Both
  deny; only the second is an incident. Never collapse the two, and never map a transport failure onto
  a `reason` that claims we checked. Neither method throws for either case.
- **The JWKS cache is keyed by the BINDING OBJECT, in a module-level WeakMap** — not by the `Iam`
  instance. `@fabrika/app` calls its `middleware(env)` factory on every request, so an SDK object built
  there is per-request while the binding lives for the isolate/process. An unknown `kid` triggers ONE
  refetch; a fetch failure never falls back to the stale verifier.
- **`redeemKey` is the ONE credential path that survives.** Share links are redeemed off the gate path:
  those requests hit a `public`/`service` gate and the app redeems the capability itself. There is no
  proxy equivalent by design. Its per-binding token cache is keyed by a SHA-256 digest (never the
  plaintext credential) and hard-bounded.
- **`DEV` is parsed strictly and gated on `ENVIRONMENT`.** Only `true` / `'true'` / `'1'` select
  `FakeIamClient` + synthetic personas, and only when `ENVIRONMENT === 'local'`; `'false'` / `'0'` /
  `''` / absent are the real path; anything else throws. Consumers give their default dev persona a
  global-admin grant, so a misread flag used to hand every unauthenticated request full access.
- **The issuer is canonicalized ONCE, in `createIam`** — `new URL(...).origin`, http(s) only, throwing
  on anything else. It is the token's `iss` and jose compares it byte-for-byte, so
  `https://iam.test/` and `https://iam.test` must not become two different issuers.
- **A DECIDED NEGATIVE IS A 200 on the wire.** Over the HTTP transport (`HttpIamRpc`),
  `{ ok: false, reason }` means "IAM answered: no"; a non-200 means "IAM could not be consulted". Only
  the second throws (`IamTransportError`).
- **`HttpIamRpc` is a transport, not a second IAM.** It holds no policy. `@fabrika/iam`'s
  `src/rpc-http.ts` is the wire contract; everything downstream of `IamRpc` is byte-for-byte the same
  code on both transports.
- **`reconcileSchema` (`src/provision.ts`) is a DEPLOY-time helper, never a runtime one.** It talks
  HTTP to the admin origin with an IAM-issued `px_` ADMIN key. It is idempotent: the endpoint upserts
  `origin='app'` rows and deletes app-origin rows absent from the body, and never touches
  `origin='custom'` policies.
- **`Middleware<Ctx>` / `AuthCarrier` are owned here and consumed by `@fabrika/app`** — do not add a
  duplicate compatibility interface there. The SDK itself ships no middleware; each app writes the ~10
  lines that call `authenticate` and shape its own error envelope.
- **Never log credentials, secret values, or request headers.**

## Notes

- `AppGates` & co. are still re-exported: apps DECLARE gates for the PROXY manifest
  (`fabrika.config.ts`). Nothing in this package reads them.
- The authz vocabulary each app declares (`AppSchema`: scope dimensions, action catalog, roles) is the
  app's own; the first reconcile is also how it registers itself in IAM.
- `FakeIamClient` backs dev only. It does not enforce a persona's `permissions` — real authorization is
  the IAM-issued token this SDK verifies.
- `src/verify.ts` is a deliberate near-twin of `@fabrika/proxy`'s `src/verifier.ts`. They cache
  differently (per binding vs per process) and the proxy must not depend on the app SDK, so the two
  stay separate; keep their three-state semantics identical.
