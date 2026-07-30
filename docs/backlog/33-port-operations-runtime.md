---
id: 33
title: Compose Operations on Cloudflare and Zerops
blocked-by: [./27-absorb-poplach-service.md]
---

# 33 — Compose Operations on Cloudflare and Zerops

**Summary.** Supply production implementations and installation topology for the
independent Operations service on both supported Fabrika platforms.

## Problem

Poplach is Cloudflare-specific: D1, KV, R2, Queues, Analytics Engine, Email
Routing, cron triggers, and Cloudflare analytics APIs appear in its runtime
composition. Fabrika installations must run entirely on their selected provider.
An Operations plane available only on Cloudflare would break that product
boundary.

The existing SQL, blob, queue, asset, and lifecycle ports cover much of the Bun
path, but frequency aggregation, notification delivery, scheduler ownership, and
some pipeline-health facts still need honest runtime seams.

## Approach / acceptance

- Compose the Operations service on Cloudflare using D1/R2/Queues and explicit
  Cloudflare implementations for frequency and health data.
- Compose it on Bun/Zerops using Postgres, S3-compatible storage, the Postgres job
  queue, and Bun lifecycle management.
- Add only the missing domain-level ports; do not leak provider discriminators
  into shared Operations code.
- Provision private operator connectivity, public ingest routing, migrations,
  storage, scheduled work, secrets, and health checks through both installation
  packages.
- Verify equivalent ingest, processing, query, alert, restart, and migration
  behaviour locally for both compositions.
- Validate generated Zerops topology and Cloudflare resource graphs. Real-account
  verification remains subject to the existing Zerops bring-up backlog.

## Touch points

- Operations composition roots and repositories
- `packages/platform/`
- `packages/platform-node/`
- `packages/installation-cloudflare/`
- `packages/installation-zerops/`
- generated Cloudflare and Zerops artefacts
- local full-stack scripts

<!-- Origin: ../ideas/operations-plane.md and ADR-0016. -->
