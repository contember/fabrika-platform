---
id: 249
title: The challenge hostname reads the request's Host
blocked-by: []
---

# 249 — The challenge hostname reads the request's Host

**Summary.** `@fabrika/app` issues an ALTCHA challenge for the hostname of the request it received. Behind a proxy
entry with `upstreamHost` (a dev sandbox), that is the sandbox router's Host, not the public host, so the challenge
names the wrong host. Small.

## Problem

`dispatch.ts` issues a challenge with `served.issuer.issue(new URL(request.url).hostname)`
(`packages/app/src/implement/dispatch.ts`), and the verification compares the solved challenge's host with the check's
(`packages/app/src/implement/challenge.ts`). In a dev sandbox the proxy sends `Host:
3000-<sandbox>` ([ADR-0022](../decisions/0022-the-proxy-is-the-only-enforcement-point.md), "Dev
sandbox entries"), so the issued challenge names that host. Anywhere else the request's host is the public host only
because the proxy passes the client's `Host` through.

## Approach / acceptance

Take the challenge hostname from the application's public origin (`FABRIKA_APP_ORIGIN`), which Control writes per
environment and per sandbox, instead of the request. Test: an application served under a different `Host` than its
origin issues and verifies a challenge for the origin's host.

## Touch points

- `packages/app/src/implement/dispatch.ts`
- `packages/app/src/implement/challenge.ts`
