---
id: 27
title: Absorb Poplach behind an Operations service boundary
blocked-by: []
---

# 27 — Absorb Poplach behind an Operations service boundary

**Summary.** Move the existing error-monitoring capability into the Fabrika
monorepo without coupling telemetry intake or storage to control.

## Problem

Poplach is a standalone Bun/Cloudflare application that imports the predecessor
Trasa and Propustka packages and owns its own Worker, RPC API, SPA, persistence,
queue consumer, cron work, and deployment declaration. Fabrika now owns the
successor application runtime and IAM contracts, so the repository boundary adds
coordinated release work without preserving a useful service boundary.

A mechanical copy into `@fabrika/control` would be incorrect. Telemetry ingestion
and processing must remain independently deployable and independently stored, as
required by [ADR-0016](../decisions/0016-independent-operations-plane.md).

## Approach / acceptance

- Create Operations service, browser-safe contract, and UI feature package
  boundaries.
- Port Poplach from `@trasa/core` and `@propustka/*` to `@fabrika/app` and
  `@fabrika/auth`.
- Separate its domain operations from Cloudflare bindings through repositories
  and narrow runtime capabilities.
- Preserve the existing Sentry-envelope ingest, issue grouping, event detail,
  triage, source maps, regressions, alert rules, and notification-channel
  behaviour.
- Keep a direct ingest endpoint and a separate authenticated operator API.
- Prove parity with migrated Poplach tests plus package-level typecheck and lint.

This item establishes the service and package boundary. It does not yet replace
Poplach projects with Fabrika registry coordinates or retire the standalone
deployment.

## Touch points

- new Operations service, contract, and UI packages
- `packages/app/`
- `packages/auth/`
- `packages/platform/`
- `projects/oss/poplach/src/`
- `projects/oss/poplach/migrations/`
- `projects/oss/poplach/tests/`

<!-- Origin: ../ideas/operations-plane.md and ADR-0016. -->
