---
id: 48
title: Decide how the proxy learns its public scheme
blocked-by: []
---

# 48 — Decide how the proxy learns its public scheme

**Summary.** The proxy's login redirect sends the browser back to an `http://` URL
for an origin only served over `https://`. It is the third instance of one root
cause — "what scheme did the BROWSER actually speak?" — and unlike the first two it
has no obviously correct fix, so it needs a decision rather than a patch.

## Problem

`readForwardedRequest` (`packages/proxy/src/service.ts`) reconstructs the original
request from what Caddy's `forward_auth` forwarded, and takes the scheme from
`X-Forwarded-Proto`. Behind the Zerops L7 balancer that header does not say what the
browser said: the balancer terminates TLS and speaks plain HTTP to Caddy, and Caddy's
`reverse_proxy` sets `X-Forwarded-Proto` from **its own** connection scheme. So the
proxy believes `http`, and `loginUrl` (`packages/proxy/src/authorize.ts`) builds

```
https://iam…/auth/login?redirect=http%3A%2F%2Fapp…%2Fapi%2Fnotes
```

Verified live on 2026-08-03. The login _origin_ is correct once the proxy's
`FABRIKA_IAM_URL` is the public one; only the return URL is wrong.

The same root cause was already fixed twice, each time by finding a signal that is
not a hop-by-hop header: control derives the `px_token` cookie's `Secure` flag from
`FABRIKA_CONTROL_DOMAIN` (`packages/control/src/iam.ts`), and `@fabrika/auth`'s
`loginUrl` now forces `https` from that same `config.secure`.

## Why it is not a one-liner

- **Preserve the balancer's header in the generated Caddy config**
  (`X-Forwarded-Proto: {http.request.header.X-Forwarded-Proto}` in the `forward_auth`
  expansion) — but in the local stack the browser talks to Caddy directly, so there
  is no upstream header, the value is empty, and the proxy's `!== 'http' → https`
  default would rewrite local `http://` redirects to `https://`. That regresses local
  development, which is the environment this path is exercised in most.
- **Give the proxy an explicit public scheme** — per app in the manifest, or one
  setting for the whole proxy. Correct and not header-dependent, but it widens
  `ProxyManifest`, which the control plane generates, and adds a value an operator
  can get wrong.

## Approach / acceptance

Pick one, then: a proxy unit test asserting the return URL's scheme for a
TLS-terminated deployment AND for a direct-HTTP local one, and a live check that
sign-in completes end to end from an app behind the proxy.

<!-- Origin: sprint zerops-live-bringup, 2026-08-03 (finding F12). -->
