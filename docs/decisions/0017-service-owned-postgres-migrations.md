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
agent may also edit a migration that already ran, and a migration's `ALTER`
can wait behind the live version's locks. The service runner records no
checksum, sets no timeouts, and accepts only an unqualified ledger.

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

The same runner applies an application's migrations. An application's plan
carries three additions that service plans do not:

- **The ledger lives in the application's schema.** The schema is
  `app_<id>`, with each `-` of the application id written as `_` (IAM's id
  alphabet has no `_`, so two ids never share a schema; an id has at most 59
  characters, so the schema name fits Postgres' 63). The runner creates the
  schema when it is absent and runs each migration with it as the only
  `search_path`. The ledger is `app_<id>.fabrika_migrations` with the columns
  `(bundle, name, checksum, applied_at)`; the bundle is `app`. Only an
  application's plan may name a schema-qualified ledger, and only in its own
  schema. Tables named `fabrika_*` belong to the framework: `fabrika db migrate`
  applies them (`@fabrika/db/migrations`) as the bundle `fabrika`, in the same
  ledger and before the bundle `app`, so an application's migration may
  reference them.
- **Each applied migration has a checksum**, the SHA-256 of the file's text.
  The runner compares every applied file before it applies anything, and a
  changed file fails the run. A ledger row without a file is the database
  being ahead of the code after a rollback, and is tolerated.
- **Each migration runs under `lock_timeout` (5 s) and `statement_timeout`
  (60 s)**, set with `SET LOCAL` in the migration's transaction. A blocked
  `ALTER` fails within 5 s instead of queueing the live version's queries
  behind its lock; 60 s bounds a backfill or a non-concurrent index build,
  which holds its lock for as long as it runs.

**The runner owns each migration's transaction and settings**, for service
and application plans alike. Before any SQL runs, it refuses a file with a
top-level `BEGIN`, `START`, `COMMIT`, `END`, `ROLLBACK`, `ABORT`, `SAVEPOINT`,
`RELEASE`, `PREPARE TRANSACTION`, `SET`, `RESET`, `DISCARD`, `LISTEN`,
`NOTIFY`, `LOCK`, `VACUUM` or `CALL`, named by file and line; comments,
strings, quoted identifiers and dollar-quoted bodies are skipped. After the
file runs, a check in the same transaction fails it unless the transaction is
still the one the runner opened and, for an application, `lock_timeout`,
`statement_timeout` and `search_path` still have the runner's values. That
also catches `set_config()`. Without this, a `ROLLBACK` in a file recorded a
ledger row for nothing, and a `COMMIT` separated a file's effects from its row.

**An application migration may not escape its schema, its transaction or
the platform; database code in it is a deviation.** Code in the schema runs
on a later write where the data layer cannot see it: a trigger fired by one
guarded single-row update can change the rows of every tenant in the schema.
That is legitimate application code, so it is not refused: it is shown to the
approver as needing closer review ([ADR-0050](0050-approved-access.md)).
What is refused is what no review can make safe. The classifier is a coarse,
fail-closed defense in depth, not a Postgres grammar: where a form is hard to
read it refuses the form, and the least-privileged role of
[backlog 110](../backlog/110-give-each-application-a-least-privileged-database-role.md)
is the privilege boundary. Two checks run for every
application plan, the framework bundle included; service plans are not
checked, because a service is trusted platform code.

- **A static classifier, before any SQL runs** (`classifyMigration`,
  `@fabrika/platform-node/sql`). It is runtime-neutral, so Control classifies
  a commit's migrations in a Worker with the same code the runner uses. Every
  top-level statement is one of three:
  - **Paved:** `CREATE TABLE` with a column list and nothing after it (`LIKE`
    without `INCLUDING`; no `INHERITS`, `PARTITION`, `OF`, `TABLESPACE`,
    `WITH` or `USING`); `ALTER TABLE` whose clauses are each ADD/DROP of a
    column or a constraint (an exclusion constraint included), `ALTER
    COLUMN` with `TYPE`, `SET`/`DROP DEFAULT`, `SET`/`DROP NOT NULL` or an
    identity action, `VALIDATE CONSTRAINT`, or one `RENAME`; `CREATE
    [UNIQUE] INDEX`; `ALTER INDEX … RENAME TO`; `CREATE TYPE … AS ENUM`;
    `ALTER TYPE … ADD VALUE`/`RENAME VALUE`; `DROP` of a table, an index, a
    type or database code (an extension included, without `CASCADE`);
    `TRUNCATE`; `COMMENT ON` a table, column, view, index, sequence,
    routine, constraint, trigger, policy or rule of the schema (no `pg_…`
    name, no global target such as a role); and `INSERT`, `UPDATE` and
    `DELETE` for a backfill, whose nested statements are queries or
    `INSERT`/`UPDATE`/`DELETE` only (no `MERGE` in a CTE).
  - **Deviation** (a kind and an object name; the approval key is the two,
    never the line): a function or a procedure, a trigger, a view or a
    materialized view, a rule, a policy, an `ALTER … RENAME TO` of one of
    them, a `DO` block, and a
    default, `CHECK`, generated
    column or index expression that calls anything but a paved built-in
    (`now`, `gen_random_uuid`, `lower`, `upper`, `length`, the trims, `abs`,
    `round`, `trunc`, `floor`, `ceil`, `date_trunc`, `date_part`, `extract`,
    `AT TIME ZONE`, `array_length`, `cardinality`, `to_tsvector`,
    `to_tsquery` and the implicit casts).
  - **Refused**, by file and line: `COPY` in any form, `GRANT`, `REVOKE`,
    roles, `CREATE EXTENSION`, event triggers, a `serial` column and
    `CREATE SEQUENCE` (an identity column, `GENERATED … AS IDENTITY`, is the
    sequence the catalog check can tie to a column), a second signature for
    a routine name (no overloads), a domain (codegen cannot
    bind one, and the data layer would have to unwrap it), any other `ALTER`
    of database code, `SECURITY DEFINER`, a
    function `SET` clause, a language other than `sql` and `plpgsql`, any
    schema but the application's own (a `pg_…` relation counts as
    `pg_catalog`, and so does any unqualified `pg_…` name in DDL), any
    framework name (`fabrika_…`, case-insensitive, quoted
    or not; a file collection's own `fabrika_files_<name>` table and its
    indexes excepted, which `fileTableSql` writes into the application's
    migration), an `OPERATOR(schema.op)` of a schema other than
    `pg_catalog` and the application's, a routine named like a `pg_catalog`
    function or a keyword (`query_to_xml`, `operator`: Postgres resolves a
    call across the path by argument types, so the declaration would admit
    the built-in), a call through field selection (`(expression).f(…)`),
    a parenthesized target of `UPDATE`, `DELETE` or `INSERT INTO`, a
    Unicode-escaped name (`U&"…"`), a literal that never
    closes, and every form the classifier does not recognise, `SELECT`,
    `WITH` and `MERGE` included. An allowlist at every level: a form a later
    Postgres adds is refused, not executed.

  **A body is classified, not trusted.** A function or `DO` body is a
  dollar-quoted or plain single-quoted literal (an `E''` body and `BEGIN
  ATOMIC` are refused; `RETURN <expression>` is read in place). The
  classifier parses it with the same lexer and refuses dynamic `EXECUTE`, a
  statement outside the body allowlist (`SELECT`, `INSERT`, `UPDATE`,
  `DELETE`, `WITH`, `PERFORM`, `RETURN`, `RAISE`, PL/pgSQL control flow and
  assignments: so no `SET`, `RESET`, transaction control, DDL, `COPY`,
  `GRANT` or `LOAD`), and a name outside the schema. A qualified name counts
  as a schema only where it names a relation, a call or a type, so `NEW.x`,
  `OLD.x` and `alias.column` stay columns; a group in parentheses (`FROM
  (ONLY t)`, `FROM (a JOIN b)`) keeps its relation context, a typed literal
  (`ext.t '1'`) names a type, the source of `t%ROWTYPE` or `t.c%TYPE` is a
  relation, and every qualified name in a `DECLARE` section is a type. A
  statement nested in parentheses or ending a CTE list is a query or
  `INSERT`/`UPDATE`/`DELETE`. A routine's argument defaults are
  classified like its body, since they run at every call that omits the
  argument. A literal inside a body stays data: no statement a body may hold
  runs a string as SQL.

  **Function calls are an allowlist**, in bodies, views, policies, rules,
  trigger conditions and backfills alike: a name that `(` follows
  must be a paved or a reviewed built-in (pure string, number, date, JSON,
  array, text-search, window and aggregate functions, `pg_sleep`,
  `suppress_redundant_updates_trigger`) or a function the migration set
  declares in the schema. Anything else is refused, because a built-in such
  as `query_to_xml`, `cursor_to_xml`, `dblink`, `lo_import`, `pg_read_file`,
  `pg_advisory_lock` or `set_config` runs SQL from a string or reaches past
  the schema, which no name rule sees. In a stored expression a reviewed
  built-in or a declared function is a deviation.

  Each file also yields the database objects it declares. A routine has
  one signature, so it is named by its name alone. Folded in file order
  they are the **manifest**: a create adds an object (a replace, which
  writes the same argument list, keeps it), a rename moves it, a drop
  removes it, dropping a table removes its triggers, rules and policies,
  and renaming a table renames them. A call may name any routine the set
  creates or renames to. The file is split at every `;` outside a comment, a literal
  or a quoted body, with Postgres' lexical rules: whitespace is `[ \t\n\r\f\v]`
  only (a no-break space is part of a name), a `--` comment ends at a
  carriage return too, and a dollar tag has no length limit. Only files not
  applied yet are refused: an applied file is checksum-locked, so a
  statement refused today cannot lock an installation out of its next
  deploy.
