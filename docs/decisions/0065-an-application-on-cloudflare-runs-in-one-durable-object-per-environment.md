---
id: 0065
title: An application on Cloudflare runs in one Durable Object per environment, over its SQLite
status: proposed
date: 2026-10-22
---

# 0065 — An application on Cloudflare runs in one Durable Object per environment, over its SQLite

## Context

A contract application on Cloudflare booted without a database: `@fabrika/db` ran on Postgres over Bun.SQL only, so
`ctx.db`, jobs, public procedures, webhooks and file kinds were refused at deploy. The paved road (`examples/crm`)
did not run on Cloudflare at all.

The framework promises an application's author more than statements. A handler runs in one transaction that commits
only after its output passed validation ([ADR-0012](0012-fabrika-app-runtime.md)); `getForUpdate` reads a row and
writes it later in the same transaction; a job's lease fences its writes; a webhook delivery completes in its
handler's transaction; a file reference is released when the transaction rolls back. All of that needs an
interactive transaction: one that stays open across the handler's awaits and rolls back as a whole.

The databases Cloudflare offers a Worker:

- **D1** runs statements and atomic batches. It has no `BEGIN`, so no interactive transaction.
- **Hyperdrive** reaches a Postgres outside Cloudflare. The data layer would stay one dialect, but every installation
  would run a database on another cloud, and every statement would cross to it.
- **A Durable Object's SQLite** runs in the object's own thread, next to its code. `ctx.storage.transaction(async)`
  is an interactive transaction: it rolls back across awaits, including a `fetch`, and the object serves no other
  event while it is open. Measured on a live account (2026-10): `BEGIN` in `sql.exec` is refused; a 10 s transaction
  commits, a 40 s one resets the object; 1000 concurrent small transactions finish in under a second; a Worker in
  Vienna reaches an object in Frankfurt in 15 ms (p50).

A Durable Object does not move, and placement cannot put a Worker next to one. A request that crosses from the Worker
to the object for every statement pays that latency per statement, and cannot hold a transaction across the calls.

## Decision

**On Cloudflare, an application environment runs in one Durable Object, which boots the application and owns its
SQLite database. The Worker only forwards each request to it.**

1. **One object per `<app>@<env>`.** The application's Worker exports the object class; its `fetch` forwards every
   request to the object named by the environment, and its `scheduled` handler forwards the repair tick (§5). The object
   boots the application once and runs every handler, job and webhook delivery itself, so a transaction never crosses
   a network hop.
