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
keeps `nextCron` whenever a cron wake was pending). What Bun lacks is the first cron wake per job, which nothing seeds
outside Cloudflare's `repair`, and the framework's own jobs, which `wake` does not kick.

Two things the Cloudflare path never meets do matter here. First, `wake` hurries a job through the kick path, and a
kick coalesces to one run plus one pending, not to one run: a replica whose `tryAcquire` is skipped sets the pending
flag unconditionally (`handOver`), so the winner runs the handler once more for the same fire. The alarm's
`JobScheduler.take` marks pending only when the holder does not own every due wake, which holds in one object; across
replicas it does not, because `tryAcquire` skips a lease row another replica's acquire still holds, and that replica's
holder is not committed yet when the loser reads it. Second, an environment's Durable
Object runs one contract at a time, while an ECS rolling update, a Container Apps revision change or a GKE rollout runs
the old and the new contract side by side for minutes.

One crontab line is not a job: with a `scan: true` kind, Zerops adds `freshclam` on every container
(`FRESHCLAM_SCHEDULE` in `packages/provider-zerops/src/execution.ts`), and the scan refuses signatures older than three
days (`signatures_stale`).

## Decision

We will let the Bun serving process keep the schedule when the platform says no crontab runs:

1. **A framework variable switches it on.** `FABRIKA_JOBS_SCHEDULE=process`, written by a provider that renders no
   crontab. Without it nothing changes: Zerops keeps its crontab, and an application keeps no cron wake on Bun. The
   name is outside `FABRIKA_JOB_*`, the family of the jobs' keys, whose members a deploy removes when Control no
   longer hands them.
2. **A due wake runs through the scheduler, not a kick.** In this mode `wake` takes the lease of each job with a due
   wake, as the alarm's `take` does, and runs it as the alarm's `run` does, durable retries included; the framework's
   own jobs go the same way. It never sets the pending flag: one replica wins the lease and owns the due wakes in that
   transaction, and the others leave nothing behind for it, so replicas whose timers fire at the same instant run one
   fire once. A wake that comes due while a run holds the lease stays due, unowned, and the holder's finish lowers its
   own process's timer to it. A handler's own kicks (ADR-0060) keep the kick path. On SIGTERM the serving process aborts these runs as it aborts its kicks (`stopKicks`) and drains them
   within the same bound, so a stopped run keeps its wakes for the next container, as a stopped alarm run does on
   Cloudflare, instead of being killed mid-run and holding its lease until it expires.
3. **One deploy owns the schedule.** The provider writes `FABRIKA_JOBS_SCHEDULE_GENERATION`, a lowercase UUID that
   rises with every deploy of the environment (the deploying run's UUIDv7 id serves). The environment's database keeps
   the highest generation seen (`fabrika_job_schedule`, compared as bytes). A process whose generation is that one, or higher (it then raises it), reconciles the cron wakes
   against its declared jobs and seeds each job's next fire under `cron:<job>:<expression>`, as `repair` does, on boot
   and on every refresh; the dedupe key makes the seed idempotent across that deploy's containers. A process of an older
   generation neither seeds nor reconciles, so during a rolling update the old revision cannot restore an expression or
   a job the new one removed. Its runs finish without scheduling a next fire (`completion`'s `nextCron`, which would
   write the wake under its own expression); the owner's seed schedules it. A redeploy of an older release is a new
   deploy with a higher generation, so a rollback takes the schedule back.

   The generation is raised by a container that starts, not by a rollout that succeeds, so every return to an older
   revision must be a deploy. A provider that writes the variable switches the cloud's own rollback off (the ECS
   deployment circuit breaker without `rollback`, Container Apps in single revision mode with no reactivation of an
   older revision, no `kubectl rollout undo`). When a rollout fails, the provider deploys the previous release again as
   a new deploy with a new generation, and an operator rolls back the same way. Between the failed revision's first boot
   and that deploy, a job only the older contract declares has no wake: the fires due in that window are skipped, and
   the redeploy seeds the next one.
