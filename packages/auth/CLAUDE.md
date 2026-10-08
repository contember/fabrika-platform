# @fabrika/auth

The app-facing IAM SDK — what an application uses instead of hand-rolling auth. It depends only on
`@fabrika/auth-core`: the binding is typed as `IamBinding`, the `getJwks`/`listPrincipals`/`audit` part
of the `IamRpc` CONTRACT, so the SDK never imports the IAM service. That is what a Cloudflare
application's binding to IAM's `PropustkaApplication` entrypoint serves; widen it only together with
that entrypoint. Assumes the root CLAUDE.md.

**This package does not enforce anything.** [ADR-0022](../../docs/decisions/0022-the-proxy-is-the-only-enforcement-point.md)
makes `@fabrika/proxy` the only enforcement point, and the duplicate in-process path is gone. There is
no gate evaluation here, no session→token exchange, no login bounce, and no cookie is ever written.
`can()` and the contract framework's requirement check in `@fabrika/app` are **authorization** in the
vocabulary of `docs/reference/overview.md`, not a second gate evaluator.

`createIam(env, opts)` is the single request-time entry point. It returns an `Iam` carrying:

| Member                  | Semantics                                                                                                  |
| ----------------------- | ---------------------------------------------------------------------------------------------------------- |
| `authenticate(request)` | Read the proxy-injected `PROXY_TOKEN_HEADER`, verify it LOCALLY against the JWKS, return an `AuthContext`. |
| `listPrincipals`        | The app's people directory, delegated to `IamClient`.                                                      |

Around it: `anonymousContext()` (what an app sets on a `public`-gated request), `applyScope`,
`requirePermission`, `UnauthenticatedError` / `ForbiddenError`, `TokenVerifier`, `HttpIamRpc`, and the
deploy-time `reconcileSchema`.

**There is ONE code path and no local mode.** `createIam` requires the binding and the issuer
everywhere, including locally; there is no `DEV` flag, no `FakeIamClient` and no synthetic persona.
Local development runs the real stack (`bun run local:up`), where the proxy fronts each service and
IAM authenticates through its own `LOCAL_DEV_LOGIN` bypass — the system's only dev bypass, owned by
the service that owns identity.

## Invariants

- **The proxy-injected token is NEVER trusted blindly.** `TokenVerifier` (`src/verify.ts`) checks the
  signature, `iss`, `aud` and `exp` against IAM's published JWKS on every request. A token for another
  app, from another issuer, or past its expiry is refused here even though the proxy already admitted it.
- **`verify` / `authenticate` are THREE-STATE.** A decided negative (`invalid_token`,
  `unknown_principal`) is not the same as "IAM could not be consulted" (`unavailable` → 503). Both
  deny; only the second is an incident. Never collapse the two, and never map a transport failure onto
  a `reason` that claims we checked. Neither method throws for either case.
- **The JWKS cache is keyed by the BINDING OBJECT, in a module-level WeakMap** — not by the `Iam`
  instance. `@fabrika/app` calls its `middleware(env)` factory on every request, so an SDK object built
  there is per-request while the binding lives for the isolate/process. The unknown-`kid` refetch
  cooldown lives in that same per-binding slot — a per-request verifier would otherwise reset it, and
  the bound would do nothing. An unknown `kid` forces at most ONE refetch per cooldown; a fetch failure
  never falls back to the stale key set.
- **THE SDK ISSUES AND REDEEMS NOTHING.** An app reaches a credential only as the token the proxy
  injected. A share link is a `px_` key the proxy resolves at a `service` gate, so it arrives as an
  anonymous token like any other (ADR-0022). `HttpIamRpc` still carries `issueKey` / `revokeKey`
  because they are `IamRpc` members other callers use, not SDK surface.
- **`audit` forwards the verified token, not an app id.** `AuthContext.audit` sends the token it was
  built from as `credential`; IAM files the event under that token's app.
- **The SDK REQUESTS; IAM decides and writes.** The target (A12, A13; not built yet): the SDK asks
  IAM to create a scope, to assign, revoke or list members, and to issue or revoke a share link, on
  the caller's behalf with the caller's token as proof. IAM evaluates each request against the
  caller's live permissions, generates the scope value and issues the key. The SDK mints nothing,
  signs nothing, supplies no actor and writes no grant.
- **THERE IS NO SECOND AUTHENTICATION MODEL HERE, and adding one back is the bug.** The SDK used to
  select a `FakeIamClient` plus synthetic personas from a `DEV` env var, resolved by `?__as=` / a
  cookie / a header, with a default persona holding a global-admin grant — so one misread flag handed
  every unauthenticated request full access (SEC-4). It existed only because local development did not
  run the real stack. It does now. A local bypass belongs in IAM, where it is a real session row for a
  real principal and is refused at use the moment the flag is off.
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
- **`returnOrigins` is a SECOND call, and the two concepts never merge.** An `AppSchema` is
  vocabulary the APPLICATION declares; a return origin is a fact the CONTROL PLANE knows. Folding
  origins into the schema body would let an app assert where it can be handed a session (ADR-0022),
  which is exactly what the registry exists to prevent — so they travel as two requests to two
  endpoints, and `returnOrigins` is never read off the schema. Order is load-bearing: the schema PUT
  runs first because it is what REGISTERS the app, and `apps.setReturnOrigins` 404s for an app IAM
  has never heard of. Omitting `returnOrigins` leaves IAM's registry untouched; an EMPTY array is a
  caller error, refused before any request, because clearing the registry is its own admin operation.
- **`Middleware<Ctx>` / `AuthCarrier` are owned here and consumed by `@fabrika/app`** — do not add a
  duplicate compatibility interface there. The SDK itself ships no middleware. Today each service
  writes the ~10 lines that call `authenticate`; with the contract (ADR-0012) an application writes
  none: the framework's `boot` verifies the token with the same `@fabrika/jwks` verifier, because the
  requirement check needs the token's permission list, which `AuthContext` does not expose.
- **Never log credentials, secret values, or request headers.**

## Notes

- `AppGates` & co. are still re-exported: gates go to the PROXY manifest (`fabrika.config.ts`).
  Nothing in this package reads them. The target (A-M1): an application's gates are generated from
  its contract; hand-written gates remain for the installation's own services.
- The authz vocabulary each app declares (`AppSchema`: scope dimensions, action catalog, roles) is the
  app's own; the first reconcile is also how it registers itself in IAM. The target (A-M1): an
  application's `AppSchema` is generated from its contract.
- `appSchemaSchema` (`src/app-schema.ts`) is the ONE parser for that vocabulary — both providers and IAM use it.
- `src/verify.ts` no longer verifies anything itself: `@fabrika/jwks` owns the one implementation and
  `@fabrika/proxy-core` wraps the same class. The proxy must not depend on the app SDK and
  `@fabrika/auth-core` is deliberately jose-free, which is why the shared code has its own package.
  What stays here is the SDK's construction shape — a fixed audience and the per-binding cache.
