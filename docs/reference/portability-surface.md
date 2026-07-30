# Portability surface

Where fabrika touches Cloudflare, and what each touch point becomes when the
platform runs on Zerops. Both runtime adapter sets are implemented. The
Cloudflare entrypoints use native bindings; the Bun entrypoints use Postgres,
S3-compatible storage, HTTP, static files, and platform cron.

## Control and Operations — port inventory

| Cloudflare primitive        | Portable answer                                                                       | Notes                                                                                                                                                 |
| --------------------------- | ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1                          | Postgres, behind capability repositories over `SqlDatabase`                           | See the dialect assessment below.                                                                                                                     |
| Cloudflare Queues           | A Postgres job table with `SELECT … FOR UPDATE SKIP LOCKED` plus an in-process poller | On a long-running process the queue is unnecessary _in the Workers sense_ — the reason Workers need a queue (no process to poll with) does not apply. |
| `DeployLock` Durable Object | A TTL-bounded conditional `UPDATE` on a DB row                                        | Works identically on SQLite and Postgres, so the DO is deleted on **both** platforms — this is the one port that simplifies Cloudflare too.           |
| R2                          | S3-compatible object storage, behind a `Blob` port                                    | R2 is S3-compatible and Zerops object storage is MinIO, so **one** implementation covers both.                                                        |
| Service bindings            | HTTP                                                                                  |                                                                                                                                                       |
| `ASSETS` binding            | Static file serving                                                                   |                                                                                                                                                       |
| `scheduled` handler         | Platform cron                                                                         |                                                                                                                                                       |
| `waitUntil`                 | A `waitUntil` port                                                                    | Trivial on a long-running process; the seam exists so call sites don't branch.                                                                        |

The ports are `SqlDatabase`, `BlobStore`, `JobQueue`, `DeployLocks`, `AssetServer`
and `WaitUntil`, and they live in
[`@fabrika/platform`](../../packages/platform/src/). Cloudflare implementations sit
with the workers that use them; the Bun/Postgres/S3 set is
[`@fabrika/platform-node`](../../packages/platform-node/).

Operations uses the same ports for a different workload:

| Capability                        | Cloudflare                                 | Bun/Zerops                                                                    |
| --------------------------------- | ------------------------------------------ | ----------------------------------------------------------------------------- |
| Domain and operator state         | D1 with Operations capability repositories | PostgreSQL with the same repository contracts and explicit dialect operations |
| Raw events and source maps        | R2 through `BlobStore`                     | S3-compatible object storage through `S3BlobStore`                            |
| Accepted ingest                   | Cloudflare Queue plus DLQ                  | `PostgresJobQueue` plus `PostgresJobConsumer`                                 |
| Periodic checks and notifications | Worker `scheduled` handler                 | Zerops cron invoking the Bun one-shot                                         |
| Exact occurrence counts           | SQL occurrence index                       | SQL occurrence index                                                          |

Processed and dead-event facts come from durable Operations stores. Per-source
provider queue depth and reject counters are currently explicit `unavailable`
telemetry values in both compositions; the health contract does not fabricate
zeros when those facts cannot be obtained.

## Deploy layers — how portable each one actually is

Provider packages own the per-cloud implementations behind the open contract in
[`provider-bundles.md`](provider-bundles.md). The layer split remains:

| Layer            | Portability       | Why                                                                                                                                |
| ---------------- | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Secrets push     | **Portable**      | Same operation everywhere: put a value where the platform will inject it.                                                          |
| Schema reconcile | **Portable**      | Talks to the IAM service, not to the cloud.                                                                                        |
| Provisioning     | **Semi-portable** | The concepts map (a database is a database); the vocabularies do not. Needs a per-provider translation, not a per-provider design. |
| Build            | **Per-provider**  | Cloudflare builds in a fabrika-controlled container; Zerops builds it itself.                                                      |
| Artifact deploy  | **Per-provider**  | `wrangler deploy` vs an `/app-version` API call — and on Zerops build and deploy are one indivisible platform-side step.           |
| Migrations       | **Per-provider**  | A discrete plan step on Cloudflare; `run.initCommands` at container start on Zerops.                                               |

Zerops app configuration crosses a static boundary. `fabrika app build`
evaluates the app-owned TypeScript and emits manifest version 2 in a provider
artifact envelope version 2. The control plane validates and stores its canonical
structured import document, then deploys it without executing repository code.
The app-env target envelope version 2 supplies only the Zerops service id. The
assigned deployment namespace target supplies project and proxy coordinates.
The same app service id is used for deploys and immediate secret write-through.
The triggered app-version id is stored in the generic `external_run_id` field so
startup and cron can reconcile a run after the initiating process disappears.

Placement is part of the open provider contract, not a Zerops branch in shared
control. A provider may implement namespace normalization, resource claims,
checkpointed provision/reconcile operations, and provider-authored operator
plans. Core persists opaque namespace targets and enforces assignment, claim, and
deploy-time coordinate invariants. The Zerops provider maps one namespace to one
project and offers `cheap`, `mid`, and `full` isolation presets. See
[`deployment-namespaces.md`](deployment-namespaces.md).

