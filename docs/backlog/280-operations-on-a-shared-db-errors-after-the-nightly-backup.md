---
id: 280
title: Operations on a shared `db` errors after the nightly backup
blocked-by: []
---

# 280 — Operations on a shared `db` errors after the nightly backup

**Summary.** A light Zerops installation created before `operationsdb` existed keeps Operations in `db`. After `db`'s
nightly dump, Zerops reloads the PostgreSQL configuration, and Operations' ingest processing logs errors for about
15 s each night (once for 18 minutes). Small.

## Problem

On one production installation, Operations' log showed a burst of errors right after Zerops logged the `db` backup
and a configuration reload, on several nights. Most bursts were about 15 lines; one lasted 18 minutes. Events wait
in the durable ingest queue, so they are probably delayed, not lost, but nothing proves that. An ingest request
during the reload may answer 5xx, which an application retries only once (`packages/app/src/jobs/report.ts`). An
installation on `operationsdb` does not share the reload. `docs/reference/zerops-platform.md` ("a managed service's
backup schedule") records why such an installation keeps `db` on the daily schedule.

## Approach / acceptance

1. Find what fails: the queue's poll (`PostgresOperationsConsumer` over `@fabrika/platform-node`'s job queue), the
   ingest endpoint, or both, and whether any event is lost.
2. A connection error during a reload is treated as transient: the poll backs off and logs one line per outage, not
   one per pass, and the ingest answers 503 with `Retry-After`.
3. Document how such an installation moves Operations to `operationsdb`, or state that it stays on `db` until it is
   reinstalled.

Witness: an Operations test drops the database connection for a few seconds mid-poll. The queue drains afterwards,
every event is stored, and the log has one line.

## Touch points

`packages/operations/src/node/runtime.ts`, `packages/operations/src/node/consumer.ts`,
`packages/platform-node/src/job-queue-postgres.ts`, `docs/reference/zerops-platform.md`.

<!-- Origin: side finding of the incident review of a production Zerops installation (2026-10). -->
