> ## OUTCOME — shipped 2026-08-04
>
> **A human signs in at IAM and lands authenticated on an app that shares no cookie
> domain with it.** Proven live between two `.zerops.app` hostnames in `fabrika-test`,
> with no custom domain and no `SESSION_COOKIE_DOMAIN` set anywhere: `302` from the
> app → password form → `302` to the app's own callback with a code → `302` back →
> `{"notes":[]}` and a `200`. Two independent host-only session cookies, one per host.
>
> **Commits.** `111540d` schema + exchange (WU1, WU2) · `a260770` issue + redeem
> (WU3, WU4) · `6d4c38f` proxy callback and cookie (WU5) · `e1152bb` CSRF origin
> guard (WU7) · `f652a27` origin registration (WU6) · `b3e2299` the live defect.
>
> **Verification.** 1692 tests, 0 failures, run against a real Postgres. Typecheck,
> biome and dprint clean. Live: every claim above was produced by a request to the
> running installation, including a second round trip with no prompt and a revoked
> IAM login refusing to mint for the app session it had issued.
>
> **Backlog closed.** 48 (the proxy's public scheme — settled as a manifest field)
> and 50 (console writes 403 behind a terminating balancer, both halves fixed and
> confirmed live). Item 05 no longer waits on custom domains for browser SSO.
>
> **Deferred, honestly.** WU6 landed half: IAM owns the registry and its admin
> surface, but the control plane does not yet project an app's public origin into it,
> so registration is one manual call → [`51`](../backlog/51-project-return-origins-from-the-control-plane.md).
> Back-channel logout stays out of scope; revocation is instant at IAM and bounded by
> one 300s token lifetime at the edge, measured.

# Sprint — exchange-token SSO (2026-08-04)

**Goal.** A human signs in at IAM and lands authenticated on an app that shares no
cookie domain with it — proven live on `.zerops.app` subdomains, with no custom
domain.

**Theme.** [ADR-0021](../decisions/0021-exchange-token-session-handoff.md) replaces
the shared-cookie handoff with a one-time code redeemed by the proxy. Two already
decided fixes ride along because they are in the same code and the same request
path: backlog **50** (console writes 403 behind a terminating balancer) and backlog
**48** (the proxy's public scheme), which ADR-0021 settles as a manifest field. Both
files are deleted by this sprint.

## Refs re-verified at HEAD (2026-08-04)

- ✔ The proxy sets **no** cookie — no `Set-Cookie` anywhere in `packages/proxy/src/service.ts`.
- ✔ `px_token` is already a per-app JWT in a host-only cookie and is already verified
  locally with no IAM call — `packages/proxy/src/authorize.ts:205-211`.
- ✔ Caddy returns a non-2xx auth response to the client **verbatim**, so the proxy can
  answer 302 + `Set-Cookie` from `/verify` with no new Caddy route —
  `packages/proxy/src/service.ts:5-17`.
- ✔ The Cloudflare proxy narrows its gateway by duck-typing, not by `IamRpc` —
  `packages/provider-cloudflare/src/proxy-worker.ts:118`. Adding a gateway method
  therefore does not touch `IamRpc` or its SDK implementors.
- ✔ `sessions.id` is a UUIDv7 primary key, so a code row can reference it —
  `packages/iam/migrations-postgres/0001_init.sql:216`.
- ⚠ `safeRedirect` and the session cookie are driven by the **same**
  `SESSION_COOKIE_DOMAIN`, so the cross-host round trip fails on two independent
  gates, not one — `packages/iam/src/auth/routes.ts:584`.
- ⚠ `*.zerops.app` is on the Public Suffix List (submitted by Zerops), so a cookie
  scoped to `prg1.zerops.app` is refused by the browser outright.

## Work units

### WU1 — Shared wire types (S)

- **Scope.** `ExchangeAuthCodeInput` / `ExchangeAuthCodeResult` in `@fabrika/auth-core`,
  next to the mint types. The reserved callback path and code TTL as named constants.
  `IamRpc` is NOT extended (ADR-0021).
- **Acceptance.** `bun run typecheck` clean; no SDK implementor changes.

### WU2 — IAM persistence (M)

- **Scope.** `auth_codes` and `app_return_origins` in both `migrations/` (SQLite) and
  `migrations-postgres/`, plus their repositories in `src/db.ts`. Single-use is
  enforced by the same partial-unique pattern the password action tokens use.
  `sessions` gains `app` and `parent_session_id` for the child sessions redemption
  creates (ADR-0021); revoking a parent must revoke its children.
- **Acceptance.** `postgres-schema.test.ts` passes against a real Postgres; a code
  redeemed twice fails the second time; revoking a parent kills its children.

### WU3 — IAM issue path (M)

- **Scope.** `/auth/login` accepts `app` + `redirect`; the origin is validated against
  the registry; the value travels through the password form and the OIDC flight; an
  existing IAM session short-circuits to a code with no prompt.
- **Acceptance.** Unit tests for each entry (fresh password login, existing session,
  OIDC callback) and for an unregistered origin → 400.

### WU4 — IAM redemption (S)

- **Scope.** `exchangeAuthCode` on both entrypoints and `POST /auth/mint/exchange`
  gated by the proxy key. Redemption creates the app-bound child session and returns
  its opaque value plus the return URL; `mintToken` refuses a child session whose
  app does not match.
- **Acceptance.** Wrong app, expired, and replayed codes each fail closed; a child
  session mints for its own app and is refused for any other.

### WU5 — Proxy redemption and cookie (M)

- **Scope.** `ProxyApp.scheme`; the reserved callback handled before gate matching;
  the child session set as a host-only cookie on the app's host; bounce carries `app`.
  Everything after the callback is the existing mint-from-cookie path, unchanged.
- **Acceptance.** `deny-matrix.test.ts` still exhaustive; a callback with a bad code
  denies and sets no cookie; the cookie is written on no other path.

### WU6 — Registration and generation (M)

- **Scope.** Control registers an app's return origins with IAM and emits `scheme` in
  the manifest it generates.
- **Acceptance.** A generated manifest round-trips through the strict parser.

### WU7 — CSRF origin guard, backlog 50 (S)

- **Scope.** Compare against the configured public origin; exempt bearer-only
  requests; settle the `FABRIKA_CONTROL_DOMAIN` shape; correct the stale comment.
- **Acceptance.** Both guards unit-tested for the `https`-browser/`http`-process case
  and for a genuinely cross-site origin; a bearer-only POST succeeds with no headers.

### WU8 — Live on Zerops (M)

- **Scope.** Deploy IAM, proxy and control to `fabrika-test`; register the origins;
  sign in on the IAM host and land authenticated on the app host.
- **Acceptance / witness.** One browser-shaped round trip across two `.zerops.app`
  hostnames ending in a 200 from the app, with `px_token` set on the app's host and
  no `SESSION_COOKIE_DOMAIN` configured anywhere.

## Out of scope

- Back-channel logout / immediate revocation across apps. The TTL bound is unchanged
  by this sprint and is recorded in ADR-0021's consequences.
- Retiring the in-process SDK path ([`18`](../backlog/18-shrink-the-app-sdk.md)).
- Custom domains, the production two-project topology, the git-sourced deploy —
  [`05`](../backlog/05-bring-up-on-a-real-zerops-account.md) keeps them.

## Run log

- **The redemption had to yield a session, not an access token.** Caught while
  writing WU4, before any code: a per-app token lives 300s, so a browser holding only
  one would be redirected on every expiry — and a redirect turns an in-flight `POST`
  into a bodyless `GET`. ADR-0021 was revised before implementation; what lands on the
  app's host is a credential the proxy can re-mint from.
- **`redeem` bypassed `callIam`.** Its own try/catch made an unreachable IAM a 403
  instead of a 503 whenever the injected gateway threw anything but
  `IamUnavailableError` — the exact manners-independence the class header promises.
  Caught by the test written for it.
- **The login form carried `safeRedirect`'s fallback.** Found on the live
  installation at step 3 of the round trip: steps 1 and 2 looked perfect and the
  rendered form did too, but the destination it carried was IAM's own origin, so the
  POST failed re-validation with a 400. `safeRedirect`'s allowlist is the
  session-cookie domain, which by construction excludes the case the handoff exists
  for. The test asserted the `app` field travelled and never looked at the field next
  to it. → `b3e2299`, plus the assertion.
- **WU6 landed half.** IAM's registry and its admin surface are done; the control
  plane still does not project an app's public origin into it, so registration is a
  manual call. → [`51`](../backlog/51-project-return-origins-from-the-control-plane.md).
- Live revocation looked broken and was not. After logging out of IAM the app still
  answered 200, because the proxy caches a minted token for its 300s TTL. Asking IAM
  directly with the child session returned `invalid_session` immediately; polling the
  app then flipped it to a 302 inside the next window. Instant at IAM, bounded by one
  token lifetime at the edge — exactly what ADR-0021 records, and worth measuring
  rather than assuming, because the first look said "broken".
