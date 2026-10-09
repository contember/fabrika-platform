---
id: 96
title: Operations sees only failed job runs
blocked-by: []
---

# 96 — Operations sees only failed job runs

**Summary.** A job run that succeeds leaves no trace in Operations: ingest accepts error events only, so run history,
durations and a run's start never reach the console. Medium effort; needs an Operations ingest kind.

## Problem

The job runner of `@fabrika/app` (`packages/app/src/jobs/runner.ts`) reports through the application's own Sentry
ingest (`FABRIKA_OPERATIONS_DSN`). Operations' `parseEventEnvelope` (`packages/operations/src/ingest.ts`) keeps only
`event` items with an exception, so the runner reports `JobFailed` (a failed or crashed run) and `JobMissed` (a job
that has not succeeded within twice its period) and nothing else. The last outcome, start, finish and duration of each
job live only in the application's `fabrika_job_leases` row, which each run overwrites. Job reports also travel under
the public ingest key, so a holder of the browser DSN can forge one, as they can forge any error event.

## Approach / acceptance

- An Operations ingest kind for job runs (start, terminal outcome with its failure code, attempts, duration, run id),
  stored per application and environment, shown in the console as a run history per job.
- The reports are authenticated by the job's workload credential (B9 of the application framework plan, principal
  kind `job`), not by the public ingest key, and Operations binds the job and run coordinates server-side.
- Witness: a successful run and a crashed run each appear in the job's history; an envelope sent with the public key
  cannot write a job run.

## Touch points

`packages/operations` (ingest, repositories, migrations), `packages/operations-contract`, `packages/dashboard`,
`packages/app/src/jobs/report.ts`.

<!-- Origin: the A15 review of the application framework plan (docs/ideas/app-framework-implementation-plan.md). -->
