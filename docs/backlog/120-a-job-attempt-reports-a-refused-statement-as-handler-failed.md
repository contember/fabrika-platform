---
id: 120
title: A job attempt reports a refused statement as handler_failed
blocked-by: []
---

# 120 — A job attempt reports a refused statement as handler_failed

**Summary.** A job whose handler meets a data-layer refusal (an undeclared `tx.sql` or `ctx.sql`, an undeclared
`unscoped` write) fails its attempt as `handler_failed`, with no reason. A request names the same refusal as
`query_refused: <reason>: <text>`. Effort: S.

## Problem

An undeclared `ctx.sql` / `tx.sql` of a job now throws `QueryRefusedError('undeclared_reach', …)`, and a declaring
job's `ctx.sql` outside `ctx.transaction` throws `sql_outside_transaction` (`packages/app/src/implement/invocation.ts`,
`undeclaredSql`, `jobSqlOutsideTransaction`). The job runner classifies a thrown value only as `lease_lost` or
`handler_failed` (`failureOf`, `packages/app/src/jobs/runner.ts`), so the attempt's log line, its Operations report
and the `JobRunResult` that `fabrika job run` prints carry `handler_failed`. The request path does better: `failureCode`
and `failureReason` (`packages/app/src/implement/failures.ts`) log the code, the reason and its catalog text.

## Approach / acceptance

- `JobFailureCode` gains `query_refused` (and, if it fits, `capability_refused`), chosen by `instanceof` as
  `failureCode` chooses it. The attempt's log line carries the reason and its fixed catalog text, never the message.
- The Operations job report and the `fabrika job run` output name the new code; `packages/cli/src/job.ts` lists it.
- Witness: the `orm-dispatch` job cases of an undeclared `tx.sql` and `ctx.sql` answer
  `{ status: 'failed', code: 'query_refused' }` and log `query_refused: undeclared_reach`, with nothing written.

## Touch points

`packages/app/src/jobs/{runner.ts,report.ts}`, `packages/app/src/implement/failures.ts`, `packages/cli/src/job.ts`,
`packages/app/src/__tests__/orm-dispatch.test.ts`, `packages/app/skill/references/errors.md`.

<!-- Origin: backlog 120 (an undeclared ctx.sql fails as a TypeError), whose request half shipped; the job half was rescoped here. -->
