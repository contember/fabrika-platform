---
id: 0060
title: A mutation kicks a cron job after its commit
status: accepted
date: 2026-10-15
---

# 0060 — A mutation kicks a cron job after its commit

## Context

An application sends an e-mail, or does any other slow or external work, from a cron job. An endpoint writes a row
into an outbox table, and the next run of the job takes the row. The paved-road sprint recorded this as "no
`ctx.jobs.enqueue`: jobs are cron only, so the outbox is a row the next run picks up"
([archive](../archive/sprint-2026-10-11-paved-road-core.md), decision 5). The outbox row is the only record of the
work, so a crash loses nothing: the next run finds the row.

The cost is latency. A cron job runs at most once a minute, so an e-mail queued by an ordinary endpoint waits up to a
minute. A person who clicks "send" sees nothing happen.

Forms already solved this for their own submissions. `then: '<job>'` on `c.form` names a cron job of the same
contract. Once a submission's row committed, the form kicks that job: the serving process starts one run in the
background, under the job's own key, through `waitUntil` where the runtime has one. A kick carries no payload. The
shared flag `fabrika_job_kicks.pending` coalesces kicks, so at most one run is active and one pending, whatever the
number of submissions and instances. The schedule stays the recovery path
([`reference/application-runtime.md`](../reference/application-runtime.md)).

An endpoint cannot do the same. The dispatcher hands the execution context only to forms and to the failure report,
so a mutation's handler has nothing to kick with, and nothing declares that it would.

## Decision

**A mutation may declare `then: '<job>'`. After its transaction commits, the framework kicks that cron job exactly as a
form's `then` does. The kick carries nothing; the outbox row stays the record.**

### 1. The declaration

- `then` is a static field on a mutation of an RPC or link mount. It names one cron job of the same contract.
- It is optional. When it is absent, the artifact has no `then` key, so the digest of every existing contract stays
  the same.
- The build and the checker validate it like a form's `then`: an unknown job is refused with a suggestion, and a job
  that is not a cron job is refused.
- They refuse `then` on a query, on a read-only site, on an export procedure, on a webhook and on a cron job.
- `then` lives in the site's declared reach (`ContractArtifact.declared`). The approver sees it beside `sql`,
  `connect` and `issues`. Like a form's `then`, it widens nothing: it reaches only a job of the same approved
  contract, which runs under its own declared actions ([ADR-0050](0050-approved-access.md) §3).
- It gives the handler nothing. There is no `ctx.kick()` and no `ctx.jobs.enqueue`.

### 2. When the kick runs

- The dispatcher kicks only after `invocation.commit` succeeded, through the request's `waitUntil`. The answer does
  not wait for the run.
- A thrown handler, a refused output, a cancelled request and a failed commit kick nothing.
- A procedure without a transaction kicks once its answer is built.
- The kick takes the form's path: one run under the job's key, the lease taken without waiting, and the pending flag
  set when another run holds the lease. A kick never rejects.
- The schedule stays the recovery path. A kicked run that dies before its commit leaves its rows to the next scheduled
  run.

### 3. Tests and shutdown

- The test kit tracks every kicked run. `kit.drain()` waits for them, `kit.runJob` drains before it runs, and each
  generated access test drains before it returns its outcome. So a test never closes the database under a kicked run.
- On SIGTERM, a Bun server aborts its kicked runs first. A stopped run frees its lease as failed, logs that the
  schedule runs it again, and sends no report to Operations: it is not a failure of the application. Then the server
  stops accepting requests and waits for its remaining background work for at most 10 seconds before it closes the
  database. `fabrika job run` does not take this path.

## Consequences

- The mail leaves within seconds instead of up to a minute.
- A kick costs at most one coalesced run. A run that finds nothing to do ends at once.
- **An outbox needs a per-row backoff.** Before kicks, the cron interval spaced the attempts of a failing row by a
  minute or more. Kicks remove that spacing: a burst of mutations can start several runs within seconds, and each run
  takes another attempt. A row with a fixed attempt limit can spend all its attempts during a short provider outage.
  An outbox row therefore records when it may be tried again (for example `next_attempt_at`), each run takes only due
  rows, and the first wait is at least one cron tick. How often an e-mail is retried also follows its transport's
  capabilities ([ADR-0019](0019-portable-outbound-email.md)).
- A test that asserts a queued state between a mutation and `runJob` now races the kicked run. It must arm its
  faults before the mutation, or drain the kit first.
- A kicked run on a stopping process does not finish; the next scheduled run does its work. With a one-minute
  schedule, that is a delay of up to a minute after a deploy.
- The 10-second drain bound is a guess. Zerops' stop grace period is not verified.
- One job per mutation. A list of jobs can be added later without breaking an existing contract.
- A webhook cannot kick a job, and a job cannot kick another job. Neither has a current need.
- The build and the checker refuse a `then` that names no job. The contract's types do not: walking nested groups for
  a type-level check costs too much of the compiler's budget.

## Alternatives considered

### Keep cron only, with a shorter schedule

One minute is the finest schedule both clouds offer. A shorter interval would still leave a visible delay, and it
would run every job continuously while nothing is queued.

### `ctx.kick()` or `ctx.jobs.enqueue(payload)` in the handler

A call in the handler is not declared. The approver cannot see it, and the checker cannot check the job's name. A
payload also makes the kick a queue: a second record beside the outbox row, lost when the process dies before the run
takes it. The static `then` keeps the outbox row the only record and needs no new storage.

### Kick from the handler, before the commit

The run could start before the row is visible and find nothing, or kick for work that then rolls back. Kicking after
the commit means a run always sees what the mutation wrote.

### Let the shutdown finish the kicked runs

A kicked run can take as long as the provider it calls. Waiting for it can exceed the platform's stop grace period,
after which the process is killed mid-run and the lease expires as `crashed`. Stopping the run frees the lease at once
and leaves the work to the schedule, which recovers it anyway.
