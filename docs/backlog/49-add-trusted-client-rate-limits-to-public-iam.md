---
id: 49
title: Add trusted client rate limits to public IAM authentication
blocked-by: []
---

# 49 — Add trusted client rate limits to public IAM authentication

**Summary.** Add an ingress-owned per-client abuse limit for password login and
recovery without trusting caller-supplied forwarding headers.

## Problem

IAM currently combines per-account buckets with a deployment-wide abuse bucket.
This bounds password-derivation and email-delivery work even when an attacker
rotates addresses. It cannot isolate clients: behind the Zerops project balancer,
IAM sees the balancer as its peer, while a forwarded address supplied by the
caller is not a trustworthy limiter key. Cloudflare provides a managed client
address, but shared IAM code cannot assume that header has the same provenance on
both compositions.

The deployment-wide bucket therefore trades bounded CPU and mail work for an
installation-wide temporary denial when one client exhausts it.

## Approach / acceptance

Place the per-client limit at a boundary that observes the real peer, or inject a
composition-specific authenticated client coordinate that callers cannot set.
Make the check-and-increment admission decision atomic so a concurrent burst
cannot cross the limit before any request records its attempt. Keep the IAM
account and deployment-wide buckets as defense in depth. Document header
ownership at every hop and test spoofed forwarding headers on both provider
compositions.

Acceptance requires one abusive client to be throttled without blocking another
client, exceeding the configured work bound through concurrency, or bypassing
the limit by changing `CF-Connecting-IP` or `X-Forwarded-For`.

## Touch points

Cloudflare IAM routing, Zerops/Caddy public IAM routing, `packages/iam`, provider
composition tests.
