---
id: 110
title: Give each application a least-privileged database role
blocked-by: []
---

# 110 — Give each application a least-privileged database role

**Summary.** An application's migrations and its runtime use one credential, which may own far more than the
application's schema. The migration allowlist and the catalog check narrow what a migration can do; only a role that
owns the application's schema and nothing else bounds it. Large effort; a security boundary.

## Problem

ADR-0017 checks every application migration twice: a statement allowlist before any SQL runs
(`packages/platform-node/src/migration-allowlist.ts`) and a catalog check before the commit
(`packages/platform-node/src/database-code.ts`). Both stop at what the credential may do:

- A backfill (`INSERT`, `UPDATE`, `DELETE`) runs once with the credential's rights and may call any built-in that
  resolves unqualified, `lo_unlink` and `pg_advisory_lock` included. On a superuser credential, an unqualified
  `UPDATE` of a catalog table rewrites a built-in that the catalog check trusts by name; the allowlist refuses a
  `pg_…` relation, which is a name rule, not a privilege.
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
