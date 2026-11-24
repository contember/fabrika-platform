---
id: 0080
title: The serving process keeps the job schedule where no crontab runs
status: proposed
date: 2026-11-24
---

# 0080: The serving process keeps the job schedule where no crontab runs

## Context

A contract application's cron jobs (`c.cron`) and the framework's own jobs (the file sweep, the scan pass) run on a
schedule. Today each runtime gets the schedule from somewhere else:

- **On Zerops** the platform renders the recipe's `jobs` (`contractRecipe`, `packages/app/src/build-recipe.ts`) into
  `run.crontab`, each line `fabrika job run <name>` on one container. The framework keeps no cron wake on Bun
  (`completion` in `packages/app/src/jobs/runner.ts`: "On Bun, where crontab runs the schedule, a job keeps none").
- **On Cloudflare** the environment's Durable Object keeps one cron wake per job and fires it from its alarm
  (`JobScheduler.repair`, ADR-0065 §5): `repair` schedules each job's next fire under the dedupe key
  `cron:<job>:<expression>`, and a run's completion schedules the next.

The container clouds of [Fabrika on the big three clouds](../ideas/cloud-providers.md) (ECS, Container Apps, GKE) have
no container crontab. Each offers a scheduler resource instead: EventBridge Scheduler starting an ECS task, a scheduled
Container Apps job, a Kubernetes CronJob. That is one resource and one identity per job, a cold start per run (tens of
seconds for an image pull and a boot), and a second deploy surface that must follow every contract change.

Most of the Bun path already exists. The serving process runs a `WakeTimer` (`packages/app/src/bun.ts`) that calls
`ContractJobs.wake`. `wake` reconciles the cron wakes against the declared jobs and their expressions on its first
call. It then kicks every contract job with a due wake through the kick path, under the job's lease, and answers when
the next wake is due. A run owns the wakes that were due when it took the lease (`packages/db/src/job-wakes.ts`), and
its finish consumes them and, when one was a cron wake, schedules the next fire, inline runs included (`completion`
keeps `nextCron` whenever a cron wake was pending). What Bun lacks is only the first cron wake per job,
which nothing seeds outside Cloudflare's `repair`, and the framework's own jobs, which `wake` does not kick.

## Decision

We will let the Bun serving process keep the schedule when the platform says no crontab runs:

1. **A framework variable switches it on.** `FABRIKA_JOB_SCHEDULE=process`, written by a provider that renders no
   crontab. Without it nothing changes: Zerops keeps its crontab, and an application keeps no cron wake on Bun.
2. **The serving process seeds and keeps one cron wake per job.** On boot, and on every refresh of the wake timer, each
   declared job, the framework's included, gets its next fire scheduled under `cron:<job>:<expression>`, as `repair`
   does. The dedupe key makes the write idempotent across the environment's containers, and `wakes.reconcile` already
   removes the wake of a changed expression.
3. **`wake` kicks the framework's own jobs too** in this mode, through the same lease path as a contract job.
4. **The lease is the only coordination.** Every container runs the timer; the job's lease and the wake's ownership
   (`ownedByHolder`) keep two containers from running one fire twice, as they keep two crontab containers from it today.
   A fire missed while no container ran stays due and is run once when one runs again, as on Cloudflare.
5. **The recipe drops the crontab lines.** `contractRecipe` gains `schedule: 'crontab' | 'process'` (default
   `crontab`). With `process` its `jobs` stay listed for the provider's records but are rendered into no crontab, and
   `fabrika job run <name>` stays available for an operator's one-off run.
6. **A provider that writes the variable refuses an older framework.** An application pinned below the first release
   that reads `FABRIKA_JOB_SCHEDULE` would run no job at all, so that provider refuses its deploy, as Control refuses a
   release outside its window (ADR-0062).

## Consequences

- A container cloud runs every job without a scheduler resource, a per-job identity or a cold start, and the schedule
  follows the deployed contract with nothing to redeploy beside it.
- A job runs only while at least one container serves. A provider that uses this mode keeps at least one replica of
  every application with a job (min replicas 1 on Container Apps, no scale to zero), and its CPU must run between
  requests (no request-only CPU, as on Cloud Run's request-based billing).
- The schedule's precision is the wake timer's: a fire runs within the timer's refresh (60 s) of its minute, and an
  overdue fire coalesces with the next, as on Cloudflare. A crontab fired on the minute.
- Jobs share the serving process's database pool and CPU with requests, which on Zerops they did not: a crontab line is
  its own process. `FABRIKA_APP_DATABASE_CONNECTIONS` must be sized for the requests and the jobs a container runs at
  once; the job count `sizeDatabase` reads on Zerops (`zeropsJobProcesses`) becomes a per-container one.
- **Rollout of an existing installation.** None: no provider writes the variable today, Zerops keeps the crontab and
  never writes it, and Cloudflare's object keeps its alarm. The variable is additive platform protocol (ADR-0062): an
  older framework ignores it, which item 6 makes a refusal rather than a silent loss of every job.
- The variable joins `FRAMEWORK_VARIABLE_NAMES`, and the job scrubber's and the managed environment's public names.

## Alternatives considered

- **A cloud scheduler per job** (EventBridge Scheduler, a scheduled Container Apps job, a Kubernetes CronJob). It keeps
  jobs out of the serving process, and each run gets a container of its own. It costs a resource, an identity and a
  cold start per job and per run, a second deploy path that must follow every contract change (a job added, renamed or
  rescheduled), and a provider-specific implementation three times. It stays open to a provider that must isolate a
  job's resources; nothing in this decision forbids it.
- **A crontab inside the image** (a cron daemon beside Bun in the container). It needs a process supervisor in the
  image, every replica fires every line (the lease then turns all but one into no-ops), and a container that restarts
  skips the fires of its downtime. The wake timer already exists and coalesces what it missed.
- **One scheduler for the installation** (Control fires every application's jobs over an ops call). It couples every
  application's schedule to Control's availability and gives Control a new path into every application, for work the
  application can do alone.
