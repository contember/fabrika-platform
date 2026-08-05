---
id: 21
title: Rate-limit the IAM mint surface
blocked-by: []
---

# 21 — Rate-limit the IAM mint surface

Deferred deliberately when the HTTP mint endpoints were added, with reasoning worth
preserving rather than re-deriving.

## Context

`POST /auth/mint/session` and `/auth/mint/key` require a bearer
(`FABRIKA_IAM_PROXY_KEY`), and an unset key makes the surface 404 rather than
public.
That removes the anonymous attacker — which was the case that made an open mint
endpoint an oracle answering "is this session still valid?" for unlimited guesses.

What remains is **per-client** throttling, and the IAM service cannot do it: behind
the project L7 balancer the peer address is the balancer's, and keying a limiter on
a forwarded header the caller can set is worse than no limiter, because it looks
like protection.

## Approach

The proxy sits in front of the actual client and already caches per session — that
is where a per-client limit belongs. Detection is covered meanwhile: every failed
mint writes an `auth_log` deny row with app and reason, so a burst is visible in the
admin auth log (there is a test for that).

## Acceptance

A per-client limit exists at the proxy, and the choice of key is justified against
what the proxy can actually observe.
