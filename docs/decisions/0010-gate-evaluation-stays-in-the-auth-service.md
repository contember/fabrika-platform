---
id: 0010
title: Gate evaluation stays in the auth service; Caddy routes are a fixed chain
status: accepted
date: 2026-07-28
amends: 0008
---

# 0010 — Gate evaluation stays in the auth service; Caddy routes are a fixed chain

## Context

[ADR-0008](0008-caddy-forward-auth-proxy.md) chose Caddy + `forward_auth` and
assumed the gate model would map onto Caddy's own routing: an app's `AppGates`
would compile into Caddy route matchers, with `forward_auth` applied to the
protected ones. The reasoning was that first-match-wins path rules look like
first-match-wins route matching.

Implementing it disproved that. The mapping was checked against Caddy v2.10.2's
source and confirmed against a locally built binary, not assumed.

**1. Fall-through is inexpressible — this alone is fatal.** A `service` rule
falls through to the next rule when no credential is present. A `human` rule
falls through when the session is missing _or invalid_. "Invalid" is only
knowable after exchanging the session with the IAM service and verifying a
signature. A Caddy matcher decides before any of that has happened, so a rule's
own match condition depends on work that can only occur downstream of the match.

**2. Caddy's path matcher is case-insensitive; `AppGates` is not.**
`MatchPath.Match` lower-cases both the pattern and the path, deliberately, "to
mitigate security issues related to differences between operating systems". The
SDK's glob is case-sensitive. So `/Admin/*` gates a different set of requests in
the two engines. Confirmed live: `/PUBLIC/health` is denied by the auth service
and would have matched a `/public/*` route in Caddy.

**3. Caddy's `*` does not cross `/`.** For an interior wildcard Caddy falls back
to Go's `path.Match`, whose `*` stops at a separator; the SDK compiles `*` to
`.*`, which does not. Caddy also normalizes `//` before matching while the SDK
matches the raw pathname. Confirmed live: `//public/health` is denied by the auth
service and would have matched in Caddy.

Points 2 and 3 are the more insidious pair: they do not fail loudly, they just
gate a _slightly different set of requests_ than the app declared — in the
permissive direction.

## Decision

**Gate rules are never compiled into Caddy routes.** Caddy's configuration is a
fixed three-step chain per app — delete the injected token header, then
`forward_auth`, then proxy to the app upstream — and every gate decision is made
in the TypeScript auth service, which receives the gate list verbatim in its
manifest with order preserved.

Caddy keeps the job ADR-0008 actually chose it for: HTTP correctness
(WebSockets, streaming, HTTP/2, hop-by-hop headers, timeouts) and being the
single publicly-routed process. It does not get a vote on authorization.

## Consequences

- **This strengthens ADR-0008's central claim rather than weakening it.** That
  ADR rejected a Go plugin specifically to avoid a second implementation of the
  security-critical path. Compiling gates into Caddy matchers would have
  reintroduced exactly that — a second, subtly different evaluator, written in
  config. There is now exactly one gate evaluator.
- The generated Caddy config must **delete** the injected token header before
  `forward_auth`, not merely overwrite it. `copy_headers` cannot delete: each
  copy is guarded by a `not vars ""` matcher, so an empty auth-response header is
  a no-op. Without the explicit delete, a client-supplied token header would
  survive to the app on any `public` path. This is load-bearing.
- **The `Set-Cookie` channel disappears behind `forward_auth`.** Caddy copies
  only named headers from a 2xx auth response onto the _upstream request_ and
  discards the rest, so the proxy cannot hand the browser a refreshed `px_token`.
  The auth service's own token cache replaces that mechanism, which makes the
  cache substantially more load-bearing here than it was in the SDK.
- `X-Forwarded-Host` is client-controllable once `trusted_proxies` is set, which
  is tempting to configure behind the Zerops L7 balancer. App identity is
  therefore pinned in the generated route (`?app=<id>`), with host lookup only as
  a fallback.
- Gate distribution is still a real problem, just not a Caddy one — see
  [`../archive/08-distribute-gate-config-to-proxy.md`](../archive/08-distribute-gate-config-to-proxy.md).

## Alternatives rejected

**Normalise `AppGates` to Caddy's semantics** (case-insensitive, `*` stops at
`/`). This would change the meaning of every gate list already written, in the
permissive direction, to accommodate a routing engine — and it still would not
solve fall-through, which is the fatal one.

**Keep gates in Caddy and accept no fall-through**, requiring every rule to be
terminal. This is a real simplification of the auth model and might be worth
considering on its own merits some day, but it is a change to the _product_, and
it cannot be made as a side effect of choosing a proxy implementation.
