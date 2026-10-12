---
id: 115
title: A burst of Postgres batches larger than the pool hangs
blocked-by: []
---

# 115 — A burst of Postgres batches larger than the pool hangs

**Summary.** `PostgresDatabase.batch` opens a Bun SQL transaction that can sit idle on a pooled connection while
the pool's other queries queue behind it, so a concurrent burst of batches larger than the pool never finishes.
IAM, Control and Operations all run on this port on Zerops. Effort: M; the root cause is in Bun SQL.

## Problem

`PostgresDatabase.batch` (`packages/platform-node/src/sql-postgres.ts:115`) runs every statement of a batch inside
`this.sql.begin(run)` (`:126`); `PostgresDatabase.connect` opens Bun's default pool, which IAM
(`packages/iam/src/node/runtime.ts:99`), Control (`packages/control/src/zerops/runtime.ts:117`) and Operations
(`packages/operations/src/node/runtime.ts:24`) use as is. WU18 found that under concurrency a batch holds its
connection idle in its transaction while pool queries queue behind it; with more concurrent batches than pooled
connections, the process hangs.

Only one caller is worked around: `AuditWriter.run` (`packages/iam/src/repositories/audit.ts:197`) sends a single
audited statement without a transaction, which is always the case on Postgres. Every other `batch` call (in 10 IAM,
3 Operations, 1 Control and 4 platform-node source files) keeps the hazard, and a run of concurrent requests that each
write a batch is ordinary load for IAM. `durable-audit.test.ts` gives itself a pool of its own (`:754`) for the same
reason.

## Approach / acceptance

- First reproduce it outside the services: a pool of `max: 2` and five concurrent `batch` calls of two statements
  each, on Bun 1.3.14, the version the sprint ran. Find whether `begin` waits for a connection the queued pool
  queries hold, or a queued statement waits behind the open transaction.
- Then fix it in the port, not per caller: for example a batch reserves its connection before `BEGIN` and sends its
  statements only on it, or the port bounds concurrent batches below the pool size. Report an upstream Bun issue
  when the cause is Bun's.
- Witness: a `sql-postgres` test (needs `FABRIKA_TEST_POSTGRES_URL`) with more concurrent batches than pooled
  connections, mixed with plain queries, finishes within its timeout; `durable-audit.test.ts` no longer needs its
  own pool.

## Touch points

`packages/platform-node/src/sql-postgres.ts`, `packages/platform-node/src/__tests__/`,
`packages/iam/src/repositories/audit.ts`, `packages/iam/src/__tests__/durable-audit.test.ts`.

<!-- Origin: the paved-road sprint, WU18 run log ("the Bun SQL hang, diagnosed"). -->