2. **The invocation transaction is `ctx.storage.transaction`.** `@fabrika/db` runs on a `DatabaseEngine` of its
   dialect; the SQLite engine compiles with a SQLite compiler and opens each transaction through the object's storage.
   A row lock is not needed: the object serves no other event while a transaction is open. The handler runs inside the
   transaction's callback, from its first statement to its commit (`InvocationTransaction.enclose`): while the callback
   runs, the object's own outgoing I/O started outside it is not sent until the transaction ends, so a handler
   awaiting I/O outside the callback would wait for its own transaction to end. A transaction opened inside the callback
   nests as a savepoint (workerd's `ActorSqlite::ExplicitTxn`) and commits only with the enclosing one. A transaction
   longer than the platform's limit resets the object, so a handler keeps slow I/O out of its transaction, as it does
   on Postgres. A read-only invocation (a query, an export) is not enclosed: each of its statements runs in a
   `storage.transactionSync` of its own, which holds nothing across an await and rolls back a statement whose cursor
   reports `rowsWritten`, below the data layer's refusal of every write. The object serves other events while a query
   awaits, so two of its reads may see different committed states, as under Postgres's READ COMMITTED; a writing
   transaction excludes every other event, so a read never sees uncommitted data.
3. **The application's migrations are SQLite and run in the object.** An application on Cloudflare writes its
   migrations in SQLite; the object applies the framework bundle `fabrika` (`@fabrika/db/migrations-sqlite`) and then
   the application's bundle when it boots, in a ledger of its own, before it serves a request. Timestamps are UTC ISO
   text, booleans 0 or 1.
4. **The object answers only its own Worker.** Every forwarded request carries the environment's proxy secret, which
   the object verifies, so another Worker on the account that binds the exported class reaches nothing. Control issues
   the secret per environment because the provider declares the `ControlProvider.applicationHopSecret` capability; the
   deploy writes it as a Worker secret.
5. **Jobs run on the object's alarm, armed from durable wakes.** Every job's pending work is a row of
   `fabrika_wakes` (a `cron` row at its next fire per declared job; `kick`, `claim` and `retry` rows beside it). The
   alarm is a projection, never state of its own: the earliest due wake of a job whose lease is free or expired, or the
   earliest expiry of a held lease (the deadman). Every transaction that changes a wake or a lease recomputes it and
   calls `setAlarm` or `deleteAlarm` there; on a SQLite-backed object the alarm commits and rolls back with the
   transaction. An alarm names no object, so each object records in its KV (`fabrika:object`, outside the SQLite a dump
   carries) the name its first verified event reached it under; `alarm()` runs jobs only in the object whose recorded
   name is the one ordinary traffic reaches, and only in its `open` maintenance mode, and otherwise returns without
   re-arming. Then, per job with a due wake and in one transaction, it reaps an expired holder, takes the lease without waiting (or marks the job pending)
   and re-arms, then hands each taken lease to `waitUntil`. It consumes no wake. A run owns the wakes due when it took
   its lease, marked in that transaction (`owned`); a wake written or merged into afterwards is not its, except a cron
   wake scheduled again, whose next fire its finish schedules. Only the transaction of that run's fenced finish consumes
   or retries what it owns, and a finish or a reap leaves none owned, so a crash at any point leaves the wakes or a held
   lease whose expiry is armed. It never throws, because the platform stops retrying an alarm after six failures:
   on an internal error in `open` it re-arms 30 s later and reports `AlarmFailed` to Operations; a transition that
   restricted the object meanwhile is no error. A wake within 50 ms is waited
   for, because `Date.now()` is pinned between I/O, so no run starts before its wake. A run the alarm started retries
   durably: a failed attempt keeps its wakes, moves them to now + backoff and counts the attempt; past the job's
   `retries` it is reported failed and its cron wake advances to the next fire. Each attempt is one segment: the IAM
   exchange and the handler end before it by a finish reserve (30 s, at most a tenth), and no finish starts past it;
   the lease then expires and its reap runs the job again. An exchange the attempt stopped waiting for still counts in
   the drain, and the next attempt asks IAM afresh. The Worker's cron trigger forwards the repair tick (and
   the object repairs once when it boots): it reaps every expired holder, a removed job's too, deletes the wakes of an undeclared job or of a changed expression,
   inserts each missing cron wake at the next fire, keeps an overdue one so missed fires coalesce into one run, and
   re-arms. It arms the first alarm of an environment nobody called and recovers an alarm whose retries ran out. A kick
   writes a `kick` wake in its site's transaction, due now by the database's clock or at its `at`, so it commits with
   the writes it follows; a kick without a time also runs in the object after its commit, inline, and
   `ctx.kick(job, { at })` writes only the wake. A claim that leased rows sets its job's `claim` wake in its fenced
   transaction to the next row it could claim, at least 1 s ahead (at once after a claim that filled its limit); the
   claims of one attempt keep the earliest, and its first replaces what an earlier run left. The alarm takes no job
   whose lease holder owns every due wake, because that run consumes them, and a run failed past its inline retries
   consumes the wakes it owned. On Bun the same wakes drive one timer per serving process: a write lowers it in its
   transaction by the delay on the database's clock, the 60 s job check refreshes it and finds a wake another container
   wrote, and it kicks each job with a due wake through the kick path, so the lease admits one run; crontab still runs
   the schedule. A wake the timer was lowered for but a refresh cannot see yet, its write still committing, is looked
   for again within 15 s.
