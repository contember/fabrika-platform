---
id: 0017
title: Make Postgres migrations service-owned and bundle-qualified
status: accepted
date: 2026-10-08
---

# 0017 — Make Postgres migrations service-owned and bundle-qualified

## Context

The Bun runtimes for IAM, Control, and Operations apply Postgres migrations at
container start. A runner that orders SQL files by filename and records only
the filename in one global ledger fails in the Zerops platform topology. IAM and
Control use the same Postgres connection and the same default schema, and both
migration sets contain `0001_init.sql`. A filename-only ledger lets whichever
service starts first claim the other service's migration names, and the later
service then skips SQL that it still needs. Separate advisory locks do not
prevent this, because the collision is persisted in the shared ledger.

Operations uses `PostgresJobQueue`, whose `jobs` table belongs to
`@fabrika/platform-node`. Copying that runtime DDL into every consumer would
recreate the duplication that the runtime package is meant to remove.

Local development creates separate `iam` and `control` databases, and the
Postgres tests isolate services in separate schemas, so neither exposes the
collision. The migration model therefore has to express ownership directly
rather than depend on accidental database isolation.

Applications on the contract framework ([ADR-0012](0012-fabrika-app-runtime.md))
also keep their tables in Postgres. In a cheap namespace several applications
share one database ([ADR-0014](0014-provider-owned-deployment-namespaces.md)).
Their migrations run from the application's own container, because Control
cannot reach a namespace's Postgres. An agent writes these migrations, and an
agent may also edit a migration that already ran. The runner today has no
checksum and no timeouts, and it rejects a schema-qualified ledger.

## Decision

`@fabrika/platform-node` owns the reusable Postgres migration loader and
runner. It also publishes migration bundles for generic runtime infrastructure
that the package itself owns, such as the Postgres job queue. Service-domain
SQL remains in the service package that owns its schema.

Each Bun service keeps a thin migration wrapper. The wrapper owns:

- its database environment variable and connection lifecycle;
- its service migration directory;
- its physical ledger table;
- its stable advisory lock identifier;
- its ordered migration-bundle plan.

IAM, Control, and Operations use separate physical ledgers:
`iam_schema_migrations`, `control_schema_migrations`, and
`operations_schema_migrations`. A migration's identity is the pair
`(bundle, filename)`. Renaming a bundle or a migration file changes its
identity and is not a refactor.

A plan contains one or more bundles in explicit order. The runner preserves
that bundle order and orders files by filename only within a bundle. It applies
each SQL file and its qualified ledger row in one transaction.

Operations composes the `platform-node` job-queue bundle before its
`operations` service bundle. Control states the same `jobs` table in its own
initial migration with `IF NOT EXISTS`, column for column, because on the light
Zerops tier both services create it in one shared schema.

The advisory lock identifiers are stable:

- IAM: `7214839201`;
- Control: `4471902583`;
- Operations: `6384217905`.

They serialize old and new containers of the same service during a rolling
deployment. One service lock covers ledger initialization and every bundle in
its plan. The runner uses one Postgres session for the complete operation.

There is no adoption of an older ledger. A service ledger that is empty means a
fresh schema, and the runner applies every file in the plan.

**Pre-1.0 squash rule.** Until 1.0, the migration history of a bundle may be
squashed into one initial file per dialect when the installations that hold it
are reinstalled. A squash keeps each bundle name, ledger, and lock, and must
produce exactly the schema and seed rows the previous history produced, on
both Postgres and D1. An installation that applied the old history is not
upgraded across a squash; it is reinstalled. From 1.0 on, applied migration
files are immutable and every change is a new file.

The public `@fabrika/operations/node/migrate` entrypoint remains a thin
wrapper. Callers keep a service-level migration surface and do not need to know
how Operations composes generic runtime bundles. The shared runner is an
implementation mechanism, not a transfer of Operations schema ownership to
`@fabrika/platform-node`.

This decision does not introduce schema isolation. IAM and Control continue to
use disjoint service-owned tables in the shared default schema on Zerops.
Moving either service into a dedicated schema would require coordinated
runtime `search_path` changes and is a separate decision.

Cloudflare D1 migrations are applied by `wrangler d1 migrations apply` from
each service's `migrations/` directory, and D1 keeps its own ledger. The same
squash rule applies to them.

### Application migrations

The same runner applies an application's migrations, with three additions:

- **The ledger lives in the application's schema.** The runner accepts a
  schema-qualified ledger for this purpose. Work unit A9 decides the
  application's bundle name and ledger table name.
- **Each applied migration has a checksum.** The runner records it and fails
  when an applied file has changed.
- **Each migration runs under `lock_timeout` and `statement_timeout`.** A
  blocked `ALTER` fails within the timeout instead of holding the deploy.

The advisory lock key derives from `fabrika-db:<appId>`, so applications that
share one database do not serialize each other.

`fabrika db migrate` runs the migrations. It is the generated
`run.initCommands` entry of the application's execution descriptor
([ADR-0043](0043-validate-and-render-one-zerops-descriptor-meaning.md)), and it
uses the application's runtime credential. The checker verifies migration file
names, because an agent over MCP cannot run `fabrika db new`.

The pre-1.0 squash rule does not cover application ledgers. An application
migration that has run is immutable: a changed checksum fails the run, and a
change is a new file. Every new or changed
migration file is a widening in the approval diff
([ADR-0050](0050-approved-access.md)).

The code does none of this yet (part A, work unit A9; part B, work unit B7).

## Consequences

- IAM and Control can safely use one Zerops database and schema despite
  overlapping migration filenames.
- Generic runtime tables can be composed without copying their DDL into a new
  service migration set.
- Operations creates the `jobs` table before its runtime starts using
  `PostgresJobQueue`.
- A service can add more bundles without flattening their filenames into one
  namespace.
- Each wrapper must define and test its bundle order, ledger, and lock
  identity.
- Real Postgres tests cover fresh installation, cross-service filename
  collisions, per-file atomicity, and concurrent container startup.
- A pre-1.0 squash costs a reinstall of every live installation, and the person
  who squashes must prove schema equality on both dialects.
- IAM and Control still share a database failure and capacity domain. This ADR
  fixes migration ownership, not storage isolation.
- An application's edited migration fails its next deploy instead of silently
  diverging from the schema it describes.
- A migration that waits on a lock fails the deploy within the timeout. The
  application author must retry or split it.
- Migrations and the runtime share one credential, so the running application
  holds the same schema rights as its migrations. Separate migration and runtime
  credentials come with per-application Postgres roles.

## Alternatives considered

### Put IAM and Control in separate Postgres schemas

This would provide a stronger namespace boundary, but every runtime and
maintenance process would need a coordinated `search_path`. The current domain
table names are already disjoint.

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

Repeating the job-queue DDL in every consumer would leave several
independently maintained copies of the same runtime schema and make drift
likely. Bundle composition keeps the generic DDL with the implementation that
consumes it. Control's single restatement exists only because both services
create the table in one shared schema on the light tier, and a test pins the
two declarations to each other.

### Run application migrations from Control

Control cannot reach a namespace's Postgres, because Zerops projects share no
private network. The application container can.

### Let applications squash or edit applied migrations

An agent edits whatever refuses it. Without a checksum, an edited migration
that already ran would leave the live schema different from the files, and the
approval diff would see a change that never runs.

### Adopt the old filename-only ledger

Earlier revisions adopted rows from the unqualified `schema_migrations` table
when service-specific sentinel tables proved ownership. No production
installation depends on that ledger, so the adoption code and its fail-closed
probes were removed rather than maintained.
