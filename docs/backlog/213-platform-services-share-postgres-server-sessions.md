---
id: 213
title: The platform services share Postgres server sessions on Zerops
blocked-by: []
---

# 213 — The platform services share Postgres server sessions on Zerops

**Summary.** On a Zerops installation one Postgres server session serves IAM, Operations and Control in turn. A
statement prepared by one process outlived it and broke the next; find out what else crosses that boundary, and decide
whether the services should connect directly. Investigation first; small fix or an ADR after.

## Problem

The `db` service's log on the test installation (2026-10-22) shows one backend session, identified by its pid and its
per-session line counter (`log_line_prefix` `%l`), running Operations' migration, then IAM's migration, then Control's
migration and Control's reads. The services run in separate containers, so something between them and Postgres hands
a server session from one client to the next.

It caused a production-shaped failure: a `SELECT *` the previous Control process had prepared before migration 0017's
`ADD COLUMN` survived in the session, and the new Control process failed every read of `dev_environments` with
`cached plan must not change result type` (0A000). `PostgresDatabase.connect` (`packages/platform-node/src/sql-postgres.ts`)
now sets `prepare: false`, which removes that symptom and nothing else.

`packages/provider-zerops/src/namespace/constants.ts` says the platform connects on the direct port, not on
pgBouncer's port 6432. The session evidence contradicts that, or the direct port is pooled too.

## Questions

1. **Is there a pooler, on which port, in which mode?** Read the generated connection strings of the four services,
   ask Zerops, and measure: open two clients from two processes, print `pg_backend_pid()` and a session-level `SET`
   from each, and check whether the second sees the first's. Record the answer in
   `docs/reference/zerops-platform.md`.
2. **Can session state leak between services?** The ADR-0017 migration runners take session-level advisory locks
   (Control `4471902583`, IAM and Operations their own) on a one-connection client, and so does the application grant
   step (`application-postgres-grants.ts`). If a session outlives the process
   that took the lock, the next service may inherit it, or a crashed runner may leave it held. The same question for
   `SET` (`search_path`, `role`, `statement_timeout`), temporary tables and `LISTEN`. Name each piece of session state
   the platform uses and whether it can cross.
3. **Should the services connect directly?** If the pooler is avoidable, compare a direct connection per service
   (connection count against the light tier's limit, which `size-database` sizes) with staying pooled and making every
   session-state use pooler-safe (transaction-level advisory locks, `SET LOCAL`, a reset on checkout).
4. **What does `prepare: false` cost?** Every statement is parsed and planned where it runs, and parameters travel as
   text. Measure the hot paths (the proxy manifest read, IAM's token verification reads, Control's RPC reads, the
   Operations ingest) with and without prepared statements, under `cpu-lease`.

## Approach / acceptance

- The four questions answered with measurements in `docs/reference/zerops-platform.md`.
- Either a decision to connect directly, with the provider change and the rollout path of an existing installation,
  or pooler-safe session use with a test that runs two processes over one session and shows that no lock or setting
  crosses.
- Keep `prepare: false` unless the measurement shows a cost that matters and the session question is solved.

## Touch points

`packages/platform-node/src/{sql-postgres,postgres-migrations,service-postgres-migrations,application-postgres-grants}.ts`,
`packages/{control,iam,operations}/src/**/migrate.ts`, `packages/provider-zerops/src/namespace/constants.ts`,
`packages/provider-zerops/src/installation/`, `docs/reference/zerops-platform.md`.

<!-- Origin: the dev-environment retest of 2026-10-22, commit 92521f6f (platform-node: prepare no named statement). -->
