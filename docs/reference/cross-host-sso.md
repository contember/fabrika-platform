# Cross-host SSO

A browser authenticates at IAM, on IAM's own host, and ends up authenticated at an
app on a **different** domain. No cookie is shared between the two, and none has to
be: the handoff travels as a one-time code. See
[ADR-0022](../decisions/0022-the-proxy-is-the-only-enforcement-point.md) for the
settled model and [ADR-0021](../decisions/0021-exchange-token-session-handoff.md)
for why the shared cookie could not stay.

## The round trip

| # | Where    | What happens                                                                                                                                    |
| - | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 | app host | The proxy matches a `human` gate, finds no usable credential, and sends the browser to `${issuer}/auth/login?app=<id>&redirect=<original URL>`. |
| 2 | IAM      | `?app=` + `?redirect=` are read as a handoff against that app's registered return origins — three ways it can go, below.                        |
| 3 | IAM      | The human authenticates — password, OIDC, or an IAM session the browser already holds, in which case there is no prompt.                        |
| 4 | IAM      | A single-use code bound to `(session, app, return URL)` is issued; 302 to `<app origin>/__fabrika/auth/callback?code=…`.                        |
| 5 | app host | The proxy redeems the code, sets the returned app session as a **host-only** cookie, and 302s to the stored return URL.                         |
| 6 | app host | Every later request mints a short-lived per-app token from that cookie and verifies it locally, as it always has.                               |

Step 1 answers in the shape the caller can act on: a **302** for a document
navigation, a **401** carrying `{ error: { type, message, loginUrl } }` for anything
else. The signal is `Sec-Fetch-Mode`; both forms carry the same login URL.

The reserved callback path is `/__fabrika/auth/callback`. The proxy answers it
itself, **before gate matching** — it is how a browser becomes able to satisfy a
gate, so it cannot be behind one. Caddy returns a non-2xx auth response verbatim, so
the 302 and its `Set-Cookie` reach the browser and the code never reaches the
application.

### Step 2 has three outcomes, not two

The registry is what an app **opted in** to, so an app that has none is not a
misconfiguration:

| The app's registry           | The `redirect` the proxy sent                     | Outcome                                                   |
| ---------------------------- | ------------------------------------------------- | --------------------------------------------------------- |
| empty (or no `?app=` at all) | reachable by the session cookie domain, or absent | **Not a handoff.** The ordinary shared-cookie login runs. |
| empty                        | outside the session cookie domain                 | **400**, naming the origin nobody registered.             |
| holds origins                | its origin is registered                          | A single-use code.                                        |
| holds origins                | missing, unparseable, or an unregistered origin   | **400**. Never a quiet fallback to the issuer.            |

The middle case is the one that matters. The proxy sends `app=` on every bounce, so
without the empty-registry opt-out an installation that never adopted the handoff
would break the moment it upgraded — but the opt-out only holds while the shared
cookie can actually reach the destination. When it provably cannot, falling back
would strand the browser in a login loop with nothing logged anywhere, so that
combination is refused instead.

The reading is redone at every step that could act on it — the login page, the OIDC
start, the password `POST`, and the return from the IdP. The form is a hint, never a
permission.

## What is stored, and for how long

- **The code**: hash only, single-use, two minutes. The plaintext exists in one
  redirect and one redemption. Consumption is a conditional `UPDATE`, so a replay
  changes no rows and loses.
- **The app session**: a `sessions` row with `app` set and `parent_session_id`
  pointing at the IAM login. It inherits the parent's absolute expiry.

## The rules that hold it together