The Cloudflare provider keeps the executable Oblaka config as its source
artifact. Its control adapter resolves a checkout and sends the provider-owned
runner job through `@fabrika/runner-contract` to the separate Cloudflare runner.
`@fabrika/runner-container` invokes the internal
`fabrika-cloudflare-executor`; the neutral engine and shared control core do not
import Oblaka or interpret Cloudflare steps.

## IAM (`@fabrika/iam`) — port assessment

propustka's Cloudflare coupling is unusually narrow: of roughly **7,900 lines**,
only `env.ts`, `index.ts`, `db.ts` and the test harness are platform-specific.

- **HTTP layer — already portable.** It is written fetch-style
  (`Request → Response`), which both Bun and Node accept natively. No work beyond
  the entrypoint.
- **Repository capabilities — the real work.** Principals, grants, app schema,
  credentials, sessions, and audit are separate capabilities over the
  D1-shaped prepared-statement API.
- **The runtime port:** a D1-shaped `SqlDatabase`
  ([`@fabrika/platform`](../../packages/platform/src/sql.ts)) that `D1Database`
  satisfies structurally, with a Postgres driver underneath it in
  [`@fabrika/platform-node`](../../packages/platform-node/). Portable repository
  operations keep one SQL body and avoid query duplication.
- **The dialect seam is a complete repository operation.** A runtime composition
  root assembles the capability bundle. It may replace one capability with a
  subclass whose operation uses a different statement count, transaction shape,
  locking primitive, or result mapping. Shared code never branches on a database
  id, and no empty per-dialect subclasses exist. See
  [ADR-0015](../decisions/0015-repository-operations-are-the-sql-portability-seam.md).
- **The query surface was NOT purely mechanical.** Audits found, and the query
  bodies in `iam`, `control` and `runner-cloudflare` have since been fixed for, three outright
  failures — `IS NOT <expr>` (SQLite-only; now `IS DISTINCT FROM`), `unixepoch()`
  in fifteen statements (now bound caller-side), and `LIKE` case-sensitivity (now
  `LOWER(x) LIKE LOWER(?)`) — plus two latent ordering bugs that were live on
  Cloudflare, not merely future Postgres problems: an all-env-before-env-specific
  secret precedence that rested on SQLite's rowid fallback and would have deployed
  the **wrong secret value**, and `ORDER BY created_at` ties with no deterministic
  tiebreak.
- **One construct has no common-subset spelling: `auth_log.id`.** It relies on
  SQLite's `INTEGER PRIMARY KEY` rowid alias to assign ids. SQLite cannot parse
  `GENERATED BY DEFAULT AS IDENTITY`, and `BIGINT PRIMARY KEY` parses but does not
  auto-assign — so no single DDL serves both. The Postgres migration must spell it
  `BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY`; the SQLite files carry a
  comment saying exactly that at both sites.
- **Migrations remain per-dialect and are the larger remaining cost.** SQLite-only
  DDL still in the applied files: `DEFAULT (unixepoch())` (now vestigial — every
  writer binds), and the create-copy-drop-rename table rebuild pattern.
  `INSERT OR IGNORE` and `CHECK (json_valid(…))` have been removed; dropping the
  JSON checks weakened a guarantee the read path relied on, so the three readers now
  parse defensively — including `resolve.ts`, which sits on the **authz** path.
- **Driver divergences that survive the port** (each pinned by a test in
  `platform-node`): Postgres returns `BIGINT`/`NUMERIC` as a **string**, decided by
  column type OID rather than by value, so any row shape typed `number` must be
  `INTEGER` in the Postgres DDL — and unix-millisecond columns therefore cannot be
  `INTEGER` (int4 overflows at 2.1e9). Postgres also type-checks bind parameters
  where SQLite silently returned no rows, and does not order `RETURNING`.
- **Alternative — Kysely.** Was a real option, and would have handled textual
  dialect divergence for us. Rejected because the existing port is less
  machinery and repository operations also cover non-textual differences such as
  statement count and atomicity.

Sequencing note that paid off: the **test harness was ported first**, before any
production code, so dialect bugs surfaced against real tests rather than against
production traffic. IAM, control, and Operations have live-Postgres suites that
apply the shipped migrations and drive their portable repository capabilities; those suites
skip when `FABRIKA_TEST_POSTGRES_URL` is unset, so a green run with skips proves
nothing about this half.

## Operations (`@fabrika/operations`) — port assessment

The shared ingest, grouping, triage, release, source-map, health, alert, and
operator code imports neither Cloudflare nor Bun runtime modules. Runtime
composition lives in `src/platform-cf.ts` and `src/node/`.

Operations persistence is split by complete repository capabilities under
ADR-0015. Its SQLite and Postgres migrations describe the same final domain
schema, while raw payload and source-map behavior is tested against both an
in-memory blob store and a real S3-compatible endpoint. Real Postgres and S3
suites skip unless `FABRIKA_TEST_POSTGRES_URL` and `FABRIKA_TEST_S3_*` are set.

On Bun, Operations composes the reusable `platform-node` Postgres job-queue
migration bundle before its service-owned bundle. IAM, control, and Operations
use separate bundle-qualified ledgers and stable advisory locks as required by
[ADR-0017](../decisions/0017-service-owned-postgres-migrations.md). Cloudflare D1
migration history is unchanged.
