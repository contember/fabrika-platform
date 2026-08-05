---
id: 0021
title: Hand a session to an app through a one-time code, not a shared cookie
status: superseded by 0022
date: 2026-08-04
superseded-by: 0022
---

> **Superseded by [ADR-0022](0022-the-proxy-is-the-only-enforcement-point.md)**, which states the
> settled enforcement model end to end and carries this ADR's invariants forward. This one is kept
> for its reasoning — the Public Suffix List constraint that killed the shared cookie, why
> redemption yields a session rather than a token, and the alternatives it rejected. Two statements
> here are superseded rather than merely restated: an unregistered return origin is a 400 only when
> the app **has** a registry (0022, rule 4), and the least-privilege split that keeps redemption off
> `IamRpc` holds on Zerops but is a typing convention on Cloudflare (0022, Consequences).

# 0021 — Hand a session to an app through a one-time code, not a shared cookie

## Context

Until now the browser reached an app behind the proxy like this: IAM authenticated
the human and set `px_session` on **IAM's own host**; the browser then had to send
that same cookie to the **app's** host, where the proxy exchanged it for a per-app
token (`packages/proxy/src/authorize.ts`, `authorizeSession`). One cookie, read by
two different hosts.

That only works when both hosts share a parent domain the cookie can be scoped to,
which is what `SESSION_COOKIE_DOMAIN` configures. **The design was never decided** —
no ADR mentions a cookie; it is an assumption inherited from when propustka served
one domain.

Its cost came due on the first real deployment. `*.zerops.app` is on the Public
Suffix List, submitted by Zerops themselves, so `prg1.zerops.app` is a public
suffix and a browser **refuses** a cookie scoped there. Verified 2026-08-04: on the
live `fabrika-test` installation the human can sign in at IAM and nothing else can
consume the result. `safeRedirect` (`packages/iam/src/auth/routes.ts`) is driven by
the same variable, so IAM also refuses to send the browser back to a sibling host —
the round trip fails twice over, on two independent gates.

The constraint generalises past Zerops. A platform that hosts applications on
**their own** domains cannot require every one of them to sit under a domain the
platform owns. The shared cookie is not a deployment inconvenience; it contradicts
what the product is.

The pieces of the alternative already exist:

- `px_token` is already a per-app JWT in a **host-only** cookie, and the proxy
  already verifies it locally against the JWKS with no IAM call
  (`authorize.ts`, `authorizeSession` tier 1);
- IAM already performs exactly this handshake one layer up, as an OIDC relying
  party: `/auth/oidc/start` with `state` + PKCE, a short-lived flight cookie scoped
  to `/auth`, and `/auth/callback` that redeems the code for its own session.

What is missing is only how `px_token` arrives the first time.

## Decision

**We will hand the session to an app through a one-time authorization code
redeemed by the proxy, and stop requiring a cookie to be readable by two hosts.**

1. On a `human` gate miss the proxy bounces the browser to
   `${issuer}/auth/login?app=<id>&redirect=<original URL>`.
2. IAM validates `redirect` against the **return origins registered for that app**,
   authenticates the human (password, OIDC, or an existing IAM-host session), then
   issues a single-use code bound to `(session, app, return URL)` and redirects to
   the app's own host at a reserved callback path.
3. The proxy redeems the code with IAM over its existing least-privilege mint
   surface. Redemption creates a **child session bound to that app** and returns
   its opaque value; the proxy sets it as a host-only cookie on the app's own host
   and redirects to the original URL.
4. Every later request follows the path that already exists: mint a short-lived
   per-app token from that cookie, then verify it locally until it expires.

**The redemption yields a session, not just a token, and that is deliberate.** A
per-app access token lives `DEFAULT_TOKEN_TTL_SECONDS` (300s). If the browser held
only that, every expiry would become a redirect — and a redirect turns an
in-flight `POST` into a `GET` with no body. Today expiry is invisible because the
proxy re-mints server-side from `px_session`; the handoff must preserve that
property, so what lands on the app's host is a credential the proxy can re-mint
from, exactly like `px_session` but scoped to one app and one host.

Because it is a session row, the child carries its parent's id, and revoking the
parent revokes every app session derived from it — which is strictly better than
what the shared cookie gave us.

**Invariant: a child session mints only for the app it is bound to.** The cookie is
host-only, so another app cannot read it; the binding is the second lock, so a
replayed value cannot buy a token for anything else.

**Invariant: IAM never issues a code for a return URL it has not been told to
trust.** The registry is per app, and an unregistered origin is a 400 — never a
silent fallback to the issuer, which would turn a misconfiguration into a
mysterious redirect loop.

**Invariant: the code is single-use, short-lived, and only its hash is stored.**
The plaintext exists in one redirect and one redemption.

The redemption lives on `IamGateway` and the `/auth/mint/*` surface — **not** on
`IamRpc`. That split is ADR-0007's least-privilege boundary, not tidiness: the
proxy is the only publicly-routed component and holds a key scoped to exactly the
calls it needs. Putting redemption on `IamRpc` would hand it to every SDK consumer
that holds the management key.

The existing `px_session` tier stays in the proxy. It costs nothing, keeps the
local stack working unchanged, and remains the right path when the app genuinely
does share a domain with IAM.

## Consequences

- **Apps can live on any domain.** `SESSION_COOKIE_DOMAIN` stops being load-bearing
  for cross-host access and becomes an optimisation for hosts that do share a
  parent.
- **Browser SSO works on `.zerops.app` subdomains**, with no custom domain — the
  acceptance test for this ADR is precisely that.
- **The proxy needs its public scheme**, to build the callback and the return URL.
  That settles the open question of how the proxy learns its public scheme (backlog
  48, closed by this sprint) in favour of the manifest, because the value is now
  needed for correctness rather than only for a redirect.
- **A new registry has to be kept current.** An app whose public origin changes and
  whose registration does not will stop being able to log anyone in. It is
  fail-closed, which is the right direction, but it is new operational surface.
- **Revocation improves, within the same bound.** A child session carries its
  parent's id, so revoking the IAM session revokes every app session derived from
  it — the shared cookie had no such link. The bound is unchanged and unchanged by
  design: an already-minted access token is verified locally and stays valid for
  the rest of its TTL.
- **The proxy sets a cookie for the first time.** It was a pure enforcement point;
  it is now also the thing that establishes an app session. That is one more place
  a mistake sets a credential, so the cookie is written on exactly one path — a
  successful redemption at the reserved callback — and nowhere else.
- **A reserved path appears on every app host.** It must not shadow an application
  route, the same hazard `caddy.ts` already documents for the health route.

## Alternatives considered

**Keep the shared cookie and require a custom domain per installation.** Cheapest,
and it is what the code does today. Rejected because it forces every hosted app
under a platform-owned domain, which the product cannot accept, and because it
leaves `.zerops.app` permanently broken for the console.

**Put every app on one hostname and route by path.** Makes the cookie host-only and
trivially shared. Rejected: the proxy routes by `Host` and `assertUniqueHosts`
(`packages/proxy/src/caddy.ts`) forbids two apps on one host; apps expect to own
their origin, and cookie/CORS isolation between apps would be lost.

**Let the proxy mint from the session itself over a back channel.** Would need the
browser to present something on the app host, which is the very thing that does not
work. No.

**Put redemption on `IamRpc`.** Simpler contract, one fewer surface. Rejected on
ADR-0007 grounds — see above.
