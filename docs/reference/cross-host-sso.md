# Cross-host SSO

A browser authenticates at IAM, on IAM's own host, and ends up authenticated at an
app on a **different** domain. No cookie is shared between the two, and none has to
be: the handoff travels as a one-time code. See
[ADR-0021](../decisions/0021-exchange-token-session-handoff.md) for why.

## The round trip

| # | Where    | What happens                                                                                                                       |
| - | -------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| 1 | app host | The proxy matches a `human` gate, finds no usable credential, and 302s to `${issuer}/auth/login?app=<id>&redirect=<original URL>`. |
| 2 | IAM      | The return URL is checked against the origins registered for that app. Unregistered → **400**.                                     |
| 3 | IAM      | The human authenticates — password, OIDC, or an IAM session the browser already holds, in which case there is no prompt.           |
| 4 | IAM      | A single-use code bound to `(session, app, return URL)` is issued; 302 to `<app origin>/__fabrika/auth/callback?code=…`.           |
| 5 | app host | The proxy redeems the code, sets the returned app session as a **host-only** cookie, and 302s to the original URL.                 |
| 6 | app host | Every later request mints a short-lived per-app token from that cookie and verifies it locally, as it always has.                  |

The reserved callback path is `/__fabrika/auth/callback`. The proxy answers it
itself — Caddy returns a non-2xx auth response verbatim, so the 302 and its
`Set-Cookie` reach the browser and the code never reaches the application.

## What is stored, and for how long

- **The code**: hash only, single-use, two minutes. The plaintext exists in one
  redirect and one redemption. Consumption is a conditional `UPDATE`, so a replay
  changes no rows and loses.
- **The app session**: a `sessions` row with `app` set and `parent_session_id`
  pointing at the IAM login. It inherits the parent's absolute expiry.

## The rules that hold it together

- **A return URL is validated, never trusted.** Origins are registered per app
  through `apps.setReturnOrigins` and canonicalized on the way in. There is no
  fallback: an unregistered origin is refused rather than quietly rewritten.
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
- An app's return origins, registered in IAM.

`SESSION_COOKIE_DOMAIN` is no longer load-bearing for cross-host access. Set it only
when hosts genuinely share a parent domain, where it saves a redirect by letting the
proxy read the IAM session directly.

## Verified live

On 2026-08-04, between two `.zerops.app` hostnames in project `fabrika-test`, with no
custom domain and no shared cookie domain: sign-in on the IAM host, `200` from the app
on another host, two independent host-only session cookies, a second round trip with
no prompt, and a revoked IAM login refusing to mint for the app session it had issued.
