---
id: 0060
title: A handler kicks a declared job after its commit
status: accepted
date: 2026-10-20
---

# 0060 — A handler kicks a declared job after its commit

## Context

An application sends an e-mail, or does any other slow or external work, from a cron job. A handler writes a row
into an outbox table, and the next run of the job takes the row. The paved-road sprint recorded this as "no
`ctx.jobs.enqueue`: jobs are cron only, so the outbox is a row the next run picks up"
([archive](../archive/sprint-2026-10-11-paved-road-core.md), decision 5). The outbox row is the only record of the
work, so a crash loses nothing: the next run finds the row.

The cost is latency. A cron job runs at most once a minute, so an e-mail queued by an ordinary endpoint waits up to a
minute. A person who clicks "send" sees nothing happen.

Framework 0.5 closed the gap with `then: '<job>'` on a form and on a mutation: after the commit, the framework kicked
the named job. `then` made the framework perform an operation the declaration names, and the handler had no say: it
could not skip the kick when it wrote nothing, or kick two jobs. A webhook and a job could not kick at all.

Every outbox drain then took its rows in raw SQL (`sql: 'write'`, `for update skip locked`, an attempt counter, a
backoff column), because the data layer had no operation for it. Each application wrote the same statements again,
off the road.

A declaration states the surface and the reach of the code behind it, never an operation
([ADR-0012](0012-fabrika-app-runtime.md) §9). A kick fits that rule when the declaration bounds it and the handler
performs it.

## Decision

**A site declares the jobs it may kick (`kicks: ['<job>']`), and its handler calls `ctx.kick('<job>')`. The framework
sends each kicked job once, after the site's transaction committed, and nothing on a rollback. A kick carries no
payload: the row it looks at is the only record. A job drains its rows with the data layer's `claim`.**

### 1. The declaration

- `kicks` is a list of cron jobs of the same contract. A mutation (credentialed, public or of a link mount), a
  webhook and a cron job may declare it.
- The build and the checker refuse an unknown job (with a suggestion), a job that is not a cron job, a duplicate name,
  and `kicks` on a read-only site (a query, a read-only export).
- The kick edges between jobs are acyclic: a job never kicks itself, directly or around a cycle.
- `kicks` is declared reach (`ContractArtifact.declared[<site>].kicks`, sorted, absent unless declared). The approver
  sees each edge ([ADR-0050](0050-approved-access.md)). A new edge is a neutral line: it reaches only a job of the
  same approved contract, which runs under its own declared actions. From a public procedure it widens with closer
  review, because anyone who calls the procedure then decides when the job runs.

### 2. The call and when the kick runs

- `ctx.kick('<job>')` is bound to its request and accepts only a declared name; another name is refused
  (`undeclared_kick`). It records the job; several calls of one job in one invocation send one kick.
- The dispatcher sends the recorded kicks only after the output validated and `invocation.commit` succeeded, through
  the request's `waitUntil`. The answer does not wait for the run.
- A thrown handler, a refused output, a cancelled request and a failed commit kick nothing.
- A procedure without a transaction kicks once its answer is built. A job's kicks are sent after its lease is
  released, so a job that kicks a job behind it never waits on its own lease.
- A kick starts one run under the job's own key, takes the lease without waiting, and sets the shared flag
  `fabrika_job_kicks.pending` when another run holds the lease. So at most one run is active and one pending,
  whatever the number of kicks and instances. A kick never rejects.
- The schedule stays the recovery path. A kicked run that dies before its commit leaves its rows to the next scheduled
  run.

### 3. Claim is the drain

A table policy declares `queue: { attempts: '<column>', due: '<column>', maxAttempts? }` and a `version` column. A
row is waiting while `<due>` is set, and done when it is `null`. A job claims through the capability it would read
the table with: `ctx.db.app('<action>').<table>.claim({ limit })` for an application table,
`ctx.db.over(ctx.within('<action>', '<dimension>')).<table>.claim({ limit })` for a dimension-scoped one.

- **A claim is a lease.** It runs in a short transaction of its own, fenced by the job attempt's lease, and commits.
  It selects rows with `<due> <= now()` and attempts below `maxAttempts` (10 by default), `for update skip locked`,
  increments the attempts and moves `<due>` by the backoff: the job's schedule period (one minute without one),
  doubled per earlier claim, at most 30 days. `limit` is required, at most 500: attempts count claims, so a run
  claims only what it will reach.
- **Each claimed row answers its columns, its new `version` and `row.ref`**, a capability bound to that row for the
  table's `update` action.
