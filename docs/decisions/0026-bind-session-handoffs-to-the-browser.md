---
id: 0026
title: Bind session handoffs to the browser that started them
status: accepted
date: 2026-08-06
---

# 0026 — Bind session handoffs to the browser that started them

## Context

ADR-0021 made the cross-host handoff code single-use, short-lived, app-bound, and
destination-bound. ADR-0022 retained that flow behind the one enforcement point, and ADR-0023 made
it the only way an app host receives a session. Those properties prevent replay, cross-app
redemption, and an open redirect. They do not bind the callback to the browser that initiated login.

Without that binding, an attacker can start a login for an app, authenticate as the attacker, copy
the resulting callback URL, and cause a victim's browser to visit it. The victim's app proxy can
redeem the valid code and overwrite the victim's app session with a child of the attacker's IAM
session. The code proves that IAM authorized a handoff, but not that this browser requested it. This
is login CSRF, also called session swapping.

The browser holds two durable opaque credentials by design: one host-only session on IAM and one on
each app host. The short-lived per-app JWT is an internal proxy-to-app credential. A dormant
`__Host-px_token` browser-cookie path duplicated that JWT as a third credential tier even though no
component issued the cookie. Keeping it increased the accepted attack surface without providing a
working fallback.

Two other boundaries depended on convention rather than enforcement. The proxy forwarded its own
session cookies to the application even though the application authenticates only the injected
header. Cloudflare's automatic invocation logs could also record the raw callback URL, including the
one-time code, outside the proxy's structured redaction layer.

## Decision

Every app handoff will use a browser-held proof modeled on OAuth PKCE with S256:

1. The app proxy generates a random public `state` and a random secret `verifier` when it starts
   login.
2. It stores the verifier in a ten-minute, host-only, `Secure`, `HttpOnly`, `SameSite=Lax` cookie
   named `__Host-px_handoff_<state>`. A state-specific name lets concurrent tabs keep independent
   attempts.
3. It sends `state` and `SHA-256(verifier)` as `code_challenge` through IAM's password, OIDC, and
   existing-session login paths. The verifier never travels in a browser-visible URL.
4. IAM integrity-binds the challenge into the plaintext handoff code and stores the SHA-256 hash of
   that complete code, as before. This changes no database shape.
5. IAM returns the public state with the code. The app proxy requires the matching verifier cookie
   and sends `(app, code, verifier)` over its private redemption RPC.
6. IAM atomically consumes the code before accepting the verifier. A successful proof creates the
   child app session; every terminal callback clears the attempt cookie.

The long-lived browser credential remains the opaque `__Host-px_session`. The proxy no longer reads
a browser JWT cookie. It mints or reuses a short-lived per-app JWT, verifies it, and injects it as
`X-Fabrika-Token`.

Fabrika browser cookies terminate at the proxy. Both the Caddy and Cloudflare compositions strip
every `__Host-px_*` cookie from the upstream request after authorization while preserving
application-owned cookies. The application receives the verified JWT header and no Fabrika session
or handoff credential. A first-party gateway that calls IAM forwards that signed token as a bearer;
IAM verifies the token's issuer and signed audience, then resolves the principal's IAM permissions
live instead of trusting the calling app's permission snapshot.

Cloudflare proxy Workers keep structured logs enabled but disable automatic invocation logs. The
callback code is a query parameter, and invocation metadata is outside the proxy's redaction layer.

This ADR amends ADR-0022 and ADR-0023. Their enforcement point, per-host session, and single-use code
decisions remain in force; the new proof narrows when that code may establish the app session.

## Consequences

- A callback URL copied to another browser is insufficient to create or replace its app session.
- Login initiation now writes a transient cookie. The earlier wording that the proxy writes a cookie
  only at successful redemption applies to the long-lived app session, not to handoff state.
- An attacker who obtains a live callback code can consume it and cause that login attempt to fail,
  but cannot redeem it into a session without the verifier. The code was already a short-lived bearer
  credential; the new property removes session swapping without claiming availability against code
  theft.
- Parallel login tabs work because state selects a distinct cookie. Abandoned attempts expire after
  ten minutes.
- The code format changes, but the database stores only its hash and needs no migration. Codes are
  already single-use and live for two minutes, so there is no supported mixed-version redemption
  window to preserve.
- Applications can still use their own cookies. Only the reserved `__Host-px_` namespace is removed
  on the proxy-to-app hop.
- Cross-plane gateways no longer forward an app-host cookie to a different service. IAM admin calls
  use the proxy JWT as proof of identity and re-evaluate IAM authority at IAM.
- Cloudflare loses automatic request invocation metadata for proxy Workers. Deliberate structured
  logs remain available without raw queries or credential values.

## Alternatives considered

### Store state only, with no verifier

A random state cookie compared on callback would stop a copied URL in the ordinary case. A verifier
also keeps the cookie value out of every browser-visible URL and makes IAM enforce the browser proof,
rather than leaving it as a proxy-local correlation check.

### Store the challenge in a new database column

The one-time code is already hashed as a complete opaque value. Integrity-binding the public
challenge into that value gives the redemption path the same authenticated input without a schema
migration or a second lookup key.

### Keep the browser JWT cookie as a fallback

Nothing issued it, so it was not a functioning compatibility path. Accepting it created another
ambient browser credential and another human-gate branch. The opaque app session already supplies
renewal, and the proxy's short-lived JWT cache supplies the fast path.

### Forward the app session cookie and rely on applications not to read it

That leaves an unnecessary bearer credential in a less trusted process. The application contract is
the injected JWT header, so enforcing that boundary at both proxy runtimes is smaller and testable.
