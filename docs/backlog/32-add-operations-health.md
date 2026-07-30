---
id: 32
title: Add portable service and telemetry health
blocked-by: [./28-model-observed-app-environments.md]
---

# 32 — Add portable service and telemetry health

**Summary.** Extend the initial Errors capability with active service checks and
portable health for the telemetry pipeline.

## Problem

Poplach reports useful ingest and queue health, but parts of that implementation
query Cloudflare Analytics APIs directly. It does not provide a provider-neutral
answer for whether a deployed service is reachable, whether telemetry is moving,
or whether scheduled detection and notification work is current.

Health is the smallest useful Operations capability beyond error tracking. It
must not imply that a successful deploy means a healthy application.

## Approach / acceptance

- Define health observations for configured HTTP checks, ingest acceptance,
  consumer lag/backlog, dead events, scheduled evaluation, and notification
  delivery.
- Implement provider/runtime adapters for facts that cannot be obtained through
  shared ports.
- Store bounded health history and current state without turning control into a
  metrics store.
- Surface environment and service health in Operations and summarize it on the
  installation overview.
- Generalize existing Poplach alert rules and notification channels enough to
  alert on new issues, regressions, failed checks, and unhealthy telemetry.
- Test state transitions, stale-data handling, alert deduplication, recovery, and
  provider API unavailability.

## Touch points

- Operations health, scheduler, alerting, and UI
- Cloudflare queue and analytics adapters
- Bun/Postgres job consumer health
- `packages/platform/`
- installation overview in `packages/dashboard/`

<!-- Origin: ../ideas/operations-plane.md and ADR-0016. -->
