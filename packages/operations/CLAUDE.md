# @fabrika/operations

The runtime-neutral Operations kernel. It owns Sentry envelope parsing and
fingerprinting, issue lifecycle decisions, event-detail parsing, source-map
resolution, alert decisions, and portable persistence capabilities.

`src/repositories.ts` is the ADR-0015 portability seam. SQLite and Postgres may
replace one complete repository operation, but shared domain code never branches
on a database identifier. `migrations/` and `migrations-postgres/` are the
parallel final schemas.

Shared entrypoints must not import Cloudflare, Bun, SQL drivers, or the
dashboard. Cloudflare adapters live in `platform-cf.ts`; Bun-only lifecycle code
lives under `src/node/`. The direct ingest surface and authenticated operator
surface remain separate exports.

`src/app.ts` is the shared `@fabrika/app` definition. It owns host isolation,
declarative routes, and `@fabrika/auth` operator middleware. Both runtime
entrypoints dispatch through this application; the Bun server uses
`@fabrika/app/bun`.

`src/operator-rpc.ts` implements `OperationsRpcContract` at `/api/rpc` for the
console. It and the compatibility `/api/*` REST handlers share typed operator
use cases. Keep public ingest, source-map upload, and private reconciliation as
their protocol-specific HTTP surfaces.

The public hostname accepts only Sentry-compatible
`/api/:projectId/envelope/` ingest and the authenticated source-map upload path.
`/api/*` operator routes, `/private/catalog/reconcile`, and
`/private/releases/reconcile` stay private. Control's same-origin gateway
transports operator requests; Operations owns authentication, scoped
authorization, IAM audit, and principal lookup. Authentication is verification
only (ADR-0022): the proxy matches `OPERATOR_GATES` and injects the access token,
`iam.authenticate(request)` re-verifies it locally against IAM's JWKS, and an
unresolved caller never reaches a handler. Operations evaluates no gate, writes
no cookie, and never produces a login URL.

Exact occurrence counts come from the append-only SQL occurrence index. Do not
replace that correctness source with sampled Analytics Engine data. Blob storage
holds raw bodies, while SQL indexes every event, source map, and dead event; the
`BlobStore` port deliberately has no listing operation.

Issue triage uses an optimistic `revision` plus `last_mutation_id`; the guarded
issue update and its activity insert must stay in one `SqlDatabase.batch`.
Occurrence transitions are staged on the unapplied occurrence so duplicate
queue delivery cannot repeat a regression or unsnooze activity.
Ingest resolves one `merged_into` hop before choosing the blob key or counting
the occurrence; merge targets must therefore remain canonical. Worker batches
group at most 50 events by source and effective fingerprint and perform one
issue write for an open/new group.

Notification delivery is an outbox with leased claims and six attempts.
External senders receive the stable outbox dedup key as their idempotency key.
New-issue and regression producers run after durable ingest persistence. The
scheduled maintenance pass evaluates the preceding one-minute occurrence window
for spikes and claims each source/fingerprint for fifteen minutes before enqueue.
Logs may contain the notification id and attempt number, never the target,
payload, or caught error detail. Cloudflare owns scheduled invocation; the Bun
consumer owns its abortable loop and can restart after `stop()`.
Webhook targets are syntax-validated on write and delivery, HTTPS-only, and
redirects are rejected; delivery is time-bounded and response bodies are
cancelled. DNS resolution and rebinding remain a production egress concern
shared with active HTTP health checks; see
[`backlog 38`](../../docs/backlog/38-add-dns-safe-operations-egress.md).

Releases are unique by source and immutable commit. Every deploy attempt has a
separate run link. The commit-level release row is a latest-observed summary:
`observedAt` updates `run_id`, state, finish time, and artifact state as one
tuple, and delayed older projections cannot roll it back.

`import/poplach-source-inventory.ts` pins and accounts for the Poplach source
import at commit `8e0c79d662c187fe41eacd0fee9fe77fde668f1f`.

The Bun migration wrapper uses `definePostgresServiceMigrations` and composes the
`platform-node` job-queue bundle before the Operations service bundle. Bundle names and filenames are durable migration
identity under ADR-0017; do not rename them. Real Postgres and S3 tests require
`FABRIKA_TEST_POSTGRES_URL` and `FABRIKA_TEST_S3_*` and otherwise skip.
