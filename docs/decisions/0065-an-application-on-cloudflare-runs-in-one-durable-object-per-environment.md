---
id: 0065
title: An application on Cloudflare runs in one Durable Object per environment, over its SQLite or Postgres through Hyperdrive
status: proposed
date: 2026-10-22
---

# 0065 — An application on Cloudflare runs in one Durable Object per environment, over its SQLite or Postgres through Hyperdrive

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
- **Hyperdrive** reaches a Postgres outside Cloudflare through a pooler in transaction mode. The data layer stays one
  dialect with Zerops, and a transaction is a real Postgres transaction that holds one origin connection from `BEGIN`
  to `COMMIT`. But every installation that uses it runs a database on another cloud, every statement crosses to it,
  and the pooler keeps nothing a session would: it resets session `SET` at the end of each transaction and does not
  support advisory locks, `LISTEN` or SQL-level `PREPARE`; startup parameters are not documented.
- **A Durable Object's SQLite** runs in the object's own thread, next to its code. `ctx.storage.transaction(async)`
  is an interactive transaction: it rolls back across awaits, including a `fetch`, and the object serves no other
  event while it is open. Measured on a live account (2026-10): `BEGIN` in `sql.exec` is refused; a 10 s transaction
  commits, a 40 s one resets the object; 1000 concurrent small transactions finish in under a second; a Worker in
  Vienna reaches an object in Frankfurt in 15 ms (p50).

A Durable Object does not move, and placement cannot put a Worker next to one. A request that crosses from the Worker
to the object for every statement pays that latency per statement, and cannot hold a transaction across the calls.

One object is one thread and about a thousand small requests a second, and its data lives in one location, read only
over the ops channel. An application that already runs a Postgres, or needs more throughput than one object, or wants
its data in a database its operator queries and backs up with ordinary tools, is not served by the object's SQLite.

## Decision

**On Cloudflare, an application environment runs in one Durable Object, which boots the application and owns its
SQLite database. The Worker only forwards each request to it. An application that chooses Postgres in its config runs
instead in a stateless Worker over Hyperdrive, and its object only runs its jobs (§10).**

Decisions 1–9 describe the SQLite environment, the default; §10 says what differs on Postgres.

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

9. **The SPA's files are Workers Assets the deploy stages.** Workers Assets gives a Worker one directory, and a
   contract may declare several SPA and link mounts, each with a build directory of its own. When the application
   Worker declares no `assets`, the deploy binds `ASSETS` to a directory beside its config and, after the
   application's build, copies each mount's directory into it at the mount's prefix, the most specific mount owning a
   path, without what the mount's own `.assetsignore` excludes (wrangler's rules, which read only the uploaded
   directory's root) and without version control metadata; the object asks the binding for the request path as it is, and for a path that names no file for the mount's
   `index.html`. A Worker that declares its own `assets` keeps them.

