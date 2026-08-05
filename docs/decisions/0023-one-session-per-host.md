---
id: 0023
title: One session per host — retire the shared session cookie
status: accepted
date: 2026-08-05
amends: 0022
---

# 0023 — One session per host

## Context

[ADR-0022](0022-the-proxy-is-the-only-enforcement-point.md) states the enforcement model end to end
and leaves exactly one question open, in the section _"There are two session-delivery mechanisms, and
whether to keep both is open"_. This ADR answers it. 0022's body is unedited; it anticipated this
decision and named its consequences.

There were two ways a browser could come to hold a session for an application:

1. **The one-time code** ([ADR-0021](0021-exchange-token-session-handoff.md)). IAM issues a single-use
   code bound to `(session, app, return URL)`, redirects to the app's own host at
   `/__fabrika/auth/callback`, and the proxy there redeems it and sets a **host-only** cookie. Works
   everywhere, including across registrable domains and on `*.zerops.app`, which is on the Public
   Suffix List.
2. **The shared cookie.** IAM sets `px_session` with `Domain=<parent>`, configured by
   `SESSION_COOKIE_DOMAIN`, and every app under that parent reads the same cookie. ADR-0021 kept it as
   an optimisation: _"it costs nothing, keeps the local stack working unchanged, and remains the right
   path when the app genuinely does share a domain with IAM"_.

"Costs nothing" stopped being true, and the auth-hardening sprint found the bill in three places:

- **It blocked the `__Host-` cookie prefix** (SEC-20). `__Host-` forbids `Domain`; `SESSION_COOKIE_DOMAIN`
  exists to set one. The prefix could not be applied to the session cookie in any installation on the
  shared-cookie path — including the local stack, which was deliberately on it.
- **It was a second path through `/auth/login`.** `readHandoff` had four outcomes rather than two, and
  the difference between two of them was whether a fallback the operator never asked for could reach the
  destination. SEC-6 is the finding that the fallback strands a browser in an undiagnosable login loop
  whenever it cannot; the fix was a narrowed opt-out, i.e. a special case inside a special case.
- **It made `safeRedirect` a second authority on where a browser may be sent.** Its allowlist was the
  cookie domain, so IAM had two different answers to "may I send this browser to that host?" — the
  return-origin registry, and a wildcard over a parent domain that no one registered anything with.

The reason to keep it also weakened. WU-G made registering an app's return origins one ordinary call on
every deploy (`reconcileSchema` with `returnOrigins`, projected by the control plane from
`app_envs.public_origin`), so the argument "the handoff needs registration and only a deploy can do
that" no longer holds anywhere a deploy happens — and where none does, the local stack, the same call is
available.

**One measurement was load-bearing and is recorded here so nobody re-derives it.** `__Host-` requires
`Secure`, and the local stack serves plain HTTP on `http://*.fabrika.localhost:18080`. Verified in
Chromium 151.0.7922.34 (the build Playwright 1.62.1 installs, i.e. the one the browser suite runs):
a `__Host-`-prefixed `Secure` cookie set over plain HTTP on `http://control.fabrika.localhost` is
**accepted** and returned on the next request, because `*.localhost` is a potentially-trustworthy
origin. The same probe confirmed the prefix's rules are enforced — a `__Host-` cookie carrying `Domain`
and one without `Secure` were both dropped — and that the prefix buys something host-only alone does
not: a sibling host setting `Domain=fabrika.localhost` planted a **second** `px_session` that the real
host then sent alongside its own, while `__Host-px_session` could not be shadowed at all.

## Decision

**We will deliver every application session as a one-time code redeemed by the proxy on the
application's own host, and delete the shared session cookie.** Four parts.

### 1. There is one session-delivery mechanism

`SESSION_COOKIE_DOMAIN` is deleted, from `Env`, from `Config`, from both installation templates and
from the local composition. No configuration widens a session cookie to a parent domain, and no code
path reads one. An app that shares a domain with IAM takes the same route as an app that does not.

**Invariant: a session cookie is host-only, always.** IAM's is written on IAM's host by
`/auth/login`; an app's is written on the app's host by its proxy, on the one path that redeems a code.
The two are different `sessions` rows with the same cookie NAME, and neither is ever readable from the
other's host.

### 2. Both session cookies and the per-app token carry the `__Host-` prefix

`SESSION_COOKIE` is `__Host-px_session` and `TOKEN_COOKIE` is `__Host-px_token`. The prefix is a
browser-enforced restatement of the invariant above: a cookie with that name is refused unless it has
`Secure`, has `Path=/`, and names no `Domain`. What it adds beyond host-only is the shadowing case
measured above — a sibling subdomain cannot plant a duplicate the real host would then send. That is
why SEC-20's decision ("prefix only; duplicate-aware cookie reading not needed") is coherent: with the
prefix there is no duplicate to read.