- **A catalog check, the runtime witness** (`database-code.ts`). Control
  cannot reach the database (Alternatives), so the classifier, not the
  catalog, feeds the approval. The catalog check proves the classifier's
  account held: inside each migration's transaction, before its commit, it
  reads the schema and fails the transaction on an integrity escape (a
  function that is `SECURITY DEFINER`, has a `SET` clause or a foreign
  language; an event trigger on a function of the schema; any dependency on
  a type, function, relation, operator, operator class or collation outside
  the schema and `pg_catalog`; a routine that shadows a `pg_catalog` name,
  which also catches a name a later Postgres adds; a routine name with more
  than one signature; a sequence other than an identity column's) and on
  any function, procedure, aggregate, operator, trigger, rule, view, policy
  or domain that the manifest folded through that file does not name. So an object created at runtime, or by a route the classifier
  missed, fails the next migration and the next start until a migration
  declares or drops it.

Both run on settings they pin, not the session's. A migration runs with
`search_path` set to its schema, then `pg_catalog`, and with
`standard_conforming_strings` on. The guard names every function, operator
and type with `pg_catalog`. The catalog check sets `search_path` to
`pg_catalog` and `standard_conforming_strings` on again before it runs; its
query has no backslash and carries the manifest as hex text, so a file that
changed either setting cannot blind it.

`fabrika db codegen`, and so `codegen --verify` at every start, runs the same
catalog query against the manifest of all the migration files, in a
read-only transaction with the same pinned settings, whatever the role or
the database sets for its sessions. The test database does the same.

**These are name rules, not a privilege boundary.** A backfill runs once with
the credential's rights; the classifier sees its names and its calls, not
what the role may do. The complete fix is a least-privileged database role
per application, owning its schema and nothing else
([backlog 110](../backlog/110-give-each-application-a-least-privileged-database-role.md)).

The advisory lock key is the first 48 bits of SHA-256(`fabrika-db:<appId>`)
plus one, so applications that share one database do not serialize each other.
Migration file names are `YYYYMMDDHHMMSS_slug.sql` in `db/migrations/`; the
runner refuses any other name, as the checker does.

`fabrika db migrate` runs the migrations. It is the generated
`run.initCommands` entry of the application's execution descriptor
([ADR-0043](0043-validate-and-render-one-zerops-descriptor-meaning.md)), and it
uses the application's runtime credential: `FABRIKA_APP_ID` and
`FABRIKA_APP_DATABASE_URL`, read from the environment only. The checker
verifies migration file names, because an agent over MCP cannot run
`fabrika db new`. `fabrika db codegen` generates the schema's types from the
migrated database.

The pre-1.0 squash rule does not cover application ledgers. An application
migration that has run is immutable: a changed checksum fails the run, and a
change is a new file. Every new or changed
migration file is a widening in the approval diff
([ADR-0050](0050-approved-access.md)); that part is work unit B7.

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
- An application migration cannot use `CREATE INDEX CONCURRENTLY`, which
  Postgres refuses inside the per-file transaction; an index build holds its
  lock and must finish within the 60 s `statement_timeout`.
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
- An application migration may write a trigger, a function, a view or a
  policy; each is a deviation the approver sees as needing closer review,
  and the catalog check holds the schema to what the migrations declare. A
  domain, a `serial` column, an explicit sequence and a routine overload
  stay refused.
- An application cannot use an extension: `CREATE EXTENSION` is refused, and
  so is a type, an operator class or a function of an extension schema
  (pgvector, citext, `pg_trgm`, PostGIS). A built-in outside the function
  allowlist is refused everywhere; widening the allowlist is a reviewed
  change to the classifier.
- A migration may not name a framework table, so it cannot read a webhook
  secret or rewrite a job lease; a file collection's own table is the one
  exception.
- A function body must be dollar-quoted or a plain string literal, and may
  not build SQL from a string (`EXECUTE`).
- A migration cannot write the jsonb `?` operator: the driver reads a lone
  `?` as a placeholder. `?|` and `?&` work.
- Migrations and the runtime share one credential, so the running application
  holds the same schema rights as its migrations: application code that reaches
  a raw connection can still create a trigger, which the start check finds only
  at the next start. The classifier and the catalog check reduce what a
  migration can do; the complete fix is a least-privileged role per
  application, with separate migration and runtime credentials (backlog 110).

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
private network. The application container can. For the same reason the
approval cannot rest on the catalog check: Control decides from the commit,
so the static classifier is the detector and the catalog check its witness.

### Refuse every piece of database code

An earlier revision admitted only tables, indexes and enum types, and the
catalog check refused every trigger, function, view and expression outside the
reviewed built-ins. It made a trigger, an audit log or a cross-row invariant
impossible to write, so an agent moved the same logic into a handler where it
was no easier to review. Database code is now a deviation the approver sees;
only what escapes the schema, the transaction or the platform stays refused.

### A blocklist of dangerous built-ins

Refusing `dblink`, `lo_import` and their kind by name leaves every built-in
nobody listed, including ones a later Postgres adds. The function allowlist
refuses them by default.

### Let applications squash or edit applied migrations

An agent edits whatever refuses it. Without a checksum, an edited migration
that already ran would leave the live schema different from the files, and the
approval diff would see a change that never runs.

### Adopt the old filename-only ledger

Earlier revisions adopted rows from the unqualified `schema_migrations` table
when service-specific sentinel tables proved ownership. No production
installation depends on that ledger, so the adoption code and its fail-closed
probes were removed rather than maintained.
