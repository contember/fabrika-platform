# The application Durable Object: runtime, economics and operations

A proposal, 2026-10-24: what the runtime of an application environment's Durable Object (ADR-0065) lacks for varied
internal applications, what drives its cost, and how Control should inspect, back up and recover its data. Researched
against the code, workerd's source and Cloudflare's documentation, then reviewed once by an independent model. Tags: **[V]** read in code, or documented by Cloudflare and
probed; **[D]** Cloudflare documentation, not probed by us; **[P]** needs a live probe (Phase 0). Paths are relative to
the repository.

## 1. Review of the current state

### What works

- **The author writes a runtime-neutral application and never sees the object.** The generated entry
  (`packages/app/src/build.ts:43-55`) exports `FabrikaApplication` and `createContractWorker(() => import('../src/app'),
  { migrations })`. The author's `src/app.ts` is `serve(contract, { database: scoped(tables), deps })`, the same as on
  Bun. No Durable Object type reaches application code. This is the right shape; the proposal keeps it.
- **One transaction per handler, with real rollback.** `InvocationTransaction.enclose` (`packages/db/src/database.ts:378-420`)
  runs the handler and output validation inside `ctx.storage.transaction` (`packages/db/src/sqlite.ts:188`). Nested
  transactions become savepoints. ADR-0012's promise (`docs/decisions/0012-fabrika-app-runtime.md:274`) holds on
  SQLite, and is stronger there than Postgres's READ COMMITTED.
- **Jobs, leases, fences, kicks and claims are shared code.** The runner (`packages/app/src/jobs/runner.ts`) and
  `claim` (ADR-0060) run unchanged on SQLite. Kicks coalesce through `fabrika_job_kicks.pending`. A claim is already an
  in-DB outbox with backoff (`docs/reference/application-runtime.md:743-777`).
- **Boot is guarded.** Migrations run in `blockConcurrencyWhile` before the first request
  (`packages/app/src/cloudflare/application.ts:210-219`). The hop secret is compared in constant time (`:239-242`).
  Boot checks the contract digest again.
- **Primitive facts are probed live:** rollback across awaits, the 10 s/40 s reset boundary, 1,000 transactions in
  945 ms, and 15 ms Worker→object latency (`docs/reference/cloudflare-platform.md:26-50`). The integrated runtime has not
  run on an account yet (backlog 213).

### What is missing, ranked

Ranked by impact on "authors can comfortably write varied internal apps", then on cost.

| #  | Gap                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Impact                                                 | Evidence |
| -- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ | -------- |
| 1  | **Every data-backed handler holds the whole environment while it awaits.** The enclosure opens before the handler, so an IAM call, an R2 read or write, egress, a connector call or a binding call inside the handler blocks every other event. This covers read-only queries too: they get an `Invocation` and are enclosed (`dispatch.ts:528,537`, `:986,1008`, `:1137,1142`). Framework I/O also runs inside it, e.g. `createScope` calls IAM (`dispatch.ts:751`). Exceptions: tableless procedures (`boot.ts:477`) and pre-handler authorization, admission and upload staging. Authors are not told (216/7). | High: one slow API makes the app feel broken           | V        |
| 2  | **No backup, dump, import, inspection or PITR tooling.** ADR-0065:84 sends operators to Data Studio. Control has no channel to the object: `packages/control/fabrika.config.ts` declares no app binding.                                                                                                                                                                                                                                                                                                                                                                                                          | High for any app with real data                        | V        |
| 3  | **No durable delayed work and no alarm.** Cron runs at minute granularity; reminders and claim retries wait for the job's next scheduled run. Kicks are immediate but lost on a crash between commit and dispatch (`dispatch.ts:578,942`). The schedule is the recovery path (ADR-0060).                                                                                                                                                                                                                                                                                                                          | Medium-high: reminders, follow-ups and SLAs are common | V        |
| 4  | **Long work has no home.** Job `timeoutMs` reaches 24 h (`contract/defaults.ts:52`). A DO's `waitUntil` keeps it from eviction about 15 min per promise, and alarm wall time is separately limited [D]. The default CPU limit is 30 s per invocation [D], and the bounds refuse `limits` (`provider-cloudflare/src/bounds.ts:78-99`). A job's `ctx.transaction` has no cap (216/15).                                                                                                                                                                                                                              | Medium: fails only on CF                               | V/D      |
| 5  | **Bindings reach only `deps`, untyped.** `captureEnvironment` (`implement/environment.ts:35-47`) passes them as `Record<string, unknown>`. Typing one needs a cast, which the repo forbids.                                                                                                                                                                                                                                                                                                                                                                                                                       | Medium                                                 | V        |
| 6  | **The background lane can keep the object awake.** Job retry backoff sleeps in-process for up to 5 min (`runner.ts:548-558`). Per-request `AbortSignal.timeout` deadlines are never cancelled: the handler's 10 s (`implement/bounded.ts:9-13`) and body deadlines of 30 s or more (`dispatch.ts:1558`, `implement/anonymous.ts:9`). workerd keeps timeout signals as pending timers (`src/workerd/api/basics.c++:715`). The minute `setInterval` exists only on Bun (`bun.ts:408`).                                                                                                                              | Cost risk, unmeasured                                  | V / P    |
| 7  | **The booted runtime is isolate-wide.** One `Booted` per isolate swaps a shared `storage.current` to whichever object attached last (`application.ts:135-139,171-190`). Safe today only because one object name exists (`:43`). Two objects of the class booting in one isolate would run statements on the wrong database.                                                                                                                                                                                                                                                                                       | Latent; blocks any second object (clone, scratch)      | V        |
| 8  | **`main` is not pinned to the generated entry**, and the CF deploy runs neither `fabrika app build` nor a checker. The bounds allow `workflows`, `containers` and `durable_objects` config that no generated entry exports.                                                                                                                                                                                                                                                                                                                                                                                       | Medium (integrity of digest, hop secret, scheduler)    | V        |
| 9  | **No ops visibility.** No DO wall time, transaction hold, alarm lag or queue depth reaches Operations or the console; only crashes and job failures do (`application.ts:127,157-166`).                                                                                                                                                                                                                                                                                                                                                                                                                            | Medium                                                 | V        |
| 10 | Smaller: boot re-hashes migrations per instance; a failed boot sticks for its instance (`application.ts:216-229`); the job list is derived twice (216/4); `needsMinuteTick` counts legacy collections (216/16); orphan R2 objects (216/1); raw SQL and `scan` are refused (214, 215).                                                                                                                                                                                                                                                                                                                             | Low each                                               | V        |