10. **An application may choose Postgres through Hyperdrive.** `defineApp({ id, database: { kind: 'postgres',
    provisioningSecret: '<SECRET>' } })`, an object literal (directly or through a `const`), so the checker and
    Control read it statically; a `database` the config names only when it loads (a spread of a function's result) is
    refused by the CLI and the deployer, which load the config. The secret is an
    application secret the operator sets per environment in Control's vault: the direct (non-pooler) URL of a role
    that may create roles. Then:
    - **The Worker serves every request itself**, over the `FABRIKA_DATABASE` Hyperdrive binding, with Smart Placement
      so it runs near the database. The generated entry is `cloudflare-postgres` (`@fabrika/app/cloudflare-postgres`):
      the isolate boots the application once, each request opens its own postgres.js client and ends it when the
      work it handed to `waitUntil` settled. A handler's transaction is a Postgres transaction, as on Zerops, so
      there is no 25 s handler cap; the database's own statement limit (Hyperdrive's 60 s) stays. The isolate has no pool
      of its own, so the public procedures' in-flight share (ADR-0063 rule 1) is two calls per isolate, as on the object.
    - **The schema is the runtime role's default `search_path`.** Hyperdrive documents no startup parameters and pools per
      transaction, and the data layer names its tables unqualified, also in autocommit statements, so neither a
      startup parameter nor `SET LOCAL` reaches every statement. Provisioning sets `ALTER ROLE run_<id> SET
      search_path TO app_<id>` in the transaction that resets the role's defaults, and the engine
      (`@fabrika/db/hyperdrive`) checks `current_schema()` on each connection, on the event that reserved it, until one
      check of the isolate passed, and refuses every statement after a mismatch. An event never waits on another event's
      check, whose I/O belongs to that event. Every statement runs unprepared, because the next transaction may get another origin connection,
      and binds each parameter with the type Bun.SQL gives it, so a statement answers as it does on Zerops.
    - **The object keeps the class and binding names and runs only the jobs.** A request's kick writes its wake in the
      request's transaction and runs nothing in the Worker (`kickRuns: 'scheduler'`); once the request's work settled,
      the Worker sends the object one wake notice with the earliest wake its writes left, and the object lowers its
      alarm to it, never raising it. The alarm takes each due job's lease and runs it, then arms the next wake from
      the database, at most a minute ahead while the contract has a job, so a notice that was lost still runs within
      it. The repair tick and the 14-minute job segment are as on SQLite. The object answers only its Worker.
    - **The deploy provisions the database before it deploys.** A step `provision-database` runs the application's
      own `fabrika db migrate` in the runner with the provisioning URL as `FABRIKA_APP_DATABASE_URL` (never on an
      argv, never in a log), which creates the roles `app_<id>` and `run_<id>`, sets the default and migrates; then it
      creates or replaces the Hyperdrive config `<env>-<app>-database` over the runtime role, its password derived as
      on Zerops, with caching disabled. The provisioning URL never reaches the Worker; the runtime password reaches
      only the HTTPS body of that API call. The Worker gets the binding and nothing else of the database.
    - **Control approves the database.** The access snapshot records `database: 'postgres'`, read statically from
      `fabrika.config.ts` at the application's root; the provider refuses Postgres below the framework release that
      serves it (`0.9.0-dev.9`), for an environment that deploys another config file (its artifact's `configPath`),
      and once an environment published a snapshot its database never changes. The deployer refuses a config that
      disagrees with the approval.
    - **The application's own CLI writes the Postgres entry only when the deploy asks for it.** The deployer runs
      `fabrika app build --provider=cloudflare --database=postgres` for an environment it composed on Postgres, and
      nothing new for one on SQLite. Control compares an application's release with its own by major.minor.patch
      only, so a platform release before `0.9.0-dev.9` accepts an application pinned to it, reads no `database` and
      composes none; its deployer never passes the option, and the application's CLI refuses the build instead of deploying a
      Postgres entry without its database. A local `fabrika app build` passes the option itself.
    - **No ops channel and no data operations** ([ADR-0069](0069-control-reaches-an-application-environments-object.md),
      [ADR-0070](0070-data-protection-of-an-application-environment-on-cloudflare.md)): no ops row, no ops key, no
      barrier, no migration phase. Backups, exports and recovery are the database provider's. Control answers the
      environment's data views and operations `not_served` (409) from the provider's answer, before any request.

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
- An application declares no `assets` for its SPA. An existing environment converges on its next deploy: a Worker
  without `assets` gets the staged directory, and one whose committed config declares `assets` keeps serving from it.
  The staged layout is the request path, which an older object asks for unchanged, so only the `index.html` of a deep
  link needs the framework that asks for `<prefix>/`.
- An application on Postgres through Hyperdrive scales as the stateless Worker and its database do, keeps its data
  where the operator's Postgres keeps it, and pays a network hop per statement (Smart Placement is meant to shorten it) and one
  connection plus postgres.js's type-catalog query per request. Each environment needs a Postgres cluster of its own:
  the roles `app_<id>` and `run_<id>` are named by the application only, so two environments of one application on
  one cluster would share them. Moving an environment between SQLite and Postgres is a new environment.
- Hyperdrive's behaviour that §10 rests on is recorded in [Cloudflare platform](../reference/cloudflare-platform.md#hyperdrive);
  what is not verified on a live account is listed there.
- Rollout of an existing installation: nothing converges, because nothing an existing environment runs changes. An
  application on SQLite deploys as before: the new config keys are written only for a Postgres runtime, and its access
  snapshot and digest are byte-identical. An existing runtime role on Zerops gets its default `search_path` on its
  next `fabrika db migrate`, which every deploy runs, and the Bun.SQL startup parameter sets the same one meanwhile.
  The Hyperdrive config is created by an environment's first Postgres deploy and replaced in place by later ones; a
  removed environment's config stays until the operator deletes it. The installation's Cloudflare API token needs
  the Hyperdrive Edit permission before the first Postgres deploy. A Control rolled back below the release that reads
  `database` cannot parse the snapshot of a Postgres environment. That environment's deploys fail, and so does every
  read that parses the snapshots of several environments: the environment listing of that application, the connector checks of deploys into an
  environment of the same name, and the republish of its namespace. They work again once the environment is removed
  or Control is upgraded. SQLite environments' snapshots parse as before.
- The object runs from framework 0.9. An application on an older release keeps its stateless Worker: Control names the
  release it read the application with, and the deployer gives that Worker no object, bucket, tick or hop secret, and
  refuses what it cannot run (jobs, webhooks, public procedures, installation mail, token purposes), as before
  ([ADR-0062](0062-a-platform-release-serves-older-framework-releases.md)). On its first deploy at 0.9 the provider adds
  the object class, its migration and the bucket.

## Alternatives considered

- **D1 with batches.** Loses the interactive transaction the framework promises; every handler would have to be a
  single batch, which `getForUpdate`, fenced jobs and validated output cannot be.
- **Hyperdrive as the only database.** Keeps one dialect, but needs a database outside Cloudflare and a network hop per
  statement for every application. It is the choice §10 offers, not the default.
- **On Postgres, the handlers in the object over Hyperdrive.** Keeps one shape for both databases, but the object's
  thread and location would bound an application that chose Postgres to scale past them, and every statement would
  cross from the object's fixed location.
- **A per-transaction `SET LOCAL search_path`.** Many framework statements run in autocommit (leases, wakes,
  admissions, stored files), outside any transaction the engine opens, so a transaction-local setting misses them.
- **Schema-qualified statement texts.** The framework's fixed texts and `ctx.sql` name tables unqualified by design,
  and an application's raw SQL could not be rewritten safely; the role's default reaches all of them.
- **The Worker handles the request and calls the object per domain operation.** Fewer round trips than per
  statement, but no transaction spans two calls, so the handler's transaction cannot be the object's.
- **An `ASSETS` binding the application declares, which the checker or the deploy requires.** It cannot serve two
  mounts with different directories from one Worker, and it leaves each application to repeat a line the contract
  already implies.
- **Placing the Worker next to its object.** Placement hints move a Worker towards a backend it calls, not towards a
  Durable Object, and do not affect a call to one.
