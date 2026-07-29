---
id: 08
title: Decide how gate config reaches the running auth service
blocked-by: []
---

# 08 — Decide how gate config reaches the running auth service

**Summary.** Gates become a reconciled, IAM-stored artifact
([ADR-0007](../decisions/0007-proxy-based-auth-enforcement.md)). Open: how they get
from there into a running proxy deployment.

## Problem

Note the correction in [ADR-0010](../decisions/0010-gate-evaluation-stays-in-the-auth-service.md):
gates are **not** Caddy configuration and never reach Caddy at all. Caddy's routes
are a fixed three-step chain per app. Gates are read by the **TypeScript auth
service**, from its manifest. So this item is about getting a manifest to that
service, not about Caddy config — an earlier version of this file had it wrong.

That narrows the options usefully, because the auth service is ordinary code we
control rather than a third-party binary with a live-mutation admin API:

- **Redeploy** — bake the manifest into the deployed proxy and roll it.
- **Fetch at startup** — the auth service pulls its manifest from the IAM service
  when it boots.
- **Fetch and revalidate** — as above, plus periodic refresh, so a gate change
  propagates without a deploy.

## Approach / acceptance

**Start with redeploy**, because gates only change at app deploy time, and because
a manifest baked at build time cannot fail to load at 3am. Revisit if a use case
appears that genuinely needs gate changes between deploys — at which point
"fetch at startup, fail closed if unavailable" is the natural next step, and is
strictly easier than it would have been against Caddy's admin API.

Whichever is chosen, **fail closed**: a proxy that cannot obtain a manifest must
refuse requests, not pass them through. The auth service already denies when no
gate rule matches, so an empty manifest is safe by construction — but that must
stay true deliberately, with a test, not by luck.

Acceptance: a gate change in the IAM service is reflected by the proxy after the
app's next deploy, with no manual step; the mechanism is written down so the next
person doesn't re-litigate it; and the unavailable-manifest path is proven to deny.

## Touch points

`packages/proxy` (manifest loading), `@fabrika/iam` (gate reconcile + endpoint),
the deploy drivers.