Corrections to common assumptions:

- **An invalid declared cron is not silently dropped.** Boot already refuses an invalid declared cron (`runner.ts:272`). The filter in
  `dueJobsOf` (`application.ts:118-121`) is dead defence.
- **"The minute tick bills the object 24/7" is not established.** The idle tick path starts no
  persistent timer. The tick itself is cheap. The risks are lingering request timers and in-process
  retry sleeps (§2).
- **"Minute granularity only" is too broad.** Kicks and in-process retries already run below a minute. What is missing
  is a durable "run at T".

## 2. Economics

Prices are from [Cloudflare's DO pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/): memory
counts as 0.128 GB, and allowances are account-wide.

**What is billed.** Duration accrues while the object runs, or while it sits idle in memory but **not hibernatable**.
An idle object that can hibernate stops accruing at once, even before it actually hibernates [D]. An object is not
hibernatable while it has a pending timer, pending I/O or `waitUntil`, an open outbound connection, a non-hibernation
WebSocket, or an in-flight request [D]. Requests cost $0.15/M over 1M per account; an alarm invocation counts as a
request. Duration costs $12.50 per started 1M GB-s over 400k. Each `setAlarm()` writes one row.

| Pattern (per environment, 30-day month)                          | DO requests |    GB-s |
| ---------------------------------------------------------------- | ----------: | ------: |
| A. Minute tick, 0.25 s wall (assumed), hibernatable after        |      43,200 |   1,382 |
| A′. Minute tick, but something keeps the object non-hibernatable |      43,200 | 331,776 |
| B. Alarm only when work is due (~1,500 wakes × 0.5 s)            |       1,500 |      96 |

For 50 environments on one account the bills come to: A ≈ $5.30, B ≈ $5.00, A′ ≈ $217.80 a month (`$5 + ceil(max(GB-s − 400k, 0) / 1M) × $12.50 + ceil(max(requests − 1M, 0) / 1M) × $0.15`, environments summed
first). These are rounded account bills. The marginal, unrounded cost of one always-resident object is about $4.15. The
owner's "about $5 a month for an object that never sleeps" is right. **The minute tick does not produce that bill.** A′
needs a hibernation blocker that outlives the minute.

**What actually drives cost in this design:**

1. **Timers that linger after a request.** An uncancelled 10 s handler deadline, or a body deadline of 30 s or more,
   adds 10–30 s of billed residency per request [P]. The fix is to clear every deadline when its work ends.
2. **In-process retry sleeps and long background work.** Fine when rare; a leak when an integration fails every run.
3. **Wall time of handlers awaiting slow I/O.** The enclosure queues other requests behind it, and they wait while
   billed.
4. **Storage.** $0.20/GB-month over 5 GB; 50 envs × 1 GB ≈ $9 a month.
5. **The minute pokes.** About 2.2M requests a month for 50 envs, about $0.30 with rounding. Noise.

**Target rule set: the object sleeps unless there is work.**

- **R1.** No `setInterval`, and no timer that outlives the work it guards. Every deadline is cleared in `finally`.
- **R2.** A wait longer than about 10 s becomes a durable wake in SQLite, never a sleeping promise. This covers retry
  backoff (§3b).
- **R3.** The alarm is armed only while durable pending work exists. It is always set to the earliest work, and set in
  the same SQLite transaction as that work.
- **R4.** No polling to discover queued work: whoever writes work schedules its run.
- **R5.** Housekeeping (sweeps, retention, repair) runs hourly or daily, never per minute.
- **R6.** A per-minute cron an author writes still works and stays cheap if the object hibernates between runs. The
  checker points at kicks when such a job only drains a queue.

So the alarm scheduler (§3b) buys **precision and durable delayed work**. Sleep comes from R1 and R2: timer cleanup and
durable backoff. Fewer ticks alone do not deliver it.

## 3. Runtime proposal

### 3a. Entrypoint and composition

Options considered:

1. Keep the generated entry and author code that knows nothing of the object.
2. Let the author extend the entry (extra exports, extra DO classes, `queue()`, a custom `main`).
3. A declared extension surface: the contract declares a queue consumer or a workflow, and the framework generates its
   export.

**Recommendation: option 1, tightened.** The object stays a framework implementation detail.

- **Pin `main`, behind a feature gate.** For framework releases at or above a new gate `pinsGeneratedEntry(release)`:
  - the bounds accept only `main: fabrika/entry.generated.ts`;
  - the CF deploy runs the application's own `fabrika app build --provider=cloudflare` after `pipeline.build`.

  The entry and the inlined migrations are then regenerated from the pinned commit. Older object releases, from 0.9
  (`runsInObject`), keep today's deploy, so an unchanged redeploy still behaves the same. This is a build-step change,
  which ADR-0062 counts as protocol; the gate keeps it additive. The motive is integrity, not distrust (ADR-0012 §8). A
  hand-written `main` silently skips the digest check, the hop secret and the scheduler.
- **No author extension points now.** The new exports are framework-owned: `alarm()` on `FabrikaApplication`, and
  the ops handler (§4). Config keys that no generated entry can serve (`workflows`, `containers`, extra
  `durable_objects`) are refused for gated releases.
- **Later (option 3), only for a concrete workload:** a contract-declared CF Queue consumer, generated as `queue()`
  forwarding into the object; a generated Workflow for long work (§3f). Requests still enter only through the proxy,
  so ADR-0022 is unaffected.
- **Composition stays a directory convention.** Slices get no lifecycle hooks: startup work, if ever needed, is a job
  woken at boot.
- **Runtime state per object (prerequisite, gap 7).** Bind the database to the invocation's object instead of a
  shared mutable pointer. The object runs each invocation inside an `AsyncLocalStorage` scope carrying its own
  storage, and the SQLite engine resolves storage from that scope. The isolate keeps one compiled implementation,
  which is pure, but never one database. Size S. It is needed by the importer's scratch objects and by the side restore
  (§4.5).

### 3b. Scheduler: one alarm over durable pending work

**Replace the minute tick with the object's alarm, armed from durable pending work, and keep an hourly repair tick.**
The design borrows from the Cloudflare Agents SDK lifecycle and from roj's `AlarmScheduler`
(`roj/packages/isolate-runtime/src/alarm-scheduler.ts`). It relies on one platform fact: on a SQLite-backed object,
`setAlarm` is part of the current transaction [D; workerd `actor-sqlite.c++:728`].

**Durable state.** One new framework table (migration bundle `fabrika`, with a SQLite and a Postgres text), plus the
existing lease table:

```sql
create table fabrika_wakes (
  id       text primary key,      -- UUIDv7, generated by the caller
  job      text not null,
  due_at   integer not null,      -- epoch ms
  reason   text not null,         -- 'cron' | 'kick' | 'claim' | 'retry'
  attempt  integer not null default 0,
  dedupe   text                   -- 'cron:<job>:<expr>', 'claim:<job>', 'kick:<job>:<due second>'
);
create index fabrika_wakes_due on fabrika_wakes (due_at);
create unique index fabrika_wakes_dedupe on fabrika_wakes (dedupe) where dedupe is not null;
```

**The alarm is a projection**, never state of its own:

```
next = min( min(due_at) over wakes whose job's lease is free or expired,
            min(expires_at) over held leases )
```

A held lease's expiry is the deadman. Every statement that changes either table (wake insert or delete, lease acquire,
renew, finish or reap) recomputes `next` in the same `transactionSync` and calls `setAlarm(next)`, or `deleteAlarm()`
when nothing is pending. On SQLite the lease store wraps each lease statement this way.

