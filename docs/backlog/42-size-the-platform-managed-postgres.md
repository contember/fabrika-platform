---
id: 42
title: Size the platform's managed Postgres explicitly
blocked-by: []
---

# 42 — Size the platform's managed Postgres explicitly

**Summary.** The platform project declares two `postgresql:ha@18` services with no
`profile`. Omitting it on an HA service applies `oltp-production` — dedicated CPU and
high minima — so every installation pays for two production-tier HA clusters whether
or not it needs them.

## Problem

`db` and `operationsdb` in
[`../../packages/installation-zerops/zerops/topology.ts`](../../packages/installation-zerops/zerops/topology.ts)
are declared as `postgresql:ha@18` with `priority: 100` and nothing else. Upstream
documents `profile` as setting both the autoscaling envelope and the PostgreSQL
tuning preset, and documents the HA default as `oltp-production`. Three containers
each, dedicated CPU, twice over.

The provider already knows the correct option sets. `namespace.ts:155-197` carries
per-type profile allowlists that match upstream exactly — `oltp-enterprise` is HA-only,
`oltp-hobby` is single-only — and `ZeropsServiceSpec` already accepts `profile`. The
platform topology simply does not use either.

The same omission is in the worked example: `examples/zerops-app/fabrika.config.ts`
picks `postgresql:single@18` for non-prod, which defaults to `oltp-staging` rather
than the cheaper `oltp-hobby` that a dev database wants. An example is where people
copy their defaults from.

There is a second, smaller gap in the same area: `verticalAutoscaling` is
representable and unused everywhere, so nothing bounds the runtime services either.

## Approach / acceptance

- Choose and write an explicit `profile` for both platform databases, with the
  reasoning recorded where the declaration lives. `operationsdb` carries high-volume
  error history and `db` carries IAM/control — they do not obviously want the same
  preset.
- Give the example app `oltp-hobby` for non-prod, so the copied default is the cheap
  one.
- Decide whether the platform runtimes want an explicit `verticalAutoscaling`
  envelope or whether the defaults are right; state which.
- Acceptance: no managed service in a generated artifact relies on a profile default;
  a topology test asserts that; and the cost of a stock installation is written down
  in [`../reference/zerops-platform.md`](../reference/zerops-platform.md) rather than
  discovered on the first invoice.

## Touch points

- `packages/installation-zerops/zerops/topology.ts`, `invariants.ts`, `generated/`
- `examples/zerops-app/fabrika.config.ts`
- `packages/provider-zerops/src/namespace.ts` (profile allowlists — already correct)

<!-- Origin: Zerops skill conformance review, 2026-07-31. -->
