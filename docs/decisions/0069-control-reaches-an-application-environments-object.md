---
id: 0069
title: Control reaches an application environment's object
status: proposed
date: 2026-10-24
---

# 0069 — Control reaches an application environment's object

## Context

On Cloudflare an application environment runs in one Durable Object, which owns its SQLite database
([ADR-0065](0065-an-application-on-cloudflare-runs-in-one-durable-object-per-environment.md)). Nothing outside the
object can read that database. Control deploys the environment but cannot see its size, its migration ledger, its
scheduler or its queues, cannot tell why a boot failed, and cannot stop writes while it takes a backup or restores one.
Backups, exports and recovery to an earlier time all need the same two things first: a way for Control to call the
object, and a way to stop the object writing and to know that it stopped.

The constraints:

- **The proxy is the only enforcement point and the only public route** ([ADR-0022](0022-the-proxy-is-the-only-enforcement-point.md)).
  The application Worker has no route, and only its proxy Worker binds it
  ([ADR-0048](0048-bind-cloudflare-delivery-to-the-recorded-commit.md)). A new channel must enter through the proxy
  and must not add a second decision.
- **An application cannot declare a platform path.** The contract build refuses an authored path under `/__fabrika`.
  A channel for Control must be composed by the platform, not declared by the application.
- **The channel must work when the application does not.** Diagnosing a failed boot, or freezing a database before a
  repair, cannot depend on the application booting.
- **Point-in-time recovery rewinds the object's SQLite and its KV storage.** A maintenance state kept there would be
  rewound with the data it protects.
- **Control runs more than one instance, and a request it sent cannot be recalled.** Losing a lease stops a holder's
  next step, not a request already in flight.
- **Rows are tenant data.** An export or a row view of an environment shows every tenant's rows at once.
- **An installation upgrade changes no application** ([ADR-0062](0062-a-platform-release-serves-older-framework-releases.md)
  rule 5). The channel is protocol between the platform and the application, so it must be additive and gated by the
  application's framework release.

## Decision

**Control reaches an environment's object over one platform-composed `/__fabrika/ops/*` row on the environment's own
domain. The object authenticates Control with an ops key before it boots, serves a metadata view of its state, and
holds a maintenance barrier that Control drives by generations it allocates.**

An environment whose application chose Postgres through Hyperdrive ([ADR-0065](0065-an-application-on-cloudflare-runs-in-one-durable-object-per-environment.md)
§10) has no object database, so it gets none of this: no ops row, no ops key, no barrier and no migration phase.

### 1. The channel

- **The row.** Platform composition adds one canonical `protocol` row to the application's manifest entry: a fixed
  id, the path `/__fabrika/ops/*`, the method `POST`, no callers, no requirement, no delegation, `application/json`
  admission, and the digest those fix. The constants live in `@fabrika/auth-core`. The application cannot declare it,
  and ADR-0022 rule 3 ("The ops row") admits exactly this row on an application table and no other `protocol` row.
- **The transport.** Control calls `https://<environment domain>/__fabrika/ops/...`. The proxy Worker serves that
  domain as a Cloudflare Custom Domain (`custom_domain: true`), and a Worker may fetch a Custom Domain on its own zone;
  it may not fetch an ordinary route there. The channel relies on the Custom Domain and never on a route.
- **No domain, no channel.** An environment without a domain has no ops channel, and so no inspection, maintenance or
  backups. It serves no one else either.
- **The ops key.** Each environment gets its own ops key, handled as ADR-0064 handles a transport key: Control issues
  it, seals it in its vault and keeps only its digest. The object holds digests only, in `FABRIKA_OPS_KEY_DIGESTS`, and
  only its own environment's. Control sends the key in `Authorization`, which a `protocol` row forwards, and only on
  the ops row.
- **Rotation.** A deploy at a gated release rotates the key once it is at least 15 days old. It writes both digests,
  the old and the new, and Control keeps calling with the old key until that deploy has reconciled; the next deploy
  drops the old digest. A digest has no clock expiry, so a failed deploy leaves the running version and the key
  Control holds for it usable.
