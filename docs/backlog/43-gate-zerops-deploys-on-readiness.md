---
id: 43
title: Gate Zerops deploys on readiness, and give every check explicit timeouts
blocked-by: []
---

# 43 — Gate Zerops deploys on readiness, and give every check explicit timeouts

**Summary.** Every Zerops setup defines `run.healthCheck` and none defines
`deploy.readinessCheck`. They are different mechanisms: one pulls a degraded
container out of the balancer while it is live, the other decides whether a new
version is allowed to take traffic at all. Today nothing gates the second.

## Problem

All four platform setups
([`../../packages/installation-zerops/zerops/setups.ts`](../../packages/installation-zerops/zerops/setups.ts))
and both example descriptors define only `run.healthCheck`, and each of those is a
bare `httpGet` with no timeouts:

```
healthCheck: { httpGet: { port: 3000, path: '/healthz' } }
```

Two consequences.

**No readiness gate.** A container that starts and immediately fails to serve is
detected by the liveness check _after_ it has been given traffic, and the failure
mode is a restart loop rather than a failed deploy with the previous version still
serving. `run.initCommands` already gate on migrations — a non-zero exit there
aborts the deploy — but nothing gates on the process actually answering.

**Nothing is pinned.** Upstream lists `failureTimeout`, `disconnectTimeout`,
`recoveryTimeout` and `execPeriod` for `healthCheck` and `failureTimeout` /
`retryPeriod` for `readinessCheck`, and advises setting them rather than relying on
schema defaults. Relevant when this is fixed: a live-verified note records that
**every timeout is a Go duration and must carry a unit** — a bare integer fails
validation with `cannot unmarshal !!int into time.Duration`, and that message is
visible only through explicit validation, not in the build log.

The proxy is the case that matters most: it is the only publicly routed service in
either project, so a proxy version that builds but cannot serve takes the whole
project's public surface with it.

## Approach / acceptance

- Add `deploy.readinessCheck` to each setup that has a meaningful "can serve now"
  signal, with `failureTimeout` and `retryPeriod` written out.
- Write the four `healthCheck` timeouts explicitly, with units, and keep the checks
  liveness-only — the existing reasoning stands: a check that queried Postgres would
  turn a slow dependency into a restart storm.
- Decide per service whether the readiness path may touch dependencies where the
  liveness path may not; they answer different questions and need not share an
  endpoint.
- Extend the example app's descriptors to match, so the copied default carries both.
- Acceptance: the `zerops.yaml` schema test covers the new keys; every duration in a
  generated descriptor carries a unit; and a live deploy of a deliberately
  non-serving build fails the deploy instead of activating.

## Touch points

- `packages/installation-zerops/zerops/setups.ts` and the generated root `zerops.yaml`
- `packages/installation-zerops/zerops/__tests__/zerops-yaml.test.ts`
- `examples/zerops-app/zerops.yaml`, `examples/zerops-app/zerops.shared-postgres.yaml`

<!-- Origin: Zerops skill conformance review, 2026-07-31. -->
