---
id: 08
title: Decide how gate config reaches the running Caddy proxy
blocked-by: []
---

# 08 — Decide how gate config reaches the running Caddy proxy

**Summary.** Gates become a reconciled, IAM-stored artifact
([ADR-0007](../decisions/0007-proxy-based-auth-enforcement.md)). Open: how they get
from there into a running proxy.

## Problem

Two candidate mechanisms:

- **Caddy's admin API** — push config to a live instance, no restart.
- **Redeploy** — bake the config into the deployed proxy and roll it.

The admin API is the more capable option but adds a live-mutation surface on the
component that stands in front of every app, which is the last place we want an
extra write path ([ADR-0008](../decisions/0008-caddy-forward-auth-proxy.md): keep
the proxy thin and stateless).

## Approach / acceptance

**Start with redeploy**, because gates only change at app deploy time — the case
that motivates the admin API doesn't arise yet. Revisit if a use case appears that
genuinely needs gate changes between deploys.

Acceptance: a gate change in the IAM service is reflected by the proxy after the
app's next deploy, with no manual step; and the mechanism chosen is written down so
the next person doesn't re-litigate it.

## Touch points

The proxy package (Caddyfile generation), `@fabrika/iam` (gate reconcile +
endpoint), the deploy drivers.
