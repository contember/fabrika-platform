---
id: 0007
title: Enforce auth in a proxy instead of an in-process SDK
status: superseded by 0022
date: 2026-07-28
superseded-by: 0022
---

> **Superseded by [ADR-0022](0022-the-proxy-is-the-only-enforcement-point.md)**, which states the
> settled enforcement model end to end. This ADR is kept for its reasoning — why enforcement left
> the in-process SDK at all, and the alternatives it rejected. Read 0022 for what the system does
> now.

# 0007 — Enforce auth in a proxy instead of an in-process SDK

## Context

Today `PropustkaAuth` is middleware **inside** the application: the app imports the
SDK, wires it into its request pipeline, and the SDK evaluates the app's gates.
Enforcement is therefore only as reliable as the wiring. A route registered before
the middleware, a second entrypoint, a forgotten mount — each is an unauthenticated
path, and nothing structural prevents it. The app is also publicly routable by
definition, so "the app forgot to check" and "the world can reach it" are the same
deployment.

propustka once used **Cloudflare Access** for exactly this, and removed it to become
"100% native". That removal is not being reversed so much as _paid for_: Cloudflare
Access only works on Cloudflare, and fabrika now has to run on Zerops. The
capability was right; the vendor-specific implementation was not. Rebuilding it
portably is a prerequisite for the platform goal, not a change of mind.

The enabling observation: **the proxy is not a new component.** It is
`PropustkaAuth` relocated into its own process — the same session→token exchange,
the same cache, the same local JWKS verification. The existing short-lived signed
`px_token` is already the equivalent of `Cf-Access-Jwt-Assertion`. Nothing about the
auth model has to be invented; only its address changes.

The topology falls out of what is stateful:

- The **IAM service is stateful and global** — one identity database, one audit log,
  one admin UI. Fragmenting it per environment or per project would destroy the
  product thesis, which is precisely that identity and audit are unified.
- The **proxy is stateless** — so it can be per environment project, cached, and
  scaled horizontally.

## Decision

We will enforce authentication and authorization in a **proxy** in front of the
apps. **Only the proxy is publicly routed**; app services stay internal.

- On Zerops this is already the platform default — services are not publicly
  accessible until you opt in
  ([access & networking](https://docs.zerops.io/features/access)).
- On Cloudflare the app Workers get **no route** and are reachable only via a
  service binding from the proxy.

The IAM service (`@fabrika/iam`) stays **global**. The proxy is **per environment
project**. The public hop to IAM is **cold-path only**; the warm path verifies the
token locally and never leaves the project.

## Consequences

- **Unreachability becomes structural.** An app that forgets to check auth is still
  not reachable, because there is no public route to it. This is the entire point.
- **`AppGates` stop being pure SDK config.** propustka currently holds an explicit
  invariant: _there is NO worker endpoint and NO reconcile for gates; they are pure
  SDK config._ The proxy needs the gates, and the proxy is not the app — so gates
  become a **reconciled, IAM-stored artifact** with an endpoint to fetch them. That
  invariant is hereby retired; this ADR supersedes it.
- **`@fabrika/auth` shrinks.** No minting, no gate evaluation. What remains is
  verifying the injected token plus `can()` / `scopedTo()` as defence in depth for
  app-internal checks the proxy cannot make.
- Gate configuration now has a distribution problem — how it reaches the running
  proxy —
  [`../archive/08-distribute-gate-config-to-proxy.md`](../archive/08-distribute-gate-config-to-proxy.md).
- The proxy is on every request to every app, so it is a per-project single point of
  failure. It must stay thin — see
  [ADR-0008](0008-caddy-forward-auth-proxy.md) for how that is mitigated.
- Downstream SDK consumers (poplach, revizor, opice) get an API break — folded into
  the one rename break in [ADR-0001](0001-merge-propustka-and-vozka.md).

## Alternatives considered

- **Keep in-process SDK enforcement.** Rejected: enforcement is opt-in per route by
  construction, and the app is publicly reachable whether or not it opted in. Every
  audit finding of the "endpoint X wasn't behind auth" kind is unfixable in this
  model — you can only find them one at a time.
- **Re-adopt Cloudflare Access.** Rejected: it does not exist on Zerops. This is the
  whole reason the capability is being rebuilt rather than bought.
- **Per-project IAM instances** (fragmenting identity so the warm path never leaves
  the project). Rejected: it splits the identity database and the audit log, which
  _is_ the product. Unnecessary as well — the warm path already verifies locally,
  so the public hop is cold-path only.
- **Sidecar per app instead of a shared proxy.** Rejected: N deployables to keep at
  the same version, N caches, N places for gate config to be stale — for the same
  guarantee a single stateless, horizontally-scaled proxy provides.
- **Leave gates as SDK config and have the proxy ask the app.** Rejected: it makes
  the app authoritative about its own protection, which returns the trust to the
  component being protected.