**`Secure` is now unconditional** on every cookie IAM and the proxy write. It used to be derived — from
the configured issuer's scheme in IAM, from the manifest's scheme in the proxy — because the socket is
plain HTTP behind a TLS-terminating balancer and was the wrong signal. The prefix removes the decision
entirely: without `Secure` the browser stores nothing, so a conditional could only ever produce a cookie
that does not exist. It remains correct behind a balancer and on `localhost`.

### 3. `readHandoff` has two outcomes for a named app, and the registry is the only authority

Given `?app=`, either the return address is in that app's registry and the browser gets a code, or it is
not and the answer is a **400 naming the address**. An empty registry is not an opt-out; it is an app
that cannot log anyone in, reported as such. SEC-6's narrowed opt-out is gone with the branch it was
narrowing.

`safeRedirect` accepts only IAM's own origin and falls back to the issuer for everything else — no
cookie domain, and no `*.localhost` special case either, because a cross-host destination is the
registry's business and `readHandoff` has already consulted it.

**Invariant: the return-origin registry is the only thing that may send a browser to another host.**

### 4. Local development runs the handoff, like everything else

`@fabrika/local-stack` registers the console (`vozka`) and the notes example with IAM after the
composition is healthy, with the same `reconcileSchema` call, the same endpoints and the same admin
credential a deploy uses. It stands in for the deploy that is absent locally, exactly as it already does
for the machine key — it is not a local-only mechanism, and there is no local-only branch in IAM or the
proxy to support it. The browser suite signs in the same way: the seeded IAM login is planted on IAM's
host and one `/auth/login?app=…&redirect=…` per application host turns it into that host's own session.

## Consequences

- **One extra redirect on first sign-in for an app that shares a domain with IAM.** This is the whole
  price. The shared cookie let such an app skip the code round trip; now it takes it. It is one 302 per
  app per login — not per request, not per token expiry — and the proxy re-mints access tokens
  server-side from the app's own session thereafter.
- **`__Host-` on the session cookie, which was unreachable before.** A sibling subdomain can no longer
  shadow a session cookie, and the browser enforces host-only rather than the server merely intending it.
- **Every installation exercises the same code path.** The handoff was the path a Zerops installation
  took and the local stack did not, so its coverage was production-only; it is now on every `local:up`
  and every browser run. Two configurations became one.
- **An app whose return origins are not registered cannot log anyone in, and says so.** This is
  fail-closed and it is new operational surface — 0022 already recorded it for apps that had opted in;
  it now applies to all of them. The 400 names the address, which is the one thing an operator can act
  on. The control plane registers these on every deploy from `app_envs.public_origin`, so the failure
  mode is "the origin was never configured", not "somebody forgot a step".
- **An installation served over cleartext HTTP on a public hostname can hold no session.** `Secure` is
  unconditional and the browser will not store the cookie. That is the correct outcome for a 30-day
  credential; it is stated here because it is a behaviour change for anyone who was relying on an
  `http://` issuer outside `localhost`.
- **`readHandoff`, `safeRedirect` and the cookie builder each got smaller.** The cookie helper has no
  `domain` option at all, so the shape that would break the prefix is not expressible.
- **What did NOT change: the proxy's tiers.** `authorize.ts` still reads a session cookie on the app
  host and mints from it. Only the cookie's provenance narrowed — from "possibly IAM's own shared
  cookie" to "always a child session this proxy itself set".
- **A parent (`app IS NULL`) session still mints for any app if presented on an app's host.** Nothing
  puts it there any more — the cookie is host-only on IAM's host — but `mintToken` does not refuse it,
  and the local fixture seeders rely on that. Tightening it would buy nothing: whoever holds an IAM
  login can obtain a code for any registered app anyway.

## Alternatives considered

**Keep the shared cookie and apply `__Host-` only to `px_token`.** The other half of the question 0022
left open. `px_token` is already host-only, so the prefix there is nearly free — and nearly pointless:
the credential worth protecting is the 30-day session, not the five-minute access token, and the session
would have kept the shadowing weakness the measurement above demonstrates. It would also have preserved
the second `readHandoff` path, the second redirect authority, and a mechanism whose only remaining
advantage is one redirect on one class of installation. This sprint's standard is "where two mechanisms
do one job, delete one"; this is that case.

**Keep the shared cookie for co-located hosts and use the handoff elsewhere, selected automatically.**
That is what the code did, and SEC-6 is the report of it failing: the selection was "does this app have
a registry", which does not answer "can a cookie reach that host", so a third rule had to be bolted on
to tell the two apart. Any automatic selection has this shape.

**Serve TLS in the local stack so `__Host-` is unambiguous.** Considered before the measurement, and
unnecessary after it: Chromium accepts the prefix over plain HTTP on `*.localhost`. It would have added
certificate generation and trust-store handling to `local:up` for no behavioural gain.

**Apply `__Host-` outside `local` only.** Rejected on the sprint's own terms: a mechanism that exists
only locally is precisely what this work has been deleting, and it would mean the cookie the suite tests
is not the cookie production sets.