6. **Files are R2 objects.** The provider binds a bucket per application environment; the object's file store is R2.
   A kind that scans its uploads is refused on Cloudflare until a scanner runs there.
7. **`ctx.sql` runs on SQLite under text rules of its own.** A Durable Object has no roles, so the boundary under an
   application's raw SQL is what runs before and around it: workerd's authorizer (no `ATTACH`, no `PRAGMA` that writes,
   no `_cf_*` table, no transaction statement), the maintenance fence on every write, and the tag's text rules over a
   SQLite lexer (`lexSqlite` in `@fabrika/platform-node/sql`, beside Postgres's): one statement, a read or DML first
   keyword, values only as `?N` parameters it binds (a `?`, `:x`, `@x`, `$x` or `#x` the text writes is refused), and no
   `fabrika_*` or `sqlite_*` name in any spelling, a string included, because SQLite reads `FROM 'name'` as a table.
   There is no function list on SQLite: its built-ins reach nothing outside the database. A `'read'` site's statement
   runs in a `transactionSync` of its own, also inside a writing invocation, and one whose cursor reports
   `rowsWritten` rolls back and fails the invocation. An application migration runs verbatim, so the checker refuses
   one that names a `fabrika_*` table but `REFERENCES fabrika_files`, the file column's key (`cloudflare-framework-name`).
   The provider deploys a site that declares `sql` from the release that serves it (`servesRawSql`, `0.9.0-dev.5`) on
   and refuses it for an older pin, whose boot would refuse it.
8. **The platform's services stay on D1.** IAM, Control and Operations write through repository operations that are
   atomic per statement or batch ([portability surface](../reference/portability-surface.md)); they promise no
   interactive transaction, serve every application of the installation, and keep D1's export, Time Travel and
   read replicas.

## Consequences

- The paved road runs on Cloudflare: `ctx.db`, jobs, kicks, webhooks, public procedures, files and signed tokens.
- `@fabrika/db` has two dialects. Every framework statement has a SQLite text beside its Postgres one, and its tests
  run on both; the guard and the scoped query surface are shared.
- An application environment's throughput is one object's: one thread, about a thousand small requests a second.
  An application that needs more is not served by this road.
- An environment's data lives in one location, chosen when the object is first created; moving it is an export and an
  import.
- Operators read an environment's data in the dashboard's Data Studio. Control exports, backs up and imports an
  object's SQLite over the ops channel
  ([ADR-0070](0070-data-protection-of-an-application-environment-on-cloudflare.md)).
- Local runs and tests need Lopata 0.30 or newer, which implements an object's `storage.transaction` over
  `bun:sqlite` and nests it as workerd does.
- The object runs from framework 0.9. An application on an older release keeps its stateless Worker: Control names the
  release it read the application with, and the deployer gives that Worker no object, bucket, tick or hop secret, and
  refuses what it cannot run (jobs, webhooks, public procedures, installation mail, token purposes), as before
  ([ADR-0062](0062-a-platform-release-serves-older-framework-releases.md)). On its first deploy at 0.9 the provider adds
  the object class, its migration and the bucket.

## Alternatives considered

- **D1 with batches.** Loses the interactive transaction the framework promises; every handler would have to be a
  single batch, which `getForUpdate`, fenced jobs and validated output cannot be.
- **Hyperdrive to an external Postgres.** Keeps one dialect, but needs a database outside Cloudflare and a network
  hop per statement; deferred, not rejected, for applications that already run a Postgres.
- **The Worker handles the request and calls the object per domain operation.** Fewer round trips than per
  statement, but no transaction spans two calls, so the handler's transaction cannot be the object's.
- **Placing the Worker next to its object.** Placement hints move a Worker towards a backend it calls, not towards a
  Durable Object, and do not affect a call to one.