**Who writes a wake:**

| Source                        | Wake                                                                                                                                                                                                                                                                                                                                                                                    | Removed by                                                            |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Boot and repair               | One `cron` row per declared job, deduplicated on `cron:<job>:<expr>`. A missing row is inserted at the next fire. An **overdue row is kept**, so missed occurrences coalesce into one run, and `claimOverdue` still reports them. Rows of undeclared jobs, or of a changed expression, are deleted.                                                                                     | Advanced to the next fire after the run's start, at fenced completion |
| `ctx.kick(job)`               | A `kick` row due now, written in the **site's own transaction**. The post-commit `waitUntil` start stays as the fast path; the row closes today's crash gap.                                                                                                                                                                                                                            | Fenced completion of a run that started at or after `due_at`          |
| `ctx.kick(job, { at })` (new) | A `kick` row due at `at`, in the site's transaction. Several delayed kicks stay separate rows; kicks in the same second deduplicate.                                                                                                                                                                                                                                                    | Same                                                                  |
| A claim                       | After a run that claimed, one `claim` row at the earliest _eligible_ due. That earliest due is computed with the claim's own node (`packages/db/src/nodes.ts:356`): same scope, conditions and `attempts < maxAttempts`, with `<due> > now`. The row is due no earlier than now + 1 s. A claim that returned its full `limit` makes it due now. A run that claimed nothing writes none. | Replaced by the next run's computation                                |
| A failed run (CF)             | Its consumed rows stay. Their `due_at` moves to now + backoff(attempt) and `attempt` increases: a `retry`. Past the job's `retries` the run is reported failed. Cron rows advance, kick rows are deleted (the business rows remain the record, ADR-0060), and claim rows are recomputed.                                                                                                | —                                                                     |

**`alarm()`:**

1. If the maintenance mode is not `open`, return without re-arming. The maintenance operation owns the object, and
   repair runs when it reopens (§4.3).
2. For each job with due wakes, in one `transactionSync`:
   - reap an expired holder (`SQL_REAP`, `packages/db/src/job-leases.ts:118-125`);
   - `tryAcquire` (`:166-177`, which only takes a free lease) or mark the job pending;
   - re-arm from the projection.

   Wakes are **not consumed** here. They are removed only at the run's fenced completion. So a crash at any point
   leaves either the wakes or a held lease whose expiry re-arms the alarm.
3. Hand each acquired fence to the runner in `waitUntil` and return. One `alarm()` runs at a time [D], so awaiting a
   long job would delay every other wake.
4. Never throw: after 6 failures the platform stops retrying [D]. On an internal error, re-arm at now + 30 s and report
   to Operations. The repair tick covers a failed re-arm.

**Invariants:**

- **I1 – projection.** The alarm is always recomputable from the two tables, and is recomputed in the transaction of
  every change.
- **I2 – nothing consumed before it is owned.** A wake disappears only in the same transaction as the fenced
  `finish('succeeded')` of a run that started at or after it, or when its retries are exhausted.
- **I3 – deadman.** A held lease re-arms the alarm at its expiry. The alarm path reaps explicitly, because
  `tryAcquire` never surveils (`runner.ts:532-537`).
- **I4 – at-least-once, idempotent.** A doubled alarm or kick starts at most one run, because the lease admits one. The
  worst case is one extra empty run, through the pending flag.
