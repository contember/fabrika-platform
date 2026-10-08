# Scheduled jobs

A proposal for cron work in Fabrika applications. It is part of the
[opinionated application framework](opinionated-app-framework.md). Background work has no request and no user, so it
is where an agent reaches for an unscoped database handle "because there is nobody to check".

v1 covers **cron jobs only**. Tasks enqueued by a request are a later phase (see the end). v1 is Zerops-only,
because jobs depend on the Postgres [data layer](scoped-database-access.md).

## What exists today

- **Zerops:** `run.crontab` in the application's own `zerops.yaml` runs a shell command inside the container on a
  schedule. `allContainers` is required and has no default. The command bypasses the proxy, carries no token, and
  holds the full database credential of the container. Its output is not collected.
- **Cloudflare:** a cron trigger calls the Worker's `scheduled()` handler, also without a token.
- The application framework has no job concept; the platform's own services each hand-roll one.

## Threats

1. A job runs with everything the process can reach, so "clean up old notes" becomes "read and modify every
   workspace" with no record of why.
2. An agent adds a cron line or a background loop in `zerops.yaml` (`run.start: "bun loop.ts & bun server.ts"`)
   and none of the rules below apply to it.
3. A run overlaps the previous one, or is retried while it is still running, and does the work twice.
4. A failing job fails silently.

## Every job declares what it may do

```ts
jobs: {
	purgeDeleted: c.cron('0 3 * * *', {
		actions: ['notes.delete'],
		scope: 'app', // every workspace; shown when the change is approved
		timeout: '10m',
		retries: 2,
	}),
	weeklyDigest: c.cron('0 7 * * 1', {
		actions: ['notes.read'],
		scope: 'app',
		timeout: '30m',
	}),
},
```

- A job handler receives `ctx` like a machine caller: `ctx.within` for its declared actions (action-bound, like
  every `Within`), the scoped data layer, the file API. It does not receive an unscoped database handle.
- In part A the framework constructs `ctx.within` in process from the job's declaration. With platform enforcement
  the job runs with its own workload credential, narrowed by IAM to the declared actions and scope, with an
  audience fixed to its own application and the principal kind `job`, which no mount accepts. A job key therefore
  cannot call the application's own `machine` mount. All credentials share the container environment, so the
  separation between jobs is in-process only.
- There is no unscoped handle for jobs in v1. A raw handle cannot be fenced: a long statement submitted before
  the lease expired still commits after a retry took over. Data repairs are an operator task (a reviewed SQL
  migration), not a job.
- A job cannot create scopes, manage members or issue share links.

## Triggering and running

| Concern  | Zerops                                                                                                         | Cloudflare (later)                                                   |
| -------- | -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Trigger  | one `run.crontab` entry per job, each `fabrika job run <name>`, with `allContainers: false` written explicitly | cron triggers from the contract (5 per account on Free, 250 on Paid) |
| Identity | part A: built in process; part B: the runner mints the job's credential through IAM over HTTPS                 | through the IAM binding                                              |
| Output   | the runner reports start, end, failure and duration to Operations                                              | the same                                                             |

- In part A the template's `zerops.yaml` carries the crontab entries, and the checker verifies that they match the
  contract's jobs exactly: one entry per job, the generated command, `allContainers: false`, no other entry, no
  background process in `run.start`.
- With platform enforcement the provider generates the run section, and an authored `run.crontab`, `run.start` or
  `run.initCommands` is refused.
- **Fencing.** A run takes a lease row keyed by the job, with a generation number. Every write the job makes
  through the data layer is in a transaction that checks the generation, so a run that lost its lease cannot commit
  afterwards. A new run does not start while a previous run holds the lease. A run that outlives its `timeout` is
  cancelled and recorded as failed.
- **Retries** with jittered backoff up to `retries`, then a failed state.
- **Visibility.** Every run and failure is reported to Operations under the application's coordinates, and a job
  that has not succeeded within twice its period raises an alert.

## Changes that wait for approval

With platform enforcement, these job changes wait for a human on a protected environment:

| Change                                      | Waits on a protected environment |
| ------------------------------------------- | -------------------------------- |
| A new job with actions                      | yes                              |
| A job gaining an action, or a wider `scope` | yes                              |
| A changed schedule, timeout or retry count  | no (not access data)             |
| A job removed, or an action removed         | no                               |

## Framework (part A)

What the framework gives on today's platform:

- the job runner, leases and generation-fenced writes; `ctx` like a machine caller, with `ctx.within` built in
  process for the declared actions; Operations reporting and the missed-run alert;
- the checker: the template's crontab matches the contract; no `setInterval`, self-scheduled timers or long-lived
  loops as a substitute for a job;
- the agent skill: "background work is a job in the contract"; ask the human before giving a job an action; data
  repairs go to the operator, not into a job.

## Platform enforcement (part B)

What [platform enforcement](platform-enforcement.md) adds:

- the generated crontab and the refusal of authored run sections;
- a workload credential per job, principal kind `job`, reconciled by IAM from the approved contract;
- job changes wait for approval on protected environments.

## Later: tasks enqueued by a request

Not in v1. A task is a delegation of a user's authority into the future, and that needs more than a queue:

- A task receives only the action-bound `Ref`s the enqueuing request held, and no `ctx.within`.
- The task row records the requester and is authenticated (signed by the framework at enqueue, with a key the
  application code does not hold); at run time the framework re-checks the requester's **live** permission on each
  `Ref`, so revoking a member also stops their pending exports, and a forged row naming an administrator is
  refused.
- The task row is written in the same transaction as the request's other writes (an outbox). On Cloudflare that
  needs a database outbox and a relay; a Queue send cannot join a transaction.
- Delivery is at least once, so task handlers must be idempotent.

## Open questions

- Long-running jobs beyond the platform's limits: split by cursor across runs, or out of scope?
- Should the alert threshold be per job?
