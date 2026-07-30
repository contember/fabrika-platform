---
id: 0017
title: Make Postgres migrations service-owned and bundle-qualified
status: accepted
date: 2026-07-30
---

# 0017 — Make Postgres migrations service-owned and bundle-qualified

## Context

The Bun runtimes for IAM, Control, and Operations apply Postgres migrations at
container start. Each service originally carried a copy of the same loader and
runner. Each runner ordered SQL files by filename, recorded those filenames in a
global `schema_migrations` table, and serialized its own containers with a
service-specific session advisory lock.

This fails in the Zerops platform topology. IAM and Control use the same
Postgres connection and the same default schema. Their domain tables do not
collide, but both migration sets contain `0001_init.sql` and a service-specific
`0002_*.sql`. A filename-only ledger lets whichever service starts first claim
the other service's migration names. The later service then skips SQL that it
still needs. Separate advisory locks do not prevent this because the collision
is persisted in the shared ledger.

Operations uses `PostgresJobQueue`, whose `jobs` table belongs to
`@fabrika/platform-node`, but its service migration runner previously loaded
only the Operations migrations. Copying that runtime DDL into every consumer
would recreate the duplication that the runtime package is meant to remove.

Local development does not expose the IAM/Control collision because it creates
separate `iam` and `control` databases. Existing Postgres tests also isolate
services in separate schemas. The migration model therefore has to express
ownership directly rather than depend on accidental database isolation.

## Decision

`@fabrika/platform-node` will own the reusable Postgres migration loader and
runner. It will also publish migration bundles for generic runtime
infrastructure that the package itself owns, such as the Postgres job queue.
Service-domain SQL remains in the service package that owns its schema.

Each Bun service will retain a thin migration wrapper. The wrapper owns:

- its database environment variable and connection lifecycle;
- its service migration directory;
- its physical ledger table;
- its stable advisory lock identifier;
- its ordered migration-bundle plan;
- its service-specific legacy ownership evidence.

IAM, Control, and Operations use separate physical ledgers:
`iam_schema_migrations`, `control_schema_migrations`, and
`operations_schema_migrations`. A migration's identity is the pair
`(bundle, filename)`. Bundle names and existing filenames are durable history:
renaming either changes the identity and is not a refactor.

A plan contains one or more bundles in explicit order. The runner preserves
that bundle order and orders files by filename only within a bundle. It applies
each SQL file and its qualified ledger row in one transaction.

Operations composes the `platform-node` job-queue bundle before its
`operations` service bundle. Control keeps its existing immutable
`migrations-postgres/0002_jobs.sql`; this repair does not replace, rename, or
rewrite that historical file.

The existing advisory lock identifiers remain unchanged:

- IAM: `7214839201`;
- Control: `4471902583`;
- Operations: `6384217905`.

Keeping these identifiers serializes old and new containers of the same service
during a rolling deployment. One service lock covers ledger initialization,
legacy adoption, and every bundle in its plan. The runner uses one Postgres
session for the complete operation.

The old filename-only `schema_migrations` table becomes read-only migration
evidence. It is never renamed, rewritten, or dropped. A new service ledger may
adopt legacy rows into exactly one service-owned bundle, and only during its
initial bootstrap:

1. The wrapper checks service-specific base-table sentinels in the current
   schema.
2. If none exist, the old ledger is treated as foreign or the service is
   treated as new; no rows are adopted.
3. If all exist, the old ledger and any migration-specific effects must prove
   that the service owns each adopted filename.
4. If only some sentinels exist, a required effect is absent, or ledger and
   schema disagree, migration stops without guessing.

Only current-schema base tables count as table sentinels. Migration-specific
effects cover ambiguous filenames whose durable result needs additional proof,
including Control's `0002_jobs.sql` and IAM's provisioning-principal migration.
Legacy rows are copied only when their filename exists in the adopting bundle's
current manifest.

**Invariant:** A legacy filename is never adopted from
`schema_migrations` unless one service's current-schema sentinels and required
effects prove ownership; partial or inconsistent evidence fails closed.

The public `@fabrika/operations/node/migrate` entrypoint remains a thin
compatibility wrapper. Callers keep a service-level migration surface and do not
need to know how Operations composes generic runtime bundles. The shared runner
is an implementation mechanism, not a transfer of Operations schema ownership
to `@fabrika/platform-node`.

This repair does not introduce schema isolation and does not move existing
data. IAM and Control continue to use disjoint service-owned tables in the
shared default schema on Zerops. Moving either service into a dedicated schema
would require coordinated runtime `search_path` changes, table and sequence
moves, data migration, rollback handling, and downtime planning. That is a
separate decision, not a prerequisite for correct migration ownership.

Cloudflare D1 migration history and deployment remain unchanged.

## Consequences

- IAM and Control can safely use one Zerops database and schema despite
  overlapping migration filenames.
- Generic runtime tables can be composed without copying their DDL into a new
  service migration set.
- Operations creates the `jobs` table before its runtime starts using
  `PostgresJobQueue`.
- A service can add more bundles without flattening their filenames into one
  namespace.
- Existing installations keep their data and immutable SQL history. Their old
  ledger remains as read-only evidence after adoption.
- Broken or ambiguous legacy states stop startup and require operator
  intervention instead of being silently recorded as valid.
- Migration wrappers remain small, but each service must define and test its
  sentinels, effects, bundle order, ledger, and lock identity.
- Real Postgres tests must cover fresh installation, legacy adoption,
  cross-service filename collisions, per-file atomicity, and concurrent
  container startup.
- IAM and Control still share a database failure and capacity domain. This ADR
  fixes migration ownership, not storage isolation.

## Alternatives considered

### Put IAM and Control in separate Postgres schemas

This would provide a stronger namespace boundary, but it is a data migration
rather than a migration-runner repair. Existing tables live in the default
schema, and every runtime and maintenance process would need a coordinated
`search_path` cutover. The added rollback and downtime risk is disproportionate
when the current domain table names are already disjoint.

### Give IAM and Control separate database services

This removes both namespace and capacity coupling, but increases the cost of
the Zerops platform topology and changes its recovery model. It is not required
to resolve filename ownership.

### Keep one shared ledger with a service column

A composite key could distinguish services, but every service would still
bootstrap and mutate one physical coordination table. Separate physical ledgers
make ownership visible and avoid coupling service startup through shared ledger
DDL.

### Copy platform runtime migrations into each service

Control historically did this for its job queue. Repeating the pattern for
Operations would leave several independently maintained copies of the same
runtime schema and make drift likely. Bundle composition keeps the generic DDL
with the implementation that consumes it.
