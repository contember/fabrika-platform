# @fabrika/platform

The runtime **ports** — `SqlDatabase`, `BlobStore`, `JobQueue`, `DeployLocks`, `AssetServer`,
`WaitUntil` — plus the implementations that need nothing but a port. Assumes the root CLAUDE.md.
The Postgres/S3/Bun implementations live in `@fabrika/platform-node`.

## Invariants

- **A port describes what callers need, not what a vendor returns.** Each names a capability in the
  narrowest form the code actually uses. Widening one is a decision — keep them boring.
- **`SqlDatabase` is D1-shaped so a real `D1Database` satisfies it STRUCTURALLY**, with no adapter
  and no rewriting of the statements services already carry. The cost lands on the SQL: every
  statement must stay inside the SQLite ∩ Postgres common subset. DDL is NOT covered — migrations are
  per-dialect.
- **`bind()` returns a NEW statement and never mutates the receiver** (D1 semantics). Call sites
  build a base statement and bind it repeatedly; a mutating `bind()` corrupts them silently. `bind()`
  is optional and may be called with zero arguments.
- **SQL NULL maps to JS `null`, never `undefined`.** Row shapes are checked with `=== null`.
- **The other ports are NOT satisfied structurally by Cloudflare bindings** and cannot be made so —
  `R2Bucket.put` resolves to `R2Object | null`, `Queue.send` to `QueueSendResponse`. The Cloudflare
  side wraps them in await-and-discard adapters (`packages/control/src/platform-cf.ts`). Adopting one
  of these ports costs a small adapter rather than nothing.
- **`FileObjectStore` is not `BlobStore`.** Application files need a size bound enforced while the body streams
  and their metadata read back; an R2 adapter of `BlobStore` that ignored a new option would silently drop the
  bound, so the files port is separate and only `@fabrika/platform-node`'s S3 store implements it. Its
  `ObjectTooLargeError` is read by `name` across packages.
- **`JobQueue` is `send()` only.** The consumer side has no honest common supertype: Workers invert
  control (the platform delivers a batch to `queue()`), a process owns its own loop. Do not add
  `poll()`/`start()`/`queue(batch)` to the port.
- **`SqlDeployLocks.acquire` is ONE conditional upsert, NEVER a read-then-write.** Two consumers
  racing for a free target cannot both observe "free": one inserts, the other conflicts onto the live
  row and its `DO UPDATE` is skipped by the `expires_at <= ?` guard. `meta.changes` is the whole
  answer. Splitting it into a SELECT and an UPDATE reintroduces exactly the race the Durable Object
  existed to prevent. The lease is non-reentrant, TTL-bounded, and holder-checked on release.
- **`uuidv7` is the one UUIDv7 generator; ids are minted caller-side, never in SQL.** Its ordering
  promise is strict: ids sort lexicographically in mint order within a generator (RFC 9562 §6.2
  counter), which is what makes keyset cursors over `id` correct for rows written in one millisecond.
- **`@fabrika/platform/testing` holds the shared in-memory port doubles.** Never export them from the
  package root.

## Patterns

- Portable implementations live HERE, with the ports, not with either runtime — `deploy-locks-sql.ts`
  depends on nothing but `SqlDatabase`, which is what lets the control Worker and a Bun process share
  one copy instead of two that drift. Keep that test: does it need any I/O primitive of its own?
- The table name is a parameter where a second service may want its own lease table.
- **There is no environment-name compatibility layer here any more (ADR-0024).** Every composition
  root reads its canonical `FABRIKA_*` name straight off its own source. A generic "canonical or
  legacy" reader is the thing a future rename would re-adopt; write the rename instead.