4. **A process waits only for wakes it can run.** `wake` answers the next due wake among the jobs this process
   declares, so a wake of a job it does not declare (the new deploy's, during a rollout) does not hold its timer at the
   one-second retry. The owner's reconcile removes the wakes of jobs no deploy declares any more.
5. **The provider keeps a container running.** A provider that writes the variable keeps at least one replica of every
   application with a job and gives it CPU between requests (an ECS desired count of at least 1, Container Apps
   `minReplicas` of at least 1, no request-only CPU), and refuses a configuration that scales such an application to
   zero. While no container runs, nothing runs a job and nothing reports a missed one either: `jobs.check()` and
   `JobMissed` run in the serving process too. A fire that came due meanwhile stays due (`schedule` keeps
   `least(due_at)`) and the first container up runs it once.
6. **Virus signatures refresh without the crontab.** A provider that writes the variable for an application with a
   `scan: true` kind refreshes the ClamAV signatures itself (a `freshclam` daemon beside Bun in the image, or the
   provider's own schedule), or refuses that application until it does. The framework's scan pass is unchanged: it
   still refuses stale signatures.
7. **The recipe drops the crontab lines.** `contractRecipe` gains `schedule: 'crontab' | 'process'` (default
   `crontab`). With `process` its `jobs` stay listed for the provider's records but are rendered into no crontab, and
   `fabrika job run <name>` stays available for an operator's one-off run.
8. **A provider that writes the variable refuses an older framework.** An application pinned below the first release
   that reads `FABRIKA_JOBS_SCHEDULE` would run no job at all, so that provider refuses its deploy, as Control refuses a
   release outside its window (ADR-0062).

## Consequences

- A container cloud runs every job without a scheduler resource, a per-job identity or a cold start, and the schedule
  follows the deployed contract with nothing to redeploy beside it.
- A job runs only while at least one container serves (item 5): an application with a job never scales to zero, and
  pays for an always-on replica on a cloud that bills request-only CPU less (Cloud Run's request-based billing).
- A cron fire runs once per due wake, however many replicas serve, where the kick path would have run it up to twice.
  A run that fails is retried by the scheduler's durable retries, not by the next kick.
- The schedule's precision depends on who wrote the wake. A container that seeded or projected it lowers its own timer
  to the due time (`projectWakes`), so the fire starts within about a second. Every other container sees it at its
  next refresh (60 s), and only the first to take the lease runs it. An overdue fire coalesces with the next, as on
  Cloudflare. A crontab fired on the minute.
- During a rolling update the old revision keeps running the fires of jobs both contracts declare, with its own
  handler, until its containers stop, as it keeps serving requests; it no longer writes the schedule, neither by a seed
  nor by a run's finish.
- A provider in this mode gives up the cloud's automatic rollback: a failed rollout becomes a new deploy of the
  previous release, which the provider starts itself (item 3).
- Jobs share the serving process's database pool and CPU with requests, which on Zerops they did not: a crontab line is
  its own process. `FABRIKA_APP_DATABASE_CONNECTIONS` must be sized for the requests and the jobs a container runs at
  once; the job count `sizeDatabase` reads on Zerops (`zeropsJobProcesses`) becomes a per-container one.
- **Rollout of an existing installation.** None: no provider writes the variable today, Zerops keeps the crontab and
  never writes it, and Cloudflare's object keeps its alarm. The variable is additive platform protocol (ADR-0062): an
  older framework ignores it, which item 8 makes a refusal rather than a silent loss of every job.
- Both variables join `FRAMEWORK_VARIABLE_NAMES`, and the job scrubber's and the managed environment's public names.
  The highest generation needs one row in the application's framework schema, written in the seeding transaction.

## Alternatives considered

- **A cloud scheduler per job** (EventBridge Scheduler, a scheduled Container Apps job, a Kubernetes CronJob). It keeps
  jobs out of the serving process, and each run gets a container of its own. It costs a resource, an identity and a
  cold start per job and per run, a second deploy path that must follow every contract change (a job added, renamed or
  rescheduled), and a provider-specific implementation three times. It stays open to a provider that must isolate a
  job's resources; nothing in this decision forbids it.
- **A crontab inside the image** (a cron daemon beside Bun in the container). It needs a process supervisor in the
  image, every replica fires every line (the lease then turns all but one into no-ops), and a container that restarts
  skips the fires of its downtime. The wake timer already exists and coalesces what it missed.
- **Control raises the generation once a rollout is healthy**, which would keep the cloud's own rollback. Control
  reaches an application environment only on Cloudflare (the ops row, ADR-0069); a Bun application has no such path,
  and adding one for this is a larger change than giving up an automatic rollback the provider can do itself. It
  stays open once a Bun ops path exists.
- **One scheduler for the installation** (Control fires every application's jobs over an ops call). It couples every
  application's schedule to Control's availability and gives Control a new path into every application, for work the
  application can do alone.
