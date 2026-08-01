---
id: 38
title: Add DNS-safe Operations egress
blocked-by: []
---

# 38 — Add DNS-safe Operations egress

**Summary.** Route Operations webhooks and active HTTP health checks through a
controlled resolver/egress path that prevents private-network access and DNS
rebinding in production.

## Problem

Webhook targets now require HTTPS, reject credentials, fragments, IP literals,
private-looking suffixes, and redirects, and are revalidated before every
delivery. Application `publicOrigin` is stored as an explicit exact HTTP(S)
origin instead of being derived from a provider domain. These syntax checks do
not prove where a hostname resolves.

An attacker or mistaken administrator can still use a public-looking hostname
whose A or AAAA record resolves to loopback, link-local, private, metadata, or
another internal address. DNS rebinding can also change the address between
validation and connection. The same risk applies to webhook delivery and
Operations active HTTP health checks against an administrator-configured
`publicOrigin`.

Local composition deliberately uses
`http://notes.fabrika.localhost:18081`; production hardening must not remove that local
workflow.

## Approach / acceptance

- Define one production egress policy shared by webhook delivery and active
  HTTP health checks.
- Resolve every candidate A and AAAA address, reject non-public ranges
  including IPv4-mapped IPv6 forms, and bind the connection to the validated
  address while preserving TLS SNI and the HTTP `Host`.
- Prevent time-of-check/time-of-use DNS rebinding. Re-resolve and revalidate on
  each retry instead of trusting a stored address indefinitely.
- Keep redirects disabled and retain current request timeouts, response-body
  cancellation, bounded logging, and webhook idempotency keys.
- Select an implementation that works honestly on Cloudflare and Bun/Zerops,
  such as a controlled egress service where the runtime cannot pin a resolved
  address itself.
- Keep the local composition's explicit localhost origin behind a local-only
  egress policy. Production configuration must fail closed if controlled egress
  is unavailable.
- Add deterministic resolver/connection tests for private answers, mixed
  public/private answers, rebinding, IPv4-mapped IPv6, and allowed public
  targets for both webhook and health-check callers.

## Touch points

- `packages/operations/src/maintenance.ts`
- `packages/operations/src/health.ts`
- Operations runtime composition on Cloudflare and Bun/Zerops
- `packages/local-stack/`

<!-- Origin: Operations plane foundation final review. -->
