---
id: 0008
title: Caddy + forward_auth on Zerops, a thin Worker on Cloudflare, over one shared TypeScript auth service
status: accepted
date: 2026-07-28
amended-by: 0010
---

> **Amended by [ADR-0010](0010-gate-evaluation-stays-in-the-auth-service.md).** The
> core decision below stands — Caddy + `forward_auth`, not a Go plugin — but this
> ADR's assumption that gate rules would compile into Caddy route matchers is
> wrong, and implementation disproved it. Gates are evaluated entirely in the auth
> service; Caddy's routes are a fixed chain. Read ADR-0010 before acting on any
> statement here about gates and Caddy routing.

# 0008 — Caddy + `forward_auth` on Zerops, a thin Worker on Cloudflare, over one shared TypeScript auth service

## Context

[ADR-0007](0007-proxy-based-auth-enforcement.md) puts a proxy in front of every app.
That proxy has to do two very different jobs:

1. **HTTP correctness** — WebSockets, streaming bodies, HTTP/2, hop-by-hop header
   handling, timeouts, connection reuse. Getting this subtly wrong breaks apps in
   ways that are hard to attribute.
2. **Auth** — session→token exchange, cache, JWKS verification, gate evaluation.
   This is the security-critical path and it already exists, in TypeScript.

On Cloudflare the first job is the platform's, so a thin Worker suffices. On Zerops
there is no such thing, so a real reverse proxy is required — and the temptation is
to write the auth logic as a plugin inside it.

Caddy's `forward_auth` directive is the relevant primitive: it calls an external
auth service with the request's headers, and then either **forwards the request
upstream while copying named headers** from the auth response, or **returns the auth
service's response to the client** — so a `302` to `/auth/login` works naturally,
with no special-casing. Authelia, Authentik and oauth2-proxy are all deployed this
way; the pattern is well-trodden.

Deployability on Zerops is confirmed: the Alpine custom runtime runs an arbitrary
static binary with an arbitrary `run.start`
([Alpine overview](https://docs.zerops.io/alpine/overview)), and the project L7
balancer terminates TLS
([access & networking](https://docs.zerops.io/features/access)) — so Caddy needs no
ACME and no certificate persistence, which removes its main operational burden.

## Decision

The proxy is **Caddy with `forward_auth` on Zerops** and a **thin Worker on
Cloudflare**. Both call the **same TypeScript auth service** — the auth logic exists
once.

Division of responsibility:

- **Caddy owns HTTP correctness**: WebSockets, streaming, HTTP/2, hop-by-hop
  headers, timeouts.
- **The TypeScript auth service owns auth**: exchange, cache, verification, gates.

Explicitly **not** a Go plugin implementing the auth logic inside Caddy.

## Consequences

- One implementation of the security-critical path, on both platforms. A fix lands
  once.
- Caddy handles the HTTP edge cases we would otherwise be writing and debugging
  ourselves.
- **A second language and toolchain enter an otherwise all-TypeScript repo** — a
  Caddyfile, a Caddy binary to pin and update, and Alpine runtime config to
  maintain. Real cost, accepted.
- **One local `forward_auth` hop per request.** It stays inside the project's
  private network, but it is not free and it is on the warm path.
- **The proxy is a per-project single point of failure.** Mitigation is to keep it
  thin: stateless, so it scales horizontally and any instance can serve any request.
  Resist every future temptation to give it state.
- Gate configuration has to reach Caddy somehow —
  [`../archive/08-distribute-gate-config-to-proxy.md`](../archive/08-distribute-gate-config-to-proxy.md).
- The proxy needs multiple custom domains pointing at one service on Zerops, which
  is unconfirmed —
  [`../backlog/09-confirm-multi-domain-per-service.md`](../backlog/09-confirm-multi-domain-per-service.md).

## Alternatives considered

- **A Go plugin inside Caddy implementing auth.** Rejected, and this is the central
  rejection: it means a **second implementation of the security-critical path**, in
  a different language, that is guaranteed to diverge from the TypeScript one on
  Cloudflare. Two implementations of an authorization check is the worst possible
  place to have two implementations.
- **Traefik instead of Caddy.** Rejected on two counts: its Go plugins run
  _interpreted_ under Yaegi — so the plugin route is both a second implementation
  _and_ a slow one — and its main differentiator, dynamic service discovery, is
  irrelevant when the service list comes from fabrika's own registry.
- **Write the proxy in TypeScript (Bun/Node) for both platforms.** Tempting for
  toolchain uniformity, but rejected: it puts us on the hook for WebSockets,
  streaming, HTTP/2 and hop-by-hop header correctness — the exact category of work
  a mature proxy has already done, and where bugs are silent and app-visible.
- **Nginx + `auth_request`.** Comparable in principle, but `auth_request` cannot
  return the auth service's own response (notably a redirect to login) without extra
  machinery, and the Caddy ecosystem's `forward_auth` conventions are what the
  reference implementations already target.
