---
id: 0023
title: One session per host, bound to the browser that started the login
status: accepted
date: 2026-10-07
---

# 0023 — One session per host, bound to the browser that started the login

## Context

[ADR-0022](0022-the-proxy-is-the-only-enforcement-point.md) delivers an application session through a
one-time code that the proxy redeems on the app's own host. A second mechanism could also deliver one:
IAM sets its session cookie with `Domain=<parent>` and every app under that parent reads it. That
shared cookie saves one redirect when an app shares a domain with IAM, and costs more than that:

- **It blocks the `__Host-` prefix.** `__Host-` forbids `Domain`, so the session cookie cannot carry
  it. Without the prefix a sibling subdomain can set `Domain=<parent>` and plant a second session
  cookie that the real host then sends alongside its own.
- **It is a second path through `/auth/login`.** Choosing between the two paths needs a rule for "can a
  cookie reach that host", which no registry answers.
- **It is a second redirect authority.** The cookie domain becomes a wildcard allowlist beside the
  per-app return-origin registry.

The control plane registers an app's return origins on every deploy, so the handoff works anywhere a
deploy happens. `__Host-` requires `Secure`, and Chromium accepts a `Secure` cookie over plain HTTP on
`*.localhost`, so the local stack can use the prefix without TLS.

The code alone does not bind the callback to the browser that started the login. An attacker can log
in as themselves, copy the callback URL and make a victim's browser visit it. The victim's proxy would
redeem a valid code and replace the victim's app session with a child of the attacker's session. This
is login CSRF (session swapping).

## Decision

**We will deliver every application session as a one-time code redeemed on the app's own host, bound
to the browser that started the login, and have no shared session cookie.**

### 1. There is one session-delivery mechanism

No configuration widens a session cookie to a parent domain, and no code path reads one. An app that
shares a domain with IAM takes the same route as one that does not.

**Invariant: a session cookie is host-only, always.** IAM writes its session on IAM's host at
`/auth/login`. A proxy writes an app session on the app's host, on the one path that redeems a code.
They are different `sessions` rows with the same cookie name.

### 2. Every fabrika cookie carries the `__Host-` prefix and `Secure`

The session cookie is `__Host-px_session`; handoff cookies are `__Host-px_handoff_<state>`. The browser
refuses a cookie with that prefix unless it has `Secure`, `Path=/` and no `Domain`, so a sibling host
cannot shadow it. `Secure` is unconditional. The socket behind a TLS-terminating balancer is plain HTTP,
so a derived `Secure` was the wrong signal, and without `Secure` the browser stores nothing anyway.

The browser holds no access-token cookie. The proxy mints or reuses a short-lived per-app JWT
server-side and injects it as `X-Fabrika-Token`.

### 3. The return-origin registry is the only redirect authority

Given `?app=`, IAM issues a code only when the return address is in that app's registry, the request
carries a valid handoff state and challenge, and the human is authenticated. Otherwise it answers
**400 and names the refused address**. An empty registry is an app that cannot log anyone in.
`safeRedirect` accepts only IAM's own origin. A flow without an accepted address lands on the
installation's console, a registered origin, or on IAM's sign-in page without one.

**Invariant: the return-origin registry is the only thing that may send a browser to another host.**

### 4. The handoff is bound to the browser with a PKCE-style verifier

1. When the proxy starts a login it generates a random public `state` and a random secret `verifier`.
2. It stores the verifier in a ten-minute `__Host-px_handoff_<state>` cookie (`HttpOnly`,
   `SameSite=Lax`). The state-specific name keeps concurrent tabs independent.
3. It sends `state` and `code_challenge = SHA-256(verifier)` through IAM's password, OIDC and
   existing-session login paths. The verifier never appears in a URL.
4. IAM integrity-binds the challenge into the plaintext code and stores the hash of the complete code.
5. IAM returns the state with the code. The proxy requires the matching verifier cookie and redeems
   `(app, code, verifier)` over its private IAM surface.
6. IAM consumes the code atomically, then checks the verifier. Success creates the child app session.
   Every terminal callback clears the handoff cookie.

**Invariant: a callback URL alone never establishes a session.** Redemption needs the verifier that
only the initiating browser holds.

### 5. Local development runs the handoff

`@fabrika/local-stack` registers its apps' return origins with the same `reconcileSchema` call and the
same admin credential a deploy uses. IAM and the proxy have no local-only branch. The browser suite
plants an IAM login on IAM's host and runs one `/auth/login?app=…&redirect=…` per app host.

## Consequences

- **One extra redirect on first sign-in for an app that shares a domain with IAM**, once per app per
  login. Access tokens are re-minted server-side from the app session afterwards.
- **Every installation, including `local:up` and the browser suite, exercises the same path.**
- **An app whose return origins are not registered cannot log anyone in, and the 400 says which
  address.** The control plane registers origins on every deploy from the app environment's public
  origin, so the failure means the origin was never configured.
- **An installation served over cleartext HTTP on a public hostname holds no session.** Correct for a
  30-day credential.
- **A copied callback URL cannot create or replace another browser's session.** A thief of a live code
  can still consume it and make that login fail; the code was already a short-lived bearer credential.
- **Login start writes a transient cookie.** Abandoned attempts expire after ten minutes.
- **The code format carries the challenge, but storage is still one hash.** No schema change.
- **A parent IAM session still mints for any app if presented on an app host.** Nothing puts it there,
  and the local fixture seeders rely on it. Refusing it buys nothing: an IAM login can obtain a code for
  any registered app.
- **First-party gateways that call IAM forward the proxy's JWT as a bearer**, not a cookie. IAM verifies
  issuer and audience and resolves the principal's IAM permissions itself.

## Alternatives considered

- **Keep the shared cookie and prefix only the access token.** Protects the five-minute credential and
  leaves the 30-day session shadowable, with the second login path and second redirect authority intact.
- **Choose shared cookie or handoff automatically per app.** "Does this app have a registry" does not
  answer "can a cookie reach that host", so a third rule must be bolted on. Any automatic choice has
  this shape.
- **Serve TLS in the local stack.** Unnecessary: Chromium accepts `__Host-` over HTTP on `*.localhost`.
- **Apply `__Host-` outside `local` only.** The suite would test a cookie production does not set.
- **A state cookie with no verifier.** Stops a copied URL in the common case, but the check stays
  proxy-local; a verifier makes IAM enforce the browser proof and keeps the secret out of every URL.
- **Store the challenge in a new column.** Binding it into the hashed code gives the same authenticated
  input without a migration or a second lookup key.
- **Keep a browser JWT cookie as a fallback.** Another ambient credential and another branch in the proxy's decision; the
  app session and the proxy's token cache already cover renewal and the fast path.
- **Forward fabrika cookies to the app and trust it not to read them.** Leaves a bearer credential in a
  less trusted process; stripping at the proxy is smaller and testable.