- **Before boot.** After the hop secret that every forwarded request carries (ADR-0065 §4), the ops handler checks
  `X-Fabrika-Endpoint` against the row's fixed id and digest and the key against the digests. It compares the header
  directly and runs no planner over the contract. All of it is framework code that runs before the application boots.
- **Uniform answers inside the prefix.** A missing or wrong key, a wrong endpoint header, an unknown operation and a
  refused object name all get one answer: the same status, body and headers. Authentication runs before anything that
  depends on the request's detail. Outside the prefix the proxy answers as before, so the prefix itself is visible; only
  what lies inside it is not.
- **Object selection.** Ordinary traffic goes only to the object named by `FABRIKA_APPLICATION_OBJECT`. Every ops
  request names its target in the body field `object`, and the Worker accepts only a name listed in the comma-separated
  `FABRIKA_APPLICATION_OBJECTS` (1–16 names, the default among them), resolved in its own environment's namespace; a
  caller never names an object of another environment. A name matches `^[a-z][a-z0-9-]{0,62}$`, so it is safe in the
  state object's R2 key. Without either variable the object
  is named `application`, as today. A side restore, decided when it is built, moves `FABRIKA_APPLICATION_OBJECT` to a
  clone and lists both names.
- **The wire.** The prefix, the row's constants, the request and answer shapes and the variable names live in
  `@fabrika/auth-core`, which already owns the application-to-platform wire.

**Why this is not a second enforcement decision.** The proxy decides an ops request with its one decision: it selects
the composed row like any other, with no fall-through, and a `protocol` row reads no credential, mints no token and
forwards the request. The object's key check is a receiver authenticating its caller on a `protocol` row, as IAM
authenticates its `/admin/*` bearer and as a platform receiver verifies its transport key
([ADR-0064](0064-applications-reach-the-platform-over-a-receiver-verified-transport-key.md)). It resolves no principal
and reads no policy. Control's own check of the caller's grant (§2) is **authorization**. Control is not a principal of
the application: no grant of the application reaches every tenant's rows, and the read must work before the
application can boot.

**Invariant: an ops request reaches only framework code, and ordinary dispatch never receives the ops key.** The ops
handler never dispatches to the contract, and Control sends the key on no other row.

### 2. The view

Inspection is pulled live over the channel; nothing is ingested. It reads the object's storage without booting the
application, so an environment whose boot fails can still be inspected and put into maintenance. It covers:

- the database size and row counts per table, each capped at 100 000 (a full count bills every row read);
- the migration ledger and the framework release;
- the scheduler: its wakes, the current alarm, the last alarm's lag;
- job leases: the last runs and their outcomes;
- queue tables: waiting, due-now and dead counts;
- file states and webhook claims, as counts per state;
- the current bookmark and the oldest restorable time;
- the maintenance mode and generation, the last boot failure, and the backups.

**The view is an allowlisted projection:** counts, sizes, timestamps, identifiers the platform or the contract names
(tables, jobs, webhooks, file kinds, objects, operations, backups) and status codes. Filenames, payloads, row values and
application error text (a boot failure's message and stack, a job's error) are content, returned only to a caller that
holds `data.content.read`. The ops wire's answer shapes, Control's RPC results and backup downloads keep the same
boundary: `data.read` lists backups, and only `data.content.read` downloads one.

A pending-work tracker for staging, which lists what keeps an object awake, is switched on per object over the same
channel, in memory, and is off again after an eviction. It needs no variable.

Control authorizes three actions, each scoped by application and environment unless stated:

| Action              | Allows                                                                                        |
| ------------------- | --------------------------------------------------------------------------------------------- |
| `data.read`         | the projection: sizes, counts, state, the backup list                                         |
| `data.content.read` | row contents, exports and backup downloads of every tenant, content fields. Global grant only |
| `data.manage`       | maintenance transitions, backups, restores, and recovery of an interrupted operation          |

**Invariant: content is for the installation's operators.** `data.content.read` is checked as a global grant, like
`mail.content.read`, so an application owner's grant scoped to the application never carries it.

Each operation is a row in Control's `app_env_data_operations`, beside `runs`: its id, environment, kind, the
generations it reserved, step, target, bookmarks, actor and timestamps. Each is audited and runs under the
environment's deploy lock.

