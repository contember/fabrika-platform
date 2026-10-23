# Session handoff

How a browser that authenticated at IAM ends up authenticated at an application.
There is **one** way, and it is the same one whether or not the two share a domain:
the session travels as a one-time code, and the proxy on the app's host redeems it
into a cookie that belongs to that host alone. No cookie is ever shared between two
hosts. See
[ADR-0023](../decisions/0023-one-session-per-host.md) for why there is only one
mechanism, [ADR-0022](../decisions/0022-the-proxy-is-the-only-enforcement-point.md)
for the enforcement model around it,
[ADR-0023](../decisions/0023-one-session-per-host.md) for the
browser-bound proof, and
[ADR-0022](../decisions/0022-the-proxy-is-the-only-enforcement-point.md) for the code's
design.

## The round trip

| # | Where    | What happens                                                                                                                                                                       |
| - | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 | app host | The proxy creates `(state, verifier)`, stores the verifier in `__Host-px_handoff_<state>`, and sends `app`, `redirect`, `state`, and the verifier's S256 `code_challenge` to IAM.  |
| 2 | IAM      | The public handoff fields are read against that app's registered return origins — two ways it can go, below.                                                                       |
| 3 | IAM      | The human authenticates — password, OIDC, or an IAM session the browser already holds, which hands off at once or first asks which account to use (below).                         |
| 4 | IAM      | A single-use code bound to `(session, app, return URL, challenge)` is issued; 302 to `<app origin>/__fabrika/auth/callback?code=…&state=…`.                                        |
| 5 | app host | The proxy selects the verifier cookie by state and privately redeems `(code, verifier)`. IAM atomically consumes the code before checking the proof.                               |
| 6 | app host | The proxy sets the returned app session as a **host-only** cookie, clears the verifier cookie, and 302s to the stored return URL.                                                  |
| 7 | app host | Every later request mints and verifies a short-lived per-app JWT. The proxy injects it as `X-Fabrika-Token`; neither the session nor a JWT cookie reaches the application request. |

Step 1 answers in the shape the caller can act on: a **302** for a document
navigation, a **401** carrying `{ error: { type, message, loginUrl } }` for anything
else. The signal is `Sec-Fetch-Mode`; both forms carry the same login URL.

The reserved callback path is `/__fabrika/auth/callback`. The proxy answers it
itself, **before it selects an endpoint** — it is how a browser obtains a session,
so it cannot be behind an endpoint. Caddy returns a non-2xx auth response verbatim, so
the 302 and its `Set-Cookie` reach the browser and the code never reaches the
application.

### Step 2 has two outcomes

| The handoff coordinates the proxy sent           | Outcome                                        |
| ------------------------------------------------ | ---------------------------------------------- |
| no `?app=` at all                                | Not a handoff — an ordinary login on IAM.      |
| registered origin plus valid state and challenge | A single-use code.                             |
| missing, unparseable, or an unregistered origin  | **400**, naming the address. Never a fallback. |

An **empty** registry falls in the last row: an app IAM has no return origin for
cannot log anyone in, and that is reported rather than worked around. A fallback
would produce a login that succeeds and lands the browser on a host where it has no
session, i.e. a loop with nothing logged anywhere.

The reading is redone at every step that could act on it — the login page, the OIDC
start, the password `POST`, the account question's `POST`, and the return from the IdP.
The form is a hint, never a permission.

### Step 3 with an IAM login the browser already holds

The browser reaches step 3 only when the app's proxy has no app session for it; the proxy renews access
tokens from the app session server-side. A login held on IAM's host, of an active user, needs no
password, and IAM answers in one of two ways:

| The held login                                                  | Outcome                                                          |
| --------------------------------------------------------------- | ---------------------------------------------------------------- |
| holds a live app session for this app (the app cookie was lost) | The code, at once.                                               |
| was issued less than 60 seconds ago                             | The code, at once.                                               |
| neither                                                         | A page: `Continue as <label>` or `Use another account`. No code. |

A completed password action, an invitation enrollment and a sign-in on IAM's own page each issue a login
and land on an app whose proxy starts a handoff moments later; that is what the 60 seconds cover.

