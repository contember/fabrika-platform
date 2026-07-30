---
id: 29
title: Integrate Operations into the unified console
blocked-by: [./28-model-observed-app-environments.md]
---

# 29 — Integrate Operations into the unified console

**Summary.** Add Operations as the third console plane while keeping its API and
authorization in the Operations service.

## Problem

The unified console currently presents Delivery and Access. Poplach has a
separate shell, navigation, origin, and typed RPC client. Linking to that SPA
would preserve duplicate navigation and authentication behaviour, while moving
its handlers into control would violate the independent service boundary.

## Approach / acceptance

- Turn the migrated Poplach SPA into an Operations feature package mounted below
  `/operations/*`.
- Add Operations navigation and an installation overview summary without
  weakening the existing Delivery and Access hierarchy.
- Add a narrow control-to-Operations operator gateway that preserves request,
  response, cookies, CSRF protection, and Operations-owned authorization.
- Keep application telemetry on its direct ingest origin; the gateway must reject
  or not route ingest paths.
- Replace project management UI with Fabrika application/environment/service
  context.
- Browser tests must cover issue list/detail/triage, access denial, navigation
  among all three planes, and failure isolation when Operations is unavailable.

## Touch points

- Operations UI and contract packages
- `packages/dashboard/`
- `packages/control/`
- Cloudflare service bindings
- Zerops private service routing
- local full-stack composition

<!-- Origin: ../ideas/operations-plane.md and ADR-0016. -->