### 3. The maintenance barrier

The modes:

| Mode        | The object admits                                                                                               |
| ----------- | --------------------------------------------------------------------------------------------------------------- |
| `open`      | everything                                                                                                      |
| `read-only` | reads and ops requests; a writing endpoint answers 503 with `Retry-After`; no job, kick, alarm or repair writes |
| `closed`    | ops requests only; no job, kick, alarm or repair writes                                                         |
| `inspect`   | ops requests only, and the application never boots: no migrations, no alarm, no jobs                            |

In `read-only` and `closed` an alarm that fires runs no work and writes nothing; scheduler repair runs when the object
opens. `inspect` is for an object that must stay frozen: the original after a side restore, which must never boot
again.

**Generations.** Control allocates every generation from a counter per environment in its own database, atomically,
and records it on the operation before it sends the request. A generation never comes from the application's database,
which a restore can rewind. Every mutating ops request carries the generation it acts under, and the object refuses
one that is not its current published generation.

**Authority and copies.** Control's operation record is the authority. The object's durable copy is an R2 object per
object name, `__fabrika/ops/<object>.json`, in the environment's bucket. It is never in SQLite or KV, because
point-in-time recovery rewinds both. The object keeps its mode, its generation and whether R2 holds them: **pending**
until a put succeeds, **published** after.

**A transition** is `POST /__fabrika/ops/state { mode, generation }`. The object runs one transition at a time; the
next waits for it.

1. A generation below the current one is refused, and so is an equal generation with another mode: after
   authentication the answer is 409 naming the published generation and mode, so Control can reconcile. An equal
   generation with the same mode is a retry: a pending state repeats the put of step 3, then the drain runs again.
2. A restricting transition switches the in-memory mode before any await, as pending. From that instant the object
   admits no new invocation of a class the mode forbids. An opening transition leaves memory as it is.
3. The object writes R2 by a put conditioned on the version it last read or wrote. On success the state is published,
   and an opening transition now switches memory. On failure the call fails and memory keeps the more restrictive
   mode. On a conflict the object reads R2 again: a higher generation there is adopted as published and the request
   is refused as stale; otherwise it puts again against the version it read.
4. **The drain.** The object counts its in-flight invocations per class: requests (including those still authorizing
   or uploading), webhooks, kicks, job runs and framework jobs. It awaits their settlement, not only the end of their
   frames, within a bound: 25 s for handlers, plus the job abort grace. The stop controller covers every run.
5. **The acknowledgement** comes only once the state is published and the drain is over, with the count of anything
   still running past the bound. Control records the transition as complete only on this acknowledgement.

**The write fence.** Every invocation captures the generation when it is admitted. The enclosure's commit and every
framework write path (admission rows, the webhook claim, an upload's pending row, job leases and fenced transactions,
claims) check the mode and the generation inside their own transaction, and roll back on a mismatch. The object runs
one transaction at a time, so no write slips in between the check and its commit.

**Invariant: no write admitted under an older generation commits after a restrictive transition.** The fence covers
the database. Effects outside it can outlive the drain: bytes an upload already wrote to R2, and calls a handler or a
job made to another system. The acknowledgement reports what still ran; it never claims those effects were undone.

**Upload bytes after a rollback.** A request's multipart files are staged before the handler's transaction opens, so
each pending row commits on its own before the first byte and is the upload's cleanup intent: the fence that rolls back
the handler does not roll it back, and the sweep removes the bytes later, while the object is open, sparing every key a
row references or a backup within its retention may restore. A commit the fence refuses releases the files the
request staged at once. A `ctx.files.put` inside a writing handler has no such intent on Cloudflare: everything the
object writes while the handler's transaction is open joins that transaction, so its pending row rolls back with it.
Its bytes get the best-effort release only, and an eviction in the middle of the handler leaves them unreferenced in
the bucket, costing storage and exposing nothing ([backlog 236](../backlog/236-an-in-handler-upload-leaves-bytes-after-an-eviction.md)).

