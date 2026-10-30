---
id: 258
title: Maintenance can park a sandbox in the middle of its bootstrap
blocked-by: []
---

# 258 — Maintenance can park a sandbox in the middle of its bootstrap

**Summary.** The idle park looks only at `activity_at`, which nothing bumps while a bootstrap waits for the
environment's lease or builds, so a sandbox can be parked mid-build and its bootstrap fails. Medium.

## Problem

`listIdle` (`packages/control/src/db/dev-sandboxes.ts`) selects every `ready`, unparked row whose `activity_at` is older
than 30 minutes. `startBootstrap` bumps `activity_at` when `bind_dev` queues the run, but the bootstraps of one
environment hold its `<app>:<env>` lease in turn, and the build inside the sandbox may take up to its 30-minute
deadline. Workspace B, queued behind A's 25-minute bootstrap, is parked 5 minutes into its own build and ends
`bootstrap_failed`. A long `run_checks` can be parked the same way once the launcher stops reporting while it runs.

Box's own idle TTL ([platform facts](../reference/zerops-platform.md), the 2026-10 release) would not help: it does not
count a running detached process, and the build runs as one (`startProcess`).

## Approach / acceptance

Leave a sandbox whose `bootstrap_run_id` is pending or running out of `listIdle`, or bump `activity_at` when a laned run
is claimed and when it finishes. A test: a sandbox whose bootstrap run is running and whose `activity_at` is older than
the idle window is not parked by `maintainDevSandboxes`.

## Touch points

`packages/control/src/db/dev-sandboxes.ts`, `packages/control/src/dev/service.ts`,
`packages/control/src/__tests__/dev-sandboxes.test.ts`.

<!-- Origin: the comprehensive review of the per-workspace dev sandboxes PR (#84). -->
