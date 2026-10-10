---
id: 108
title: Application migrations can install triggers and functions
blocked-by: []
---

# 108 — Application migrations can install triggers and functions

**Summary.** The migration runner plans, and the checker accepts, an application migration that creates a function and
a trigger, so a guarded single-row write can fire database code that writes other rows past the data layer. A defect
against the data layer's claim that handlers reach rows only through a capability. Medium effort.

## Problem

`packages/db/CLAUDE.md` states that handlers reach rows only through a capability and only for the operation its
action allows; ADR-0012 lists "code around the framework" among the mistakes it designs against. A trigger is such
code, installed by SQL instead of TypeScript:

- `definePostgresApplicationMigrations(...).plan()` (`packages/platform-node/src/application-postgres-migrations.ts:78`)
  checks the file name and foreign-schema references; `refusedStatement` (`packages/platform-node/src/migration-sql.ts:183`)
  refuses transaction-control and session statements only. `CREATE FUNCTION` and `CREATE TRIGGER` pass both.
- The checker has one migration rule, `migration-name`, so it reports nothing.
- `fabrika db codegen` (`packages/db/src/codegen.ts`) reads columns, nullability, enum labels and whether a default
  exists; `codegen --verify` at start cannot see a trigger, a rule or an executable default.

Reproduced on `main` (4f02fcd8), without executing SQL: a migration with a `plpgsql` function that updates every other
`deals` row and an `AFTER UPDATE` trigger calling it is planned by the runner and produces zero checker findings. A
`deals.move` that changes one scoped row would then change rows of every tenant in the application's schema.

[Backlog 98](98-application-migrations-have-no-destructive-change-rules.md) decided a checker finding for views,
triggers, functions, `GRANT`, `SECURITY DEFINER` and policy statements, as part of its expand-only rules. This item is
the enforcement half where the SQL runs, so that it holds on every path that migrates (`fabrika db migrate`, the
start script, `test-isolation`) and for objects that predate the rule.

## Approach / acceptance

- The application runner refuses, before executing anything, a top-level `CREATE [OR REPLACE] FUNCTION`, `PROCEDURE`,
  `TRIGGER`, `RULE`, `VIEW`, `MATERIALIZED VIEW`, `EVENT TRIGGER`, `POLICY`, `EXTENSION`, `LANGUAGE`, `DO` and
  `GRANT`/`REVOKE`, on the tokenizer it already has (`statementStarts`), naming the file and line. The framework bundle
  is exempt only if it ever needs one, by name.
- A column default must be a constant or one of a small allowlist (`now()`, `gen_random_uuid()`); anything else is
  refused the same way.
- The start check (beside `codegen --verify`) refuses a schema that holds a trigger, rule, function or non-allowlisted
  default, so a legacy object installed before the rule is found.
- Witness: one runner fixture per refused statement; a Postgres test that a schema holding a trigger fails the start
  check; the example application's migrations stay accepted.

## Touch points

`packages/platform-node/src/migration-sql.ts`, `packages/platform-node/src/application-postgres-migrations.ts`,
`packages/db/src/codegen.ts` (or the start script's check), `packages/platform-node/CLAUDE.md`,
`docs/decisions/0017-service-owned-postgres-migrations.md`, `docs/reference/application-runtime.md`.

<!-- Origin: the security critique of docs/ideas/agent-friendly-app-framework.md. -->
