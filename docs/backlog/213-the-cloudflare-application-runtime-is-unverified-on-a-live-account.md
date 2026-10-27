---
id: 213
title: The Cloudflare application runtime is unverified on a live account
blocked-by: []
---

# 213 — The Cloudflare application runtime is unverified on a live account

**Summary.** ADR-0065's runtime is tested on Lopata and on a local workerd (`wrangler dev`), not on an account. Three
facts it relies on cannot be checked locally. P1 before a Cloudflare installation serves an application; size M.

## Problem

`docs/reference/cloudflare-platform.md` records what a local workerd run settled (savepoints, the input gate, `?`
parameters, R2's conditional put, a 230 KB `define`, foreign keys) and what was probed on an account. Still open:

1. `wrangler deploy --secrets-file` turns an existing plain variable of the same name into a secret in one deploy.
2. The provider's Durable Object migration (`new_sqlite_classes`) applies to an existing application Worker, including
   one that already declared a tag of its own (216 item 3).
3. The account accepts the upload of a proxy Worker whose `define` bakes a manifest of 200 KB and more (it builds and
   runs locally).

## Approach / acceptance

A probe per row on a throwaway Worker in a test account, deleted after; each result moves into
`cloudflare-platform.md` with its date. Then deploy `examples/app` through a Cloudflare installation and run its
opice suite against it. A row that fails is a bug against ADR-0065, not a note.

## The application object's probes

The application-object sprint ([archive](../archive/sprint-2026-10-24-application-object.md)) shipped on local tests
only; its Phase 0 probes ([proposal §6](../archive/application-object-runtime-and-operations.md)) run here, on the same
throwaway account. A dry run on a local workerd answered 5, 8 and 9 (see the sprint's run log); each still needs a live
row.

1. An uncancelled `AbortSignal.timeout`, or a pending alarm, keeps an object from hibernating.
2. Billed duration over 24 h from GraphQL analytics, minute cron against alarms only.
3. `waitUntil` lifetime after a response and from `alarm()`, at 1, 5 and 15 min.
4. `setAlarm` under `transactionSync` and `storage.transaction` rollback; alarm lag p50/p99; `getAlarm()` inside
   `alarm()`; exhausted retries.
5. A timer set inside a `storage.transaction` callback.
6. The default CPU limit per alarm and per request; `limits.cpu_ms`.
7. PITR: happy path, abort before the undo bookmark persists, lost undo response, foreign bookmark, restore time at
   10 MB and 1 GB.
8. `sql.databaseSize`, cursor `rowsWritten`, `defer_foreign_keys`, the `typeof`/`cast` projection.
9. R2 multipart from an object; export and import throughput.
10. The account's cron-trigger limit.

## Touch points

`docs/reference/cloudflare-platform.md`, `packages/provider-cloudflare/`, `packages/app/src/cloudflare/`,
`packages/db/src/sqlite.ts`.