- **I5 – bootstrap and last resort.** An hourly repair tick replaces the minute tick, at a fixed minute derived from
  the environment's name. It runs startup repair (reap, rebuild cron rows, re-arm) and costs 720 wakes a month. This is
  needed because deploying code instantiates no object (`provider-cloudflare/src/plan.ts:71-88` has no bootstrap step),
  and nothing else recovers after the alarm's retries are exhausted. When the release also serves the ops channel, the
  deploy calls `POST /__fabrika/ops/reconcile` and waits for the acknowledgement, so the first alarm exists before any
  traffic.
- **I6 – precision.** A wake never fires early (50 ms slack, because `Date.now()` is pinned between I/O). Typical
  lateness is a few seconds [P: alarm lag].

**Required tests:**

- fault injection at every boundary: after the wake insert, after acquire, mid-run, before finish, failed `setAlarm`;
- exhausted alarm retries;
- install and upgrade with zero user traffic;
- two delayed kicks at T1 < T2, where the run at T1 must leave T2;
- a scoped claim whose ineligible rows must not loop.

**Two runtimes, one port.** A shared `JobWakes` store over both dialects, with two drivers:

- **Cloudflare:** the projection, `setAlarm`, `alarm()` and the repair tick, as above. Retries move into the store
  (R2).
- **Bun/Zerops:** crontab keeps running cron jobs through `fabrika job run`, unchanged. Retries stay inline: a
  long-lived process pays nothing to sleep. The serving process sets one `setTimeout` to `next`, refreshed after its
  own writes. A delayed kick written by this process is therefore exact. One written by another container is noticed
  within that process's existing 60 s check (`bun.ts:408`). The timer starts the job through the kick path, so the
  lease admits one container. That precision difference from Cloudflare is documented.

**The provider side.** A new gate `servesAlarms(release)` controls the trigger. For releases at or above it, the
deployer writes `crons: ['<m> * * * *']` instead of `* * * * *` (`provider.ts:139-144,162`). Older releases keep the
minute tick and the `X-Fabrika-Tick` path. The tick header passes between two halves of one framework bundle, so it is
not app↔platform protocol. The trigger itself is provider config.

Rejected: a single minimum timestamp per job, which loses T2 and every reason it collapses. No tick
at all, which has no bootstrap and no last resort. Depending on the Agents SDK, which is large, AI-centric, 0.x and
duplicates our jobs.

### 3c. Queues and background work

Options:

1. In-DO rows + `claim` + kicks (exists).
2. `ctx.jobs.enqueue(job, payload)` with a payload outbox.
3. Cloudflare Queues.
4. Cloudflare Workflows.

**Recommendation: option 1, plus the durable kick, the delayed kick and the claim re-arm from §3b.** ADR-0060's
rejection of payloads stands. The business row is the record, visible to the app and its tests, and identical on
Postgres.

- **The recipe is the same on both clouds.** A mutation inserts a row with `<due>` and calls `ctx.kick('drain')`, or
  `ctx.kick('remind', { at })`. The job claims rows and does its external I/O outside `ctx.transaction`, so on CF the
  object is free during the call. `{ at }` adds no reach, so the ADR-0050 approval diff is unchanged.
- **CF Queues** only for cross-Worker fan-out. A consumer would forward into the same object, which adds a hop and no
  throughput. **Workflows** only for multi-step work longer than about 15 min. Neither now.

### 3d. Transactions

The problem: on SQLite the enclosure is the environment's critical section. On Postgres the same handler holds only
its own rows.

| Option                                                  | Atomicity kept                           | Unblocks                                         | Cost                                                                                                                |
| ------------------------------------------------------- | ---------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| A. Keep as is, cap at 25 s, document                    | yes                                      | nothing                                          | none                                                                                                                |
| B. Open the transaction lazily at the first statement   | yes                                      | only I/O before the first statement              | Deadlock risk: I/O started outside the callback while it is open waits for its end (`cloudflare-platform.md:31-37`) |
| C. **Read-only invocations without the enclosure**      | n/a (nothing to commit)                  | queries, read-only exports, downloads, IAM reads | S, plus an ADR-0012 amendment                                                                                       |
| D. Forbid outbound I/O inside write invocations         | yes                                      | forces the pattern                               | Breaks legitimate cases, such as a payment check before a write                                                     |
| E. Explicit phases for mutations (the job model)        | partly: output is validated after commit | everything                                       | Weakens ADR-0012's output-before-commit                                                                             |
| F. Optimistic concurrency without `storage.transaction` | no rollback across awaits                | everything                                       | Re-implements a transaction; rejected                                                                               |

**Recommendation: C now, plus measurement and a paved route. E only if measurements demand it.**

1. **Read-only invocations leave the enclosure on SQLite.** Each statement runs in its own synchronous
   `transactionSync`, which holds nothing across an await.
   - **The promise changes.** Today a query sees one stable view across its reads. After the change, two reads in one
     query can see different committed states. A write transaction excludes every other event, so a read never sees
     uncommitted data. This is Postgres's READ COMMITTED, which is what the Bun side already gives.
   - **ADR-0012** ("the transaction is the invocation's", `0012:274`) and **ADR-0065 §2** are amended to say so.
   - **Tests:** interleaved multi-read behaviour, cancellation, and invalidation of the session after the invocation
     ends.
   - **Read-only guard.** The data layer already refuses non-SELECT and locking nodes in a read-only session
     (`database.ts:256-258`). The missing piece is the SQLite backstop below it: the per-statement `transactionSync`
     checks the cursor's `rowsWritten` and throws, which rolls that statement back (216/12).
2. **Write invocations keep the enclosure:** atomicity, `getForUpdate` and validated output are unchanged.
3. **Measure the hold.** The enclosure records `heldMs`. Above 1 s it logs. Above a configurable threshold it reports
   a `transaction_held` event naming the site.
