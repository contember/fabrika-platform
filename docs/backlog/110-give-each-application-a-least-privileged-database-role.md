---
id: 110
title: Give each application a least-privileged database role
blocked-by: []
---

# 110 — Give each application a least-privileged database role

**Summary.** An application's migrations and its runtime use one credential, which may own far more than the
application's schema. The migration classifier and the catalog check narrow what a migration can do; only a role that
owns the application's schema and nothing else bounds it. Large effort; a security boundary.

## Problem

ADR-0017 checks every application migration twice: a static classifier before any SQL runs
(`packages/platform-node/src/migration-classify.ts`) and a catalog check before the commit
(`packages/platform-node/src/database-code.ts`). Both are name rules and stop at what the credential may do:

- A backfill, a function body and a view run with the credential's rights. The classifier admits only allowlisted
  built-ins and refuses a `pg_…` relation, another schema and a framework `fabrika_*` table by name; a built-in it
  admits, or a route it misses, still runs with whatever the role holds. Database code (triggers, functions, views)
  is now a deviation the approver reviews, which raises what a mistake in a reviewed body can reach.
- Application code that reaches a raw connection holds the same rights. It can create a trigger or set a role-level
  setting at runtime; the start check (`fabrika db codegen --verify`) finds the trigger only at the next start.
- The local stack and the test backends connect as a superuser, so nothing exercises a lesser role today.

## Approach / acceptance

- Each application gets a role that owns `app_<id>` and holds no other privilege: not superuser, no `CREATEROLE`, no
  `CREATEDB`, no `pg_execute_server_program`, no `pg_read_server_files`, no membership in another role.
- Migrations and the runtime use separate credentials of that role family: the runtime role has DML on the schema's
  tables and no DDL.
- Witness: a Postgres test in which the application role cannot update a catalog table, call `lo_unlink` on an object
  it does not own, create a function in another schema or run `COPY … PROGRAM`, and the runtime role cannot create a
  trigger.

## Touch points

`packages/provider-zerops/` (the database credential it writes), `packages/local-stack/` (the stack's roles),
`packages/platform-node/src/application-postgres-migrations.ts`, `docs/decisions/0017-service-owned-postgres-migrations.md`.

<!-- Origin: the second review of backlog 108's migration checks. -->