- **A return URL is validated, never trusted.** Origins are registered per app
  through `apps.setReturnOrigins` and canonicalized on the way in. An app that has a
  registry gets no fallback: an unregistered origin is refused rather than quietly
  rewritten, and the URL that travels with the code is rebuilt from the registered
  origin plus the requested path and query, never echoed. The app never names its own
  origin — see [Configuration](#configuration) for who does.
- **The destination is carried server-side.** Redemption returns the URL stored with
  the code, so a caller cannot point the browser elsewhere by editing the callback.
- **An app session mints only for its own app.** The cookie is host-only, so a
  sibling cannot read it; the binding in `mintToken` is the second lock.
- **A child cannot father another.** Only the IAM login itself authorizes a handoff,
  so one app's session can never be turned into access to the next.
- **Revoking the IAM login revokes every app session under it.** The lookup joins to
  the parent on every use. An access token already minted stays valid for the rest of
  its TTL (300s) — that bound is unchanged, and local verification is why it exists.

## Configuration

- `ProxyApp.scheme` in the proxy manifest — the scheme the **browser** speaks. No
  header can supply it: a TLS-terminating balancer forwards plain HTTP, and the next
  hop rewrites `X-Forwarded-Proto` to what it received. Absent parses as `https`.
- An app's return origins, registered in IAM — **written by the control plane, on every
  deploy.** The operator configures `publicOrigin` on the app's environment
  (`PUT /api/apps/:app/envs/:env`); nobody calls `apps.setReturnOrigins` by hand.

### Who writes the registry

The set IAM stores for an app is the set of `app_envs.public_origin` values the control
plane holds for that app id, projected on every deploy:

1. `executeDeploy` collects every environment's public origin for the app (app-wide,
   because IAM's registry is keyed by app id — a `stage` deploy must not un-register
   `prod`) and puts it on the provider deploy input.
2. It reaches the deploy step that already talks to IAM (`reconcileSchema`), which makes
   a **second** call — `apps.setReturnOrigins` over `/admin/rpc`, after the schema PUT,
   because that PUT is what registers the app and `setReturnOrigins` 404s for an unknown
   one.

Three consequences worth knowing:

- An app with no `publicOrigin` on any environment is **left alone**, not registered with
  a guess. It stays on the empty-registry path in the table above: the shared cookie if
  that can reach it, a 400 otherwise.
- The projection is authoritative: an origin added by hand through the admin surface is
  replaced by the next deploy. Configure `publicOrigin` instead.
- `apps.setReturnOrigins` **replaces** the set and refuses an empty array — clearing a
  registry is its own operation, `apps.clearReturnOrigins`, so an app is never
  un-registered by a body that only looks empty.

`SESSION_COOKIE_DOMAIN` is no longer load-bearing for cross-host access. Set it only
when hosts genuinely share a parent domain, where it saves a redirect by letting the
proxy read the IAM session directly.

## Where redemption lives, and how much that protects

Redemption is `exchangeAuthCode`, and it is deliberately **not** part of `IamRpc` — the
management contract every SDK consumer holds. How much separation that buys depends on
the provider:

- **Zerops.** IAM serves two HTTP surfaces behind two different secrets: `/rpc/*` for
  management, gated by `FABRIKA_IAM_RPC_KEY`, and `/auth/mint/*` for the proxy, gated by
  `FABRIKA_IAM_PROXY_KEY` (the value the proxy holds as `FABRIKA_IAM_KEY`). The proxy
  calls `POST /auth/mint/exchange`. A holder of the RPC key cannot redeem, and an unset
  key makes its surface 404 as if never mounted. The split is a real boundary.
- **Cloudflare.** IAM is one `WorkerEntrypoint` implementing both contracts, so
  `exchangeAuthCode` is an ordinary method on it and every holder of the `IAM` service
  binding reaches it. No key is involved. The separation survives only as a type: an SDK
  consumer declares its binding as `IamRpc` and never sees the method.

The asymmetry is accepted, not a gap to work around — see
[ADR-0022](../decisions/0022-the-proxy-is-the-only-enforcement-point.md). Exploiting it
needs a first-party Worker holding the binding **and** a live code inside its two-minute
window; what stops a replay is the code being single-use, hash-only and bound to
`(session, app, return URL)`.

## Verified live

On 2026-08-04, between two `.zerops.app` hostnames in project `fabrika-test`, with no
custom domain and no shared cookie domain: sign-in on the IAM host, `200` from the app
on another host, two independent host-only session cookies, a second round trip with
no prompt, and a revoked IAM login refusing to mint for the app session it had issued.