4. **Document the paved route in the skill.** Inside a write handler, limit I/O to the framework's own: IAM, and R2
   for the file being written. Slow external calls go through a row, a kick, and a job that calls outside
   `ctx.transaction`. The checker adds a CF note on a mutation that declares `egress` or `connect`.
5. **Cap job transactions on CF** at 25 s (216/15). This depends on probe 5: whether a timer fires inside the callback.

The author's API does not change. A query simply stops making the environment wait.

### 3e. Bindings and platform services

- **Another application:** only through connectors (`ctx.connect`), via the owner's proxy Worker. A direct service
  binding to another app's Worker would be a second enforcement path, which ADR-0022 forbids. The bounds stay as they
  are.
- **Own resources (KV, D1, extra R2, queue producer):** `deps` stays the single seam. A small module
  `@fabrika/app/cloudflare/bindings` gives structural parsers (`kvNamespace(env.CACHE)`, `r2Bucket(env.EXPORTS)`,
  `queueProducer(env.JOBS)`). Each throws at boot with the binding's name, so authors type bindings without casts.
  These are not a cross-cloud abstraction: an app using one is a CF app by choice. A portable app writes its own port
  and passes a CF or a Bun implementation from `defineDeps`.
- **Binding calls hold the environment like `fetch`** inside a write handler (§3d). The skill says so.
- **AI, Vectorize, Browser and Hyperdrive come later, one at a time.** Each is an outbound data flow the egress guard
  does not see. Admit one only once it appears as declared reach in the approval snapshot, the way `egress` does. That
  is an additive artifact change under ADR-0062.

### 3f. Long-running work, limits, boot

- **Job execution segments on CF.** 14 minutes is a conservative **framework policy**, not a platform guarantee:
  `waitUntil` only prevents eviction for up to 15 min per promise, and alarm wall time is a separate limit [D]. Today
  one run spans IAM setup, several attempts and their backoffs (`runner.ts:548-558,679,706`). The policy therefore
  bounds the whole segment: setup, one attempt, and its finish.
  - With durable retries (§3b), each attempt is its own segment.
  - Longer work is chunked through claim batches, which the full-claim re-arm turns into back-to-back runs without
    polling.
  - The deploy refuses `timeoutMs` over 14 min only for releases at or above a gate `capsJobSegments(release)`. Older
    supported releases are not rejected retroactively: their console page shows the risk instead.
  - A later escape hatch for hours-long work is a framework-generated Workflow that calls back into the object.
- **CPU:** the default is 30 s per invocation [D]. If probes show jobs hitting it, the platform (not the author) sets
  `limits.cpu_ms` on the app Worker.
- **Boot:**
  - store each migration bundle's digest in the ledger, so an attached instance compares one row instead of
    re-hashing every file;
  - compile the contract once (216/4);
  - retry a failed boot on the next request, with backoff (216/10);
  - a data migration that may run near 30 s is written as a job, and the skill says so.

## 4. Ops proposal

### 4.1 Ops channel and authorization

- **Route.** Control calls `https://<env domain>/__fabrika/ops/*`. Platform composition adds a `protocol` row for that
  prefix to the application's manifest entry, for releases at or above `servesOps(release)`.
  - **Contracts still cannot declare `protocol` rows.** This amends ADR-0022, which today allows `protocol` rows only
    in `installation: true` entries. The row is composed by trusted platform code, and the strict manifest parser gets
    tests for the new form.
  - **Rollout order:** on Cloudflare one deploy writes both. Its `deploy-worker` step deploys each generated config
    (`provider-cloudflare/src/provider.ts:424-442`): the application Worker with the key digest and the handler, and
    the platform's proxy Worker with the row. A row that reaches the proxy before the handler is live answers Control
    a 404, so the order inside the step is not load-bearing.
  - **No domain, no channel.** An environment without a domain has no ops channel, and serves no one else either.
- **Object selection.** Ops requests may name a target object from the Worker's list `FABRIKA_APPLICATION_OBJECTS`;
  ordinary traffic goes only to `FABRIKA_APPLICATION_OBJECT` (§4.5). Both are additive `FABRIKA_*` variables written by
  the deploy. Without them, the name `application` is used, as today (`application.ts:43`).
- **Credential.** Each environment gets an ops key, handled the ADR-0064 way: Control issues it, keeps it in the vault
  and rotates it; the object holds only its digest (`FABRIKA_OPS_KEY_DIGESTS`, a list). During a rotation the old and
  new digests are both accepted until the deploy that drops the old one. The object verifies the key **before boot**,
  so a broken boot can still be diagnosed and the object put into maintenance.
- **Control authorization.**
  - Actions: `data.read` (metadata), `data.content.read` (exports and row contents of every tenant in the
    environment), `data.manage` (maintenance, backup, restore).
  - Each operation is a row in a new Control table `app_env_data_operations`, beside `runs`: id, env, kind, generation,
    step, target, bookmarks, actor, timestamps. Each is audited and runs under the environment's deploy lock.

### 4.2 Control-plane view of the environment's object

The view is pulled live over the ops channel; there is no new ingest:

- database size (`sql.databaseSize`), and row counts per table capped at 100k (a full count bills rows read);
- migration ledger and framework release;
- scheduler: wake rows, the current alarm, the last alarm's lag;
- leases: last runs and outcomes;
- queue tables: waiting, due-now and dead counts;
- file states and webhook claims;
- the current bookmark and the oldest restorable time;
- the maintenance mode and generation; the last boot failure; backups.

Per-namespace requests, wall time, active time and storage come from Cloudflare's GraphQL analytics, which Control reads
with its account token. Each env has its own namespace, so this gives a per-env cost estimate [P: field names]. The
staging pending-work tracker (§5) is toggled through this channel, not through a variable.

### 4.3 Maintenance state: a quiescence barrier

Modes:

- `open`;
- `read-only`: writing endpoints answer 503 with `Retry-After`;
- `closed`: only ops requests;
- `inspect`: only ops requests, and the app never boots, so no migrations, no alarm and no jobs.

