---
id: 10
title: Settle how the app-scoped secret is represented on Zerops
blocked-by: []
---

# 10 — Settle how the `app`-scoped secret is represented on Zerops

**Summary.** Open question. fabrika's secret scopes are `app` (shared across
environments) and `app-env` (per environment); Zerops' levels are project and
service. They do not map 1:1.

## Problem

[ADR-0004](../decisions/0004-secrets-live-in-the-platform.md) forbids writing app
secrets at project level — project variables are injected into every service in the
project, and one project holds many apps, so project level would leak app A's
credentials to app B. **That invariant is not negotiable in solving this.**

But the natural home for an `app`-scoped secret _was_ project level. And with
project-per-environment as the default topology
([ADR-0006](../decisions/0006-zerops-project-topology-is-a-registry-field.md)), an
`app`-scoped secret spans multiple Zerops projects, so no single platform-side
location represents it.

## Approach / acceptance

Current thinking — **not decided** — is that an `app`-scoped secret **replicates per
service regardless of topology**: fabrika writes the same value to each service that
needs it, and "app scope" stays a fabrika-side concept with no platform counterpart.

Consequences to think through before committing: replication means N writes and N
places to update on rotation; a value edited in the GUI on one service silently
diverges from its siblings (and per ADR-0004 fabrika holds no copy to compare
against); and the semantics of "app scope" become weaker than they are on Cloudflare.

Acceptance: a written decision (likely an ADR) covering how `app` scope is stored,
how it is rotated, and what happens when replicas diverge.

## Touch points

The Zerops secrets adapter, the registry's secret scope model, `@fabrika/dashboard`.
