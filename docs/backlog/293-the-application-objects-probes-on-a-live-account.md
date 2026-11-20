---
id: 293
title: The application object's probes on a live account
blocked-by: []
---

# 293 — The application object's probes on a live account

**Summary.** The application-object runtime shipped on local tests only, and most of its Phase 0 probes still have no
live row; the example application's opice suite has not run against a Cloudflare installation. P2, size M.

## Problem

The application-object sprint ([archive](../archive/sprint-2026-10-24-application-object.md)) planned its Phase 0
probes ([proposal §6](../archive/application-object-runtime-and-operations.md)) for a throwaway account. A dry run on a
local workerd answered 5, 8 and 9 (see the sprint's run log). A live installation has since deployed an application
with its object, uploaded files of up to 40 MB and run a side restore through point-in-time recovery
([`cloudflare-platform.md`](../reference/cloudflare-platform.md)); that covers the happy path of 7 and the upload half
of 9, nothing else:

1. An uncancelled `AbortSignal.timeout`, or a pending alarm, keeps an object from hibernating.
2. Billed duration over 24 h from GraphQL analytics, minute cron against alarms only.
3. `waitUntil` lifetime after a response and from `alarm()`, at 1, 5 and 15 min.
4. `setAlarm` under `transactionSync` and `storage.transaction` rollback; alarm lag p50/p99; `getAlarm()` inside
   `alarm()`; exhausted retries.
5. A timer set inside a `storage.transaction` callback.
6. The default CPU limit per alarm and per request; `limits.cpu_ms`.
7. PITR: abort before the undo bookmark persists, lost undo response, foreign bookmark, restore time at 10 MB and 1 GB.
8. `sql.databaseSize`, cursor `rowsWritten`, `defer_foreign_keys`, the `typeof`/`cast` projection.
9. R2 multipart from an object for a dump of more than one part; export and import throughput.
10. The account's cron-trigger limit.

## Approach / acceptance

A probe per row on a throwaway Worker in a test account, deleted after; each result moves into
`cloudflare-platform.md` with its date. A row that fails is a bug against ADR-0065 or ADR-0070, not a note. Then deploy
`examples/app` through a Cloudflare installation and run its opice suite against it.

## Touch points

`docs/reference/cloudflare-platform.md`, `packages/app/src/cloudflare/`, `packages/db/src/sqlite.ts`.