**Cold starts.** A cold instance reads its R2 state. An absent object, a definite not-found, means `open`. Any other
failure is never read as absence: the instance answers 503 to every request, ops requests included, and the next
request retries the read without waiting for an eviction. Pending migrations then depend on the mode:

| Mode                  | A cold start with a pending migration                                                                |
| --------------------- | ---------------------------------------------------------------------------------------------------- |
| `open`                | migrates, then boots, as today                                                                       |
| `read-only`, `closed` | neither migrates nor boots; ordinary requests answer 503 with `Retry-After`; ops requests are served |
| `inspect`             | never migrates and never boots                                                                       |

**The migration phase.** A deploy that brings a pending migration runs inside a maintenance operation: `read-only`,
then a consistent backup and its verification, then the operation's own deploy, then
`POST /__fabrika/ops/migrate { generation }`. The object runs the pending migrations under that generation, the only
writes the fence admits in a restricted mode, boots, and acknowledges with the new ledger. The operation then opens the
object at a new generation.

**Leases.** An operation holds the environment's deploy lease. Each step it records and each deploy it starts checks
first that the lease is still its own; a lost lease stops the operation at its next check. Control refuses a deploy of
an environment whose mode is not `open`, except the deploy that the operation holding the lease runs itself.

**A successor fences its predecessor.** An operation resumed after its holder died, and the recovery operation below,
first reserve a generation above every generation reserved for the environment, publish it in the mode the record
requires, and wait for its acknowledgement. Only then do they continue. A request the predecessor sent earlier and
that arrives later carries a lower generation and is refused.

**Recovery.** An operator with `data.manage` starts a recovery operation for an environment whose operation is stuck.
It takes a fresh lease, reads the record and the object's published state, publishes a fresh generation in `closed`,
and then, as the operator chooses, resumes the interrupted operation from its recorded step or opens the object at a
new generation.

**The fault matrix.** What each fault must lead to:

| Fault                                                                  | Required outcome                                                                                      |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| The answer to a transition is lost                                     | Control retries the same generation and mode; the object, already published, drains again and answers |
| The R2 put fails, then Control retries the same generation             | The state is still pending; the retry puts again and acknowledges only after the put succeeds         |
| The R2 put fails, and the instance is evicted before the retry         | The next instance reads the older mode from R2; the retry is a full transition for it                 |
| The conditional put conflicts                                          | The object reads R2; it adopts a higher generation and refuses, or puts again against the new version |
| The R2 put fails while opening                                         | Memory stays restrictive; the call fails; Control retries                                             |
| A transition with a lower generation, or equal with another mode       | Refused; the current state stays                                                                      |
| R2 is unreadable at a cold start                                       | 503 to every request, ops included; the next request retries the read                                 |
| A write admitted before the switch tries to commit after it            | The fence sees another generation and rolls the transaction back                                      |
| An upload is in flight at the switch                                   | It counts in the drain; its staged row is the cleanup intent the sweep removes the bytes by           |
| A handler's `ctx.files.put` is rolled back by the fence                | Its files are released at once; an eviction before that leaves the bytes unreferenced (backlog 236)   |
| A handler or job runs past the drain bound                             | The acknowledgement counts it; its writes are fenced; its external effects are reported, not undone   |
| An alarm fires in `read-only` or `closed`                              | It runs nothing and writes nothing                                                                    |
| A webhook arrives while not `open`                                     | 503; the sender retries                                                                               |
| A restricted cold start finds a pending migration                      | The application does not boot until the operation's migrate request                                   |
| A migrate request carries a generation that is not the published one   | Refused                                                                                               |
| Control dies mid-operation                                             | The environment stays in its published mode; a successor fences and resumes from the recorded step    |
| Two Control instances drive one environment                            | Only the lease holder records progress; at the object the higher published generation wins            |
| A request from a former lease holder arrives after the successor's ack | Refused: its generation is below the published one                                                    |
| The operation loses its lease                                          | It stops at its next check; the environment stays published until a successor or recovery fences it   |
| A deploy is requested while not `open`                                 | Refused, unless it is the deploy of the operation that holds the lease                                |
| The application fails to boot                                          | Ops requests are still served: the view is read, a transition is accepted                             |
| An `inspect` object receives ordinary traffic                          | Refused; the application does not boot                                                                |
| A wrong key or header, an unknown operation, a refused object name     | One answer for all, inside the prefix                                                                 |