**Authority and copies.**

- The authority is Control's operation record.
- The object's durable copy is an R2 object per object name (`__fabrika/ops/<object>.json`). It is never in SQLite or
  KV, because PITR rewinds both.
- The R2 copy is written with conditional puts carrying a **generation**. Control reconciles by reading it back. R2,
  memory and Control are not atomic together, so every step is idempotent by generation.

**A transition, `POST /__fabrika/ops/state {mode, generation}`:**

1. Refuse a generation at or below the current one.
2. Synchronously, before any await, switch the in-memory mode. From that instant no new invocation of the forbidden
   class is admitted.
3. Conditionally put R2. If the put fails, the restrictive mode stays in memory and the call fails, so Control
   retries. Opening is the reverse: R2 first, then memory.
4. **Drain.** The object counts in-flight invocations per class: requests (including those still authorizing or
   uploading, `dispatch.ts:517`), webhooks, kicks, job runs and framework jobs. The stop controller, which today covers
   kicks only (`runner.ts:330,364`), is extended to every run. The object awaits the handlers' settlement, not just the
   end of their frames (`runner.ts:713`), within a bound: 25 s for handlers, plus the job abort grace.
5. Acknowledge with the count of anything still running past the bound. The external effects of such work are
   reported, not guaranteed stopped.

**The write fence.** Every invocation captures the generation when it is admitted. Each of these checks the mode and
generation **inside its own transaction**:

- the enclosure's commit;
- every framework write path: admission rows, webhook claim, the upload's pending row, job leases and fenced
  transactions, claims.

On a mismatch the transaction rolls back. The object runs one transaction at a time, so no write can slip in between
the check and its commit.

**Cold starts and deploys.**

- A cold instance reads its R2 state once. If the object is absent the mode is `open`. On an R2 error the instance
  fails closed (open question 3).
- Control refuses a deploy while the mode is not `open`, unless the deploy belongs to the maintenance operation itself
  (§4.4, §4.5).

### 4.4 Backups, exports and the importer

Two kinds of dump, kept distinct:

- **Consistent backup:** taken under `read-only` after the drain was acknowledged, or from an `inspect` object. Only a
  consistent backup is restorable.
- **Diagnostic export:** taken while the app is open. It is labelled fuzzy, and the importer refuses it.

**Producer: a pre-boot ops path, driven by Control.** The scheduler is not involved, because the useful modes
(`read-only`, `inspect`) run no app jobs, and PITR would rewind an in-database cursor.

- Control calls `POST /__fabrika/ops/export/step {op, table, after}`. Each step reads one bounded keyset page and
  uploads one R2 multipart part of at least 5 MiB, or the last part.
- The cursor, the `uploadId` and per-part checksums live in Control's operation record. A retried step replaces its
  part.
- The step code walks `sqlite_schema` and needs neither the app's boot nor framework tables. It therefore works on a
  database restored to a time before those tables existed.
- Completion writes a manifest. It holds the DDL, the migration ledger, the framework release and contract digest,
  per-table counts and sha256, the part checksums, and the bookmark.

**Lossless values.** workerd turns SQLite int64 into a double (`src/workerd/api/sql.c++:354`). Each value is therefore
projected in SQL as `(typeof(c), text)`: integers through `cast(c as text)`, blobs through `hex(c)`. The output is
gzip NDJSON. A statement is at most 100 KB while a row can be 2 MB, so the primary format is not SQL text;
`fabrika data dump --sql` renders SQL on the client.

**The importer, shipped with backups.** It is also a pre-boot ops path, writing into a fresh object.

1. Verify the manifest and checksums. Refuse a fuzzy dump.
2. Apply the framework and app migrations up to the manifest's ledger, and refuse any difference.
3. Load the tables in foreign-key order, in `transactionSync` batches. Self-referencing FKs rely on `defer_foreign_keys`
   [P]; without it, the importer refuses that schema.
4. Verify the counts and hashes, then mark the object importable for boot.

**Rehearsal.** Every scheduled backup is imported into a scratch object and verified, then the scratch object is
deleted with `deleteAll()`. A backup nobody restored is not a backup. This needs per-object runtime state (§3a) only if
the scratch object ever boots; verification itself runs pre-boot.

**Files.** The files bucket is shared by every database state, keyed `<kind>/<id>` (`files/kinds.ts:194`).

- **Tombstones instead of moves.** Removal already queues each key in `fabrika_file_deletions`
  (`packages/db/src/stored-files.ts`), and the sweep deletes the object at once. Instead the sweep deletes only keys
  queued longer than a retention window, so the queue becomes the tombstone. Moving the bytes to a `deleted/` prefix would break restored rows
  that keep their original keys (`kinds.ts:284`).
- **Restore cancels tombstones** for every key the restored rows reference, before reopening.
- **Backup retention never exceeds the tombstone window.**
- **Reserved prefix.** `__fabrika/` is reserved: the build refuses a file kind with that name.

**Schedule and pre-migration backups.**

- Control's existing `*/5` cron (`packages/control/fabrika.config.ts:67`) drives daily consistent backups. Each one is a
  brief `read-only` window: seconds for typical internal apps [P: export throughput].
- **Before a deploy that runs a pending app migration**, for releases that serve ops, Control holds one operation that
  goes: `read-only` → backup → verify → its own deploy. Migrations run in the constructor
  (`application.ts:106,133`) → `open`.
- Releases without ops support get no pre-migration backup, and the console says so.

### 4.5 Recovery flows

Three candidates for "I need data as it was at T":