- **The work runs after the lease, one transaction per row.** The job finishes a row through `tx.db.on(row.ref)`:
  `.update(values, { expectVersion, done: true })` writes and clears `<due>` in one statement, `.remove({
  expectVersion })` deletes the row with the table's `delete` action, and `.requeue({ at? })` makes it due again with
  no attempts.
- A failure or a crash leaves the row as the claim left it, due again after the backoff; nothing retries at once. One
  job run at a time (the lease above) keeps two runs off one row.
- `claim` runs only in a job, and is refused inside `ctx.transaction`: there a failure would roll back the lease and
  retry the row at once.
- A row past `maxAttempts` stays in the table, not due, for the application to show or requeue.

`insert(values, { onConflict: { columns, do: 'nothing' | 'update' } })` is the idempotent write a redelivered webhook
or a repeated run needs: `columns` must be a unique index the migrations create (the checker's `on-conflict-index`),
`'nothing'` needs the `insert` action, and `'update'` also needs the `update` action and writes only the table's update
columns. It answers whether the row was inserted.

### 4. Tests and shutdown

- The test kit tracks every kicked run. `kit.drain()` waits for them, `kit.runJob` drains before it runs, and each
  generated access test drains before it returns its outcome. So a test never closes the database under a kicked run.
- On SIGTERM, a Bun server aborts its kicked runs first. A stopped run frees its lease as failed, logs that the
  schedule runs it again, and sends no report to Operations: it is not a failure of the application. Then the server
  stops accepting requests and waits for its remaining background work for at most 10 seconds before it closes the
  database. `fabrika job run` does not take this path.

## Consequences

- The mail leaves within seconds instead of up to a minute.
- A kick costs at most one coalesced run. A run that finds nothing to do ends at once.
- An outbox, a per-record reminder (`<due>` is the reminder time) and asynchronous work (a mutation inserts a request
  row and kicks; the job claims it, writes the result into a file column and finishes the row) share one recipe on the
  road. A drain no longer needs `sql: 'write'`.
- The backoff a kicked drain needs is the claim's: a burst of kicks cannot spend a row's attempts during a short
  provider outage, because a claimed row is not due again before the backoff.
- A crash between an external call and the row's update repeats the call after the backoff. The external side must
  be idempotent: a mail transport drops a repeat by its idempotency key ([ADR-0019](0019-portable-outbound-email.md)).
- A test that asserts a queued state between a mutation and `runJob` races the kicked run. It must arm its faults
  before the mutation, or drain the kit first.
- A kicked run on a stopping process does not finish; the next scheduled run does its work. With a one-minute
  schedule, that is a delay of up to a minute after a deploy.
- The 10-second drain bound is a guess. Zerops' stop grace period is not verified.
- The build and the checker refuse a kick that names no job. The contract's types check `ctx.kick` against the site's
  own `kicks`, not against the contract's jobs: walking nested groups costs too much of the compiler's budget.
- A 0.4, 0.5 or 0.6 application keeps its `then`: Control reads it with that release's reader and the platform keeps
  serving it ([ADR-0062](0062-a-platform-release-serves-older-framework-releases.md)).

## Alternatives considered

### Keep `then: '<job>'`

A static `then` makes the framework kick on every commit, whether the handler wrote a row or not, and names one job.
It is an operation in the declaration. `kicks` bounds the same reach and leaves the decision to the handler.

### Keep cron only, with a shorter schedule

One minute is the finest schedule both clouds offer. A shorter interval would still leave a visible delay, and it
would run every job continuously while nothing is queued.

### A durable typed queue: `ctx.jobs.enqueue(job, payload)`

A payload makes the kick a queue: a second record beside the business row, and a new subsystem. It wins when work must
outlive its business row, or when the rows become a throughput problem. Neither holds now; the row plus `claim` covers
an outbox, a reminder and a report.

### The claim inside the work's transaction

Simpler, but a failure rolls back the backoff and retries the row at once, and its locks stay held through the work.
A lease committed on its own, then one transaction per row, keeps the backoff and the locks short.

### A `done` state declared per table

One more column name in the policy, and the claim still needs `<due>`. `<due>` set to `null` with `done: true` is the
same state in one column.

### Kick from the handler, before the commit

The run could start before the row is visible and find nothing, or kick for work that then rolls back. Kicking after
the commit means a run always sees what the site wrote.

### Let the shutdown finish the kicked runs

A kicked run can take as long as the provider it calls. Waiting for it can exceed the platform's stop grace period,
after which the process is killed mid-run and the lease expires as `crashed`. Stopping the run frees the lease at once
and leaves the work to the schedule, which recovers it anyway.
