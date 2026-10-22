# Cloudflare — the platform facts fabrika depends on

The subset of Cloudflare behaviour that [ADR-0065](../decisions/0065-an-application-on-cloudflare-runs-in-one-durable-object-per-environment.md)
and the Cloudflare provider rest on. Every claim carries a source: a probe on a live account (throwaway Workers,
deleted after), a probe on a local workerd (`wrangler dev` 4.74.0, workerd 1.20260312.1, no account), the workerd
source, or Cloudflare's documentation. A claim marked _not verified live_ is not probed on an account; do not promote
it to fact without a probe.

## Worker variables

- **A variable holds at most 5,120 bytes.** Probed live (2026-10): a plain-text variable of 5,120 bytes deploys;
  5,121 bytes is refused with API error code 10054. The proxy manifest therefore travels in the proxy Worker's bundle
  (wrangler `define`), not in a variable; an application's manifest is 13 KB and more.
- **`wrangler deploy --secrets-file <file>`** uploads secrets with the version, from wrangler 4.74.0; secrets of
  earlier deployments are kept unless `--keep-secrets` says otherwise (`wrangler deploy --help`). A plain variable not
  in the new config is dropped by the deploy. _Not verified live:_ that one upload turns a plain variable into a
  secret of the same name.

## D1

- **No interactive transaction.** D1 runs single statements and atomic `batch()` calls; `BEGIN` is not accepted. The
  platform's own services (IAM, Control, Operations) are written for that ([portability surface](portability-surface.md)).

## A Durable Object's SQLite

- **`sql.exec` refuses transaction statements.** Probed live: `BEGIN` in `sql.exec` throws. A transaction runs
  through `ctx.storage.transaction(async)` or `transactionSync`.
- **`storage.transaction(async)` is an interactive transaction.** Probed live: two inserts with an awaited `fetch`
  between them, then a throw, leave no row; the same without `transaction` leaves both (each write commits at its
  await).
- **While it is open, the object takes no other event.** workerd runs the callback under `blockConcurrencyWhile`
  (`src/workerd/api/actor-state.c++`, `DurableObjectStorage::transaction`). Probed live: a read sent 300 ms into a
  1.5 s transaction is answered when the transaction ends; without one, the same read sees the first write at once.
  The object's own outgoing I/O started outside the callback is not even sent until the transaction ends, so a
  handler that awaits I/O must run inside it — the reason for `InvocationTransaction.enclose`. Probed on local
  workerd: with a 1.5 s transaction open, a `fetch` started outside the callback reaches its target at 1,504 ms; the
  same `fetch` inside the callback completes in 201 ms against a 200 ms target, with no deadlock.
- **A transaction started inside the callback nests in a savepoint** (`ActorSqlite::ExplicitTxn`,
  `src/workerd/io/actor-sqlite.c++`, `SAVEPOINT _cf_savepoint_<depth>`), and a nested one that throws rolls back only
  itself. Probed on local workerd, for an async and a `transactionSync` inner transaction. Lopata 0.30 and
  `bunSqliteStorage` nest the same way.
- **A long transaction resets the object.** Probed live: a 10 s transaction commits; a 40 s one fails with
  "blockConcurrencyWhile() waited for too long" and the object is reset.
- **Throughput.** Probed live: 1,000 concurrent small transactions (a read, two writes, a read) finish in 945 ms on
  one object.
- **Latency from a Worker to its object.** Probed live from a Worker in Vienna to an object in Frankfurt: 15 ms p50;
  with `locationHint` `eeur` 17 ms, `weur` 34 ms, `enam` 121 ms, `wnam` 167 ms, `apac` 241 ms.
- **An object does not move**, and placement (`placement.mode = "smart"`, region, host) moves a Worker towards a
  backend it calls over the network, never towards a Durable Object, and does not change a call to one
  ([placement](https://developers.cloudflare.com/workers/configuration/placement/)).
- **Limits.** 10 GB per object; one thread; about 1,000 requests a second per object; 128 MB of memory; point-in-time
  recovery for 30 days; no bulk export (read through the dashboard's Data Studio)
  ([Durable Objects limits](https://developers.cloudflare.com/durable-objects/platform/limits/)).
- **Foreign keys are enforced** in an object's SQLite, and `PRAGMA foreign_keys = OFF` does not turn them off. Probed
  on local workerd: a violating insert throws `FOREIGN KEY constraint failed: SQLITE_CONSTRAINT`.
- **`sql.exec` binds `?` parameters**, as Kysely's SQLite compiler emits them. Probed on local workerd through the
  application's own statements.

## R2

- **A conditional put refuses an existing key.** Probed on local workerd: `put(key, body, { onlyIf: { etagDoesNotMatch:
  '*' } })` on an existing key answers `null` and keeps the object. An etag passed to `onlyIf` is unquoted; R2 refuses
  a quoted one.

## Workers runtime

- **No `Bun` global.** Code a Worker bundles must not call `Bun.*` (a test bundles the Cloudflare fixture and refuses
  it, `packages/app/src/__tests__/cloudflare-bundle.test.ts`).
- **An RPC stub answers every name.** `'x' in env.BINDING` is `true` and `typeof env.BINDING.x` is `'function'` for any
  `x` on a service binding to a `WorkerEntrypoint`; calling a method the entrypoint lacks throws `The RPC receiver
  does not implement the method`. Probed on local workerd.
- **A large `define`.** Probed locally: a 233,280-character manifest string builds (`wrangler deploy --dry-run`,
  291 KiB) and the Worker reads it back intact. _Not verified live:_ the account accepting the upload.