Both answers post to `/auth/login/account`, same-origin only, and the `POST` reads the handoff fields and
the login again:

- **Continue** issues the code from the login the browser holds at that moment, or returns to the
  sign-in page of the same handoff when that login has ended.
- **Use another account** ends the login like a sign-out, and with it every app session made from it;
  the page says so. It then returns to IAM's sign-in page with the same `app`, `redirect`, `state` and
  `code_challenge`, so the new sign-in completes the same handoff while the proxy's verifier cookie lives.

The page widens `form-action` by the handoff's registered origin, like the login page (below).

### Step 3 on a terminal

A browser that holds no IAM login but an enrolled terminal's cookie leaves IAM at step 3 for the application's
identification page, with a single-use identification that holds the handoff's return URL, state and challenge. The
application asserts the person over its transport. IAM then signs them in and answers its own completion URL, which the
application sends the browser to. Only the terminal's own browser completes there: IAM issues the step 4 code to it and
302s to the callback. The proxy redeems it with the verifier from step 1, so the handoff is unchanged, and the
application never holds a code ([Human authentication](human-authentication.md#terminals)).

## The cookies

| Cookie                      | Host                | Purpose                                                    |
| --------------------------- | ------------------- | ---------------------------------------------------------- |
| `__Host-px_session`         | IAM's own host      | The login. `app IS NULL`; it is what authorizes a handoff. |
| `__Host-px_session`         | each app's own host | A child session, `app` set, `parent_session_id` set.       |
| `__Host-px_handoff_<state>` | one app's own host  | Ten-minute browser-held verifier for one login attempt.    |

Same name, different hosts, independent rows. The `__Host-` prefix makes the browser
enforce what the design already intends: it refuses any cookie of that name that
lacks `Secure`, lacks `Path=/`, or names a `Domain`. What it adds beyond host-only is
that a sibling subdomain cannot plant a **second** cookie of the same name that the
real host would then send alongside its own.

`Secure` is unconditional on every cookie IAM and the proxy write, because the prefix
requires it. That is correct behind a TLS-terminating balancer, where the socket is
plain HTTP and the browser spoke HTTPS, and on `localhost` / `*.localhost`, which
browsers treat as potentially trustworthy. An installation served over cleartext HTTP
on a public hostname cannot hold a session at all.

## What is stored, and for how long

- **The handoff attempt**: a random state and verifier on the app proxy. Only the
  S256 challenge leaves the host during login. The verifier cookie lives for ten
  minutes so an OIDC round trip can finish; the callback clears it.
- **The code**: hash only, single-use, two minutes. Its plaintext integrity-binds
  the challenge and exists in one redirect and one redemption. Consumption is a
  conditional `UPDATE`, so a replay or a second verifier attempt changes no rows
  and loses.
- **The app session**: a `sessions` row with `app` set and `parent_session_id`
  pointing at the IAM login. It inherits the parent's absolute expiry.

## The rules that hold it together

- **A return URL is validated, never trusted.** Origins are registered per app
  through `apps.setReturnOrigins` and canonicalized on the way in. An unregistered
  origin is refused rather than quietly rewritten, and the URL that travels with the
  code is rebuilt from the registered origin plus the requested path and query, never
  echoed. The app never names its own origin — see
  [Configuration](#configuration) for who does.
- **The registry is the only authority on sending a browser to another host.** IAM's
  own `?redirect=` guard (`safeRedirect`) accepts nothing but IAM's own origin, so
  there is no second, weaker answer to the same question.
- **The destination is carried server-side.** Redemption returns the URL stored with
  the code, so a caller cannot point the browser elsewhere by editing the callback.
- **The callback is bound to the browser that initiated it.** Public `state` only
  selects a dynamic host-only cookie. The cookie's verifier must match the S256
  challenge bound into the one-time code. A code copied into another browser cannot
  establish or replace that browser's app session.
- **An app session mints only for its own app.** The cookie is host-only, so a
  sibling cannot read it; the binding in `mintToken` is the second lock.
- **A child cannot father another.** Only the IAM login itself authorizes a handoff,
  so one app's session can never be turned into access to the next.
- **Revoking the IAM login revokes every app session under it.** The lookup joins to
  the parent on every use. An access token already minted stays valid for the rest of
  its TTL (300s) — that bound is unchanged, and local verification is why it exists.
- **The proxy writes the long-lived app session on exactly one path**: successful
  redemption at the reserved callback. Starting login writes only the transient
  verifier cookie.
- **A code without its verifier is spent.** A callback whose browser holds no verifier
  cookie for its state did not start that sign-in. The proxy still redeems the code, with a
  verifier made for no challenge, so IAM consumes it, and refuses the request. Whoever
  started the sign-in elsewhere cannot redeem a code read off this browser.
- **The proxy clears it on one path**: `/__fabrika/auth/signout?redirect=<path>`, answered,
  like the callback, before endpoint selection. It accepts only a same-origin `GET` with a
  path on the app's own origin, clears the app session cookie and drops its cached token, and
  302s to IAM's `/auth/terminals/release`, which ends a terminal's sessions and returns to
  that path. It does not revoke a personal login on IAM.
- **Fabrika cookies never reach the upstream application.** Both proxy runtimes strip
  every `__Host-px_*` cookie on the upstream hop while preserving application-owned
  cookies. The application reads only the proxy-injected JWT header.
- **A gateway does not revive the cookie path.** Control translates its trusted proxy
  JWT into a bearer for IAM admin calls and removes all console cookies on that private
  hop. IAM verifies the signed app audience, identifies the principal, and resolves IAM
  permissions live; it does not reuse the calling app's permission snapshot.

## Configuration

- `ProxyApp.scheme` in the proxy manifest — the scheme the **browser** speaks. No
  header can supply it: a TLS-terminating balancer forwards plain HTTP, and the next
  hop rewrites `X-Forwarded-Proto` to what it received. Absent parses as `https`.
- An app's return origins, registered in IAM — **written by the control plane, on every
  deploy.** The operator configures `publicOrigin` on the app's environment
  (`apps.environments.put` on Control's `/api/rpc`); nobody calls `apps.setReturnOrigins` by hand.

### Who writes the registry

IAM's registry is keyed by the IAM application id `<app>@<env>`
([ADR-0022](../decisions/0022-the-proxy-is-the-only-enforcement-point.md) rule 6), so the set it
stores for `notes@prod` is the `app_envs.public_origin` of `notes`'s `prod` environment, projected
on every deploy:

1. Once a run succeeds, on any provider, Control reads the deploying environment's public
   origin. Another environment's origin is never read: registered under `notes@prod`, a
   `stage` host would be handed production sessions.
2. Control writes the approved schema (`reconcileSchema`) and then makes a **second** call —
   `apps.setReturnOrigins` over `/admin/rpc`, after the schema PUT, because that PUT is what
   registers the app and `setReturnOrigins` 404s for an unknown one.

Three consequences worth knowing:

- An environment with no `publicOrigin` is **left alone**, not registered
  with a guess — and, since it then has an empty registry, nobody can sign in to it.
  Configure `publicOrigin` before expecting a login to work.
- The projection is authoritative: an origin added by hand through the admin surface is
  replaced by the next deploy. Configure `publicOrigin` instead.
- `apps.setReturnOrigins` **replaces** the set and refuses an empty array, so an app is
  never un-registered by a body that only looks empty.

The local composition has no deploy of its own for the console, so
`@fabrika/local-stack` makes the same `reconcileSchema` call after `local:up` brings the
services up — same endpoints, same admin credential, no local-only path in IAM or the
proxy.

## Two browser rules the login FORM depends on

Both were found live, on a real browser against a real installation, and neither is reachable from a
unit test that constructs its own `Request`: the header a browser sends is not the header a test
writes, and a CSP is not enforced at all unless a browser is doing the enforcing.

**A browser sends `Origin: null` here, and that is not an attack.** Every page IAM renders carries
`Referrer-Policy: no-referrer`, and Fetch's _append a request `Origin` header_ step serializes the
origin as `null` under that policy — so a **same-origin** form POST arrives with `Origin: null` and no
`Referer` at all. Comparing that against the issuer refuses every form on the service: login, password
enrollment, password reset, forgot-password and the logout confirmation. `Sec-Fetch-Site` is the only
same-origin proof left, and it is the one a page cannot write — `Sec-` is a forbidden header prefix, so
the browser is its sole author and a cross-site post is already refused before this is reached.

**`form-action` applies to the REDIRECT a submission answers with, not only to its action.**
`form-action 'self'` therefore blocks the 302 to `<app>/__fabrika/auth/callback`: the POST is accepted,
a session is created, a code is issued and immediately wasted, and the browser silently stays on the
login page with no error anywhere. The login page widens the directive by exactly one origin — the
app's REGISTERED return origin, taken from the same value the 302 will use — so a page rendered for no
handoff stays at `'self'` and the registry remains the only authority on where a browser may be sent.
The set-password and invitation pages widen it the same way, by the registered origin a completed action
or an accepted invitation of their application lands on.

## Where redemption lives, and how much that protects

Redemption is `exchangeAuthCode`, and it is deliberately **not** part of `IamRpc` — the
management contract every SDK consumer holds. How much separation that buys depends on
the provider:

- **Zerops.** IAM serves two HTTP surfaces behind two different secrets: `/rpc/*` for
  management, guarded by `FABRIKA_IAM_RPC_KEY`, and `/auth/mint/*` for the proxy, guarded by
  `FABRIKA_IAM_PROXY_KEY` (the value the proxy holds as `FABRIKA_IAM_KEY`). The proxy
  calls `POST /auth/mint/exchange` with the code and verifier in its body. A holder of the RPC key cannot redeem, and an unset
  key makes its surface 404 as if never mounted. The split is a real boundary. An application's own membership
  transport key reaches only `/membership/*`, which redeems nothing.
- **Cloudflare.** IAM is one `WorkerEntrypoint` implementing both contracts, so
  `exchangeAuthCode` is an ordinary method on it and every holder of the `IAM` service
  binding reaches it. No key is involved. The separation survives only as a type: an SDK
  consumer declares its binding as `IamRpc` and never sees the method.

The asymmetry is accepted, not a gap to work around — see
[ADR-0022](../decisions/0022-the-proxy-is-the-only-enforcement-point.md). Exploiting it
needs a first-party Worker holding the binding **and** a live code plus the browser-held
verifier inside its two-minute window. The code is single-use, hash-only, app-bound,
destination-bound, and challenge-bound.

## Verified live

On 2026-08-04, between two `.zerops.app` hostnames in project `fabrika-test`, with no
custom domain and no shared cookie domain: sign-in on the IAM host, `200` from the app
on another host, two independent host-only session cookies, a second round trip with
no prompt, and a revoked IAM login refusing to mint for the app session it had issued.

On 2026-08-05, in Chromium 151.0.7922.34 over plain HTTP on
`http://control.fabrika.localhost`: a `__Host-`-prefixed `Secure` cookie is accepted
and returned, a `__Host-` cookie carrying `Domain` and one without `Secure` are both
dropped, and a sibling host setting `Domain=fabrika.localhost` can plant a duplicate
of an unprefixed name but not of a `__Host-` one.

On 2026-08-05, in HeadlessChrome 149 against the live Zerops installation
(`fabrika-test`, two `.zerops.app` hosts behind the project's TLS-terminating L7
balancer): an anonymous browser at the console was bounced by the **proxy** to
`…/auth/login?app=vozka&redirect=…`, typed a password, and landed back on the console
holding a `__Host-px_session` that is `Secure`, `HttpOnly`, `Path=/`, host-only and
distinct from the one on IAM's host — then read the Delivery, Access and Operations
plane views, the Access one through control's `/iam/admin/*` gateway. The same run
produced the two rules above: with `Referrer-Policy: no-referrer` a same-origin form
POST carries `Origin: null` and no `Referer`, and under `form-action 'self'` the
cross-origin 302 that completes the handoff is blocked with a `securitypolicyviolation`
naming `form-action` and the ORIGINAL action URL (Chromium reports the action, not the
redirect target). Both were reproduced against a local two-origin probe before being
fixed.