1. **Side restore (the owner's flow).** Freeze, back up, import into a new object, swap the pointer, PITR the original,
   recover rows, and continue on the clone.
2. **In-place peek-then-undo.** Rewind the serving object to T, export, then restore forward.
3. **Periodic backups only.**

**Position: build (3) with a tested importer first, then (1). Build (2) only after its failure protocol is proven
live.**

Flow (2) rewinds the only serving database. Its safety rests on the forward restore succeeding, which is unprobed. An
undo bookmark that is armed before it is returned, and then lost in transit, has no specified recovery. Flow (1) never
applies PITR to the database that serves traffic, so any failure on the PITR side costs investigation time, not data or
availability. The importer that (1) needs is the same one backups need anyway. (1)'s freeze covers a consistent backup
plus an import, which is short for the tens of MB typical of internal apps [P]. (2) has no measured downtime
advantage, and it also exports a whole historical database.

**Flow (1), as built.** Everything runs as one Control operation under the deploy lock.

1. Set `read-only` and wait for the acknowledged drain (§4.3).
2. Take a consistent backup and verify it (§4.4).
3. Import into the clone `application-<op>` with the pre-boot importer, and verify it.
4. **Make the clone authoritative.** The operation's own deploy writes `FABRIKA_APPLICATION_OBJECT=application-<op>`
   and adds both names to `FABRIKA_APPLICATION_OBJECTS`. Before that, the clone's R2 state is set to `open` and the
   original's to `inspect`, so the original never boots again. The clone boots, finds an equal ledger, runs scheduler
   repair, and reopens. The service is back.
5. PITR the original, now inspector-only:
   - persist the target bookmark, the pre-restore bookmark from `getCurrentBookmark()` and a sentinel row id in the
     operation record;
   - call `onNextSessionRestoreBookmark` and `ctx.abort()`;
   - verify the expected schema and sentinel before exporting.

   A retry reconciles against the recorded state and never repeats the call blindly. A failure here leaves the
   original frozen and the clone serving.
6. Export the needed rows from the original (consistent, since nothing writes). Apply them to the clone through an
   author-written job or migration. That step is app-specific by nature.
7. **The clone stays authoritative.** "Swapping back" is a new, reconciled side restore in the other direction, never
   a pointer flip. The original is deleted after the retention period.

**Failure modes:**

| Failure                            | Consequence                                                                                                    |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Control dies mid-operation         | The env stays `read-only` or `closed`, which is safe. The operation resumes from its recorded step.            |
| The pointer deploy fails           | The original is still intact and frozen: reopen it.                                                            |
| Writes during the window           | Fenced by generation (§4.3). Webhooks get 503 and retry.                                                       |
| Two objects booting in one isolate | Prevented by per-object runtime state (§3a). The original is `inspect`, so it never boots.                     |
| Shared files bucket                | The original runs no sweep. Tombstones keep the bytes that the original's rows at T reference, for the window. |
| The original keeps billing storage | Until it is deleted.                                                                                           |

**Flow (2), later.** It becomes acceptable once Phase 0 probe 7 has exercised every failure boundary live:

- a lost undo response;
- an abort before persistence;
- a failed second restore;
- a lost reopen acknowledgement;
- whether restoring to the recorded pre-restore bookmark is equivalent to undo.

`peek`, the operation id, the target, the fallback bookmark and a sentinel are persisted externally **before** the
restore is armed. Any failure keeps the environment closed in both directions. **Whole-environment rollback to T** is
the same machinery: a consistent backup first, then PITR in place under `closed`, gated on the same probes.

## 5. Infra tooling

- **Local dev.** Lopata 0.30 already implements transactions, alarms (persisted, with retries), cron, R2 and eviction
  ([lopata](https://github.com/contember/lopata) `src/bindings/durable-object.ts`). It needs the three Lopata fixes of 216/14 so that `bun run dev` of `examples/app` serves. PITR and
  real hibernation stay live-only.
- **Test kit.**
  - A deterministic scheduler driver: `kit.clock.advance(ms)` fires due wakes, and `kit.drain()` already waits for runs.
  - Fault hooks at the scheduler boundaries listed in §3b.
  - The importer's round trip (export, import, compare) runs in Lopata.
- **CLI.** Every command goes through Control, never straight to Cloudflare:
  - `fabrika env inspect <app>@<env>`
  - `fabrika data backup [--download]`
  - `fabrika data export --sql`
  - `fabrika data side-restore --to <time>`
  - `fabrika env maintenance <mode>`
- **Checker rules (Cloudflare, gated by release).** The checker has two severities, `refusal` and `hint`
  (`packages/check/src/finding.ts`):
  - refusal: job `timeoutMs` over 14 min;
  - hint: a `* * * * *` job that only claims;
  - hint: a mutation declaring `egress` or `connect`;
  - refusal: `DEFAULT CURRENT_TIMESTAMP` (216/13);
  - hint: a migration with an unbounded `UPDATE` or `DELETE`.
- **Signals into Operations.** These reuse the ingest as events; there is no time-series store. Time series come from
  Cloudflare's analytics via Control.
  - `transaction_held` (site, ms);
  - `alarm_lag` (over 60 s);
  - `queue_stuck` (rows past `maxAttempts`, or due rows older than 1 h);
  - `boot_slow` (over 5 s);
  - `backup_failed`.
- **Staging pending-work tracker.** Enabled per object through the ops channel, in memory, and off on eviction. The
  object wraps `waitUntil` and global timers and records each pending item with its stack. The ops view answers "why is
  this object still awake". It makes rule R1 testable. It needs no
  `FABRIKA_*` variable, so it is not protocol.

## 6. Phased plan

Each phase names the probes it depends on. No phase waits for all of Phase 0.

**Phase 0 – live probes (M), on a throwaway account Worker; each result goes into `cloudflare-platform.md`:**

1. Does an uncancelled `AbortSignal.timeout` keep a DO non-hibernatable? Is a pending alarm a blocker?
2. Billed duration over 24 h from GraphQL analytics, minute cron against alarms only; record the field names.
3. `waitUntil` lifetime after a response, and for detached work from `alarm()`, separately, at 1, 5 and 15 min.
4. Alarms: `setAlarm` rolls back with `transactionSync` and `storage.transaction`; lag at p50/p99; `getAlarm()`
   inside `alarm()`; behaviour when retries are exhausted.
5. Does a timer set inside a `storage.transaction` callback fire before the callback ends?
6. The default CPU limit per alarm and per request; the effect of `limits.cpu_ms`.
7. PITR: the happy path; an abort before the undo bookmark is persisted; a lost undo response; whether restoring to an
   earlier `getCurrentBookmark()` equals undo; alarm and KV after restore; foreign-bookmark refusal; restore time at
   10 MB and 1 GB.
8. `sql.databaseSize`, cursor `rowsWritten`, `defer_foreign_keys`, and the `typeof`/`cast` projection.
9. R2 multipart from a DO; export and import throughput.
10. The account's cron-trigger limit.
11. Backlog 213's three rows, then `examples/app` with its opice suite.

**Phase 1 – sleep hygiene and correctness (S).**

- Scope:
  - cancel every request, body and report deadline in `finally`;
  - per-object runtime state (§3a);
  - 216/4, /10 and /16, and ledger digests;
  - the skill's enclosure text (216/7).
- Probes: 1.
- Protocol: none. The minute tick stays.

**Phase 2 – read-only invocations (S, independent).**

- Scope: §3d.1–4.
- ADRs: amend ADR-0012 and ADR-0065 §2.
- Probes: 8.
- Protocol: none.

**Phase 3 – ops channel, inspection, maintenance (M–L).**

- Scope:
  - ops key and rotation;
  - the platform-composed `protocol` row and the `FABRIKA_APPLICATION_OBJECT(S)` variables;
  - the pre-boot ops handler;
  - the generation-fenced quiescence barrier;
  - the Control actions, the operation table and the console page;
  - `fabrika env inspect`;
  - the pending-work tracker.
- ADRs: amend ADR-0022; new ADR "Control reaches an application environment's object".
- Protocol: additive (a new manifest row form, new variables), behind `servesOps`.
- Rollout:
  - the variables, the handler and the row arrive with the env's next deploy, which also rebuilds its proxy Worker;
  - `platform upgrade` alone changes no app (ADR-0062 rule 5), and the console says "redeploy to enable";
  - tested: a redeploy of an old pin, and an upgrade without an app deploy.

**Phase 4 – backups and importer (L).**

- Scope:
  - consistent backup and diagnostic export;
  - the importer and rehearsal;
  - tombstoned file sweep and the reserved prefix;
  - daily backups from Control's cron;
  - the guarded pre-migration backup deploy.
- ADRs: retire ADR-0065's "no bulk export"; new ADR "Data protection of an application environment on Cloudflare".
- Probes: 8, 9.
- Rollout: the tombstone needs no new table, because the deletion queue exists. The retention filter arrives with the
  app's next deploy on a gated release. The R2 retention rule is written on the env's next deploy. The commit message states both.

**Phase 5 – scheduler with durable retries (M–L).**

- Scope: all of §3b, plus the Bun driver and the test-kit clock.
- ADRs: rewrite ADR-0065 §5; amend ADR-0060 (durable and delayed kicks, claim re-arm).
- Probes: 3, 4, 5, 10.
- Protocol: none. The tick is internal and the trigger is provider config.
- Rollout, behind `servesAlarms`:
  - an app's first deploy at a gated release swaps the minute cron for the hourly repair tick;
  - the deploy's reconcile call, or the first repair tick, builds the wake rows and arms the alarm;
  - the test is a deploy plan going from a tick release to an alarm release with zero traffic.

**Phase 6 – side restore and PITR (M).**

- Scope: §4.5 flow (1), from the console and the CLI.
- Depends on Phases 3–4, and probe 7's happy path for the original's PITR.

**Later, on demand:**

- peek/undo and in-place rollback, once probe 7's failure rows pass;
- a generated CF Queue consumer;
- a generated Workflow;
- AI-style bindings as declared reach;
- a read-only SQL console.

## 7. Open questions for the owner

1. **Ops needs a domain.** An environment without a domain gets no ops channel, and therefore no backups. Accept that,
   or add a platform route for every env?
2. **Who may read data.** `data.content.read` exposes every tenant's rows in an env, through backups and the
   inspection view. Grant it to the installation's operators only, or to app owners as well?
3. **Maintenance on an R2 failure.** At a cold start, an unreadable state object fails closed with 503. Accept that
   coupling to R2's availability?
4. **Daily consistent backups by default.** Each one is a brief `read-only` window, plus the R2 cost. Make them the
   default for every Cloudflare environment, or opt-in? And what retention, which also sets the tombstone window?
5. **Long jobs.** Is 14-minute segments with chunking via claims the permanent policy on Cloudflare, or do we invest
   in the generated-Workflow escape hatch soon?
6. **Slow I/O in writes.** Is "row, then kick, then job" the permanent rule on Cloudflare, or do we plan an
   explicit-transaction mode for mutations (option E)?

## 8. How to build it

The decomposition into work units, seams, waves and agent roles is the sprint
[`../sprints/sprint-2026-10-24-application-object.md`](../sprints/sprint-2026-10-24-application-object.md).

## Deferred review findings

- The full fault-injection matrix for the quiescence barrier is not designed here; only its boundaries are listed in
  §4.3. It belongs in the Phase 3 ADR. This covers uploads cancelled mid-stream, and external effects of aborted jobs
  past the bound.
- Bun precision across containers: a delayed kick written in one container is noticed by another only within 60 s.
  There is no cross-container notification; revisit if an app needs it.
- How a pre-migration backup behaves for very large databases, where the `read-only` window grows with size, needs
  export-throughput numbers from probe 9 before a size limit or a "fuzzy plus PITR bookmark" fallback is chosen.