## Consequences

- Control can inspect an environment, freeze it and know that it is frozen. Backups, exports, an importer and a side
  restore build on this channel and this barrier; each is decided where it is built.
- Every framework write path carries a fence check, and every invocation is counted. A new write path that skips the
  fence breaks the barrier's invariant. An application migration runs only in `open` or in an operation's migration
  phase.
- Upload quiescence covers a request's staged files; a put inside a writing handler relies on the best-effort
  release, so an eviction mid-handler can leave unreferenced bytes until backlog 236 lands.
- Maintenance depends on R2's availability at a cold start: an environment whose bucket cannot be read answers 503,
  even to Control, until it can.
- An environment without a domain cannot be inspected, frozen or backed up.
- An application owner sees the projection but never content. An installation operator holds `data.content.read`
  globally, which covers every environment of every application.
- `/__fabrika/ops/` joins the reserved paths on every application host; an application route there never runs.
  `__fabrika/` is reserved in the environment's bucket, and the build refuses a file kind of that name.
- The transport is proven only on a live account: a deployed smoke test calls from Control through the Custom Domain,
  the proxy Worker's `APP` binding and the Worker to the object.
- The channel and the barrier are Cloudflare-only: on Zerops an application has no object, and nothing changes.
- **Rollout.** The channel ships in framework 0.9.0, gated by `servesOps`, which equals `runsInObject`. The barrier
  (`state`, `migrate`) is gated apart, by `servesDataOperations` from `0.9.0-dev.5`: the prereleases published before it
  answer both 501, and a deploy of one never needs them.
  - **Generated files.** No installation file changes. The application Worker's config, with the variables and the
    handler, and its proxy Worker, with the row, are generated by the environment's next deploy at a gated release.
    `platform upgrade` alone changes no application (ADR-0062 rule 5), and the console says to redeploy to enable it.
  - **Environment variables.** That deploy writes `FABRIKA_OPS_KEY_DIGESTS`, `FABRIKA_APPLICATION_OBJECT` and
    `FABRIKA_APPLICATION_OBJECTS`. An environment on an older pin gets neither the row nor the variables, also on its
    next unchanged deploy, and a deploy after a downgrade removes them (`deleteStaleSecrets`).
  - **Provider state.** An existing object has no R2 state object and reads as `open`. Without the object variables
    it keeps the name `application`. Control's `app_env_data_operations` table and its generation counter arrive
    through Control's own migrations on upgrade and start empty.
  - **Floating pins.** None.

## Alternatives considered

- **A platform route for every environment.** An environment without a domain would still get a channel, and backups.
  Rejected: such an environment serves no one, and a second public address per environment would sit beside the one
  route ADR-0022 gives the proxy. An environment that needs backups gets a domain.
- **Application owners read row contents.** It would let an owner debug their own data without an operator.
  Rejected: an environment's rows are every tenant's rows, and an export shows all of them at once. Owners get the
  metadata projection.
- **The maintenance state in the object's own SQLite.** One store, no R2 dependency at a cold start. Rejected:
  point-in-time recovery rewinds SQLite and KV, so a restore would rewind the mode that protects it, and could reopen a
  database that must stay frozen. R2 is not rewound; the price is failing closed when it cannot be read.
- **Control calls the object over a service binding.** No public request, no domain needed. Rejected: the application
  Worker is reachable only through its proxy's binding, and a second binding would be a second way in beside the proxy
  ([ADR-0022](0022-the-proxy-is-the-only-enforcement-point.md) rule 1,
  [ADR-0048](0048-bind-cloudflare-delivery-to-the-recorded-commit.md)). Control's bindings are also static in its
  committed `wrangler.jsonc`, so each new environment would need a Control redeploy.
- **Fencing by the lease alone.** Simpler: the lease already excludes a second deploy. Rejected: a lease stops its
  holder's next step, not a request already sent, so only a generation the object compares can refuse a late request.
