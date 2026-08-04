---
id: 51
title: Project an app's return origins into IAM from the control plane
blocked-by: []
---

# 51 — Project an app's return origins into IAM from the control plane

**Summary.** Cross-host SSO ([ADR-0021](../decisions/0021-exchange-token-session-handoff.md))
refuses to hand a browser to an app whose public origin IAM has not been told to
trust. IAM has the registry and an admin surface to write it; nothing writes it
automatically. Today an operator calls `apps.setReturnOrigins` by hand, which is
one manual step between a deploy and a working sign-in.

## Problem

`setReturnOrigins` (`packages/iam/src/admin/handlers.ts`) is reachable over the
admin RPC and does its job. The gap is upstream of it: the control plane already
knows every coordinate involved and never forwards them.

- `app_envs.public_origin` is an explicit canonical origin, already validated, and
  already projected to Operations.
- `syncZeropsProxy` (`packages/control/src/node/zerops-proxy.ts`) builds each
  `ProxyApp` from `row.domain`, so at manifest time control holds the exact host the
  browser will use.

The consequence is quiet rather than loud. A newly deployed app serves fine, its
gates are enforced, and only a human trying to sign in discovers the missing
registration — as a `400` from IAM with the return address named in it, which is at
least legible, but it happens at the worst moment.

## Approach

Register alongside the existing per-deploy IAM touchpoint rather than inventing a
new lifecycle. `reconcileSchema` (`packages/auth/src/provision.ts`) already runs on
every deploy with an admin key and IAM's origin; the natural shape is an optional
`returnOrigins` on it that makes the second call when supplied, with the value
threaded from the app's env row.

Keep them separate calls and separate concepts: an `AppSchema` is vocabulary the
**application** declares, while a return origin is a fact the **control plane**
knows. Folding origins into the schema body would let an app assert where it can be
handed a session, which is exactly what the registry exists to prevent.

## Acceptance

Deploying an app whose `public_origin` is set registers it, so a browser sign-in
works with no manual step; changing the origin re-registers and the old one stops
being accepted; an app with no `public_origin` is left alone rather than registered
with a guess.

<!-- Origin: sprint exchange-token-sso, 2026-08-04. -->
