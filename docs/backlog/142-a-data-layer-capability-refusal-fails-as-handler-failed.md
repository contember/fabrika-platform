---
id: 142
title: A data-layer capability refusal fails as handler_failed
blocked-by: []
---

# 142 — A data-layer capability refusal fails as handler_failed

**Summary.** When `@fabrika/db` throws its `CapabilityError` (a capability of the wrong kind, dimension or action), the
request answers 500 and the log line says only `handler_failed`. The author cannot see why. Effort: S.

## Problem

- `failureCode` and `failureReason` (`packages/app/src/implement/failures.ts:27`–`:52`) know `ServerFault`, the app's
  `CapabilityRefusedError` and `QueryRefusedError`. `@fabrika/db`'s `CapabilityError` (`packages/db/src/errors.ts:2`)
  is none of them, so it falls through to `handler_failed`, with no reason and no catalog text.
- An application built on the paved road upgraded the framework, and an `app` endpoint's
  `ctx.sql.scope(ctx.app, '<table>')` under an action the table does not read with started to throw (`checkAppReach`,
  `packages/db/src/store.ts:417`). The log line was `fabrika: <endpoint id>: handler_failed`. The author found the
  message only by printing the error in a local copy of `node_modules`.
  That fragment is now a type error at its table argument (`FragmentTable`, `packages/db/src/orm-types.ts`), so tsc
  catches this case; a fragment the types cannot judge (a write under a read action) still fails at run time.
- The job runner has the same blind spot (`failureOf`, `packages/app/src/jobs/runner.ts`); see
  [120](120-a-job-attempt-reports-a-refused-statement-as-handler-failed.md).

## Approach / acceptance

- `CapabilityError` gets a closed reason catalog, as `QueryRefusedError` has (`QUERY_REFUSALS`), and `failureCode`
  maps it to `capability_refused` (or a new code) with that reason. The log carries the reason and its fixed text,
  never the message, which can name a value.
- Do it together with 120, so a request and a job attempt name the same refusal the same way.
- Witness: a request case whose handler scopes a table its action does not reach logs
  `capability_refused: <reason>: <text>`.

## Touch points

`packages/db/src/errors.ts`, `packages/db/src/store.ts`, `packages/app/src/implement/failures.ts`,
`packages/app/src/jobs/runner.ts`, `packages/app/skill/references/errors.md`.
