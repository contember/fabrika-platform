---
id: 112
title: An update that sets no column answers 500
blocked-by: []
---

# 112 — An update that sets no column answers 500

**Summary.** An edit endpoint whose input fields are all optional answers 500 when the caller sends none, because the
data layer's refusal of an empty update reaches the client as a framework failure, not a 400. Effort: S.

## Problem

`updateValues` (`packages/db/src/store.ts:492`) refuses an update that sets no column (`{}`, or only `undefined`
values) with `QueryRefusedError('invalid_argument', …)`, before anything is sent. Every handle and store update goes
through it (`packages/db/src/orm.ts:316`, `:352`, `:489`; `store.ts:898`, `:981`). The framework maps every
`QueryRefusedError` to a 5xx with code `query_refused` (`packages/app/src/implement/failures.ts:34`), so the caller
gets `Internal error` and the server logs a failure for what is the caller's input.

The generated tests hit it: the scaffold omits every optional field from a case's input
(`packages/check/src/scaffold-sample.ts:47`), so an edit endpoint with only optional fields fails its generated
cases. The skill works around it by telling agents to make every edited field required
(`packages/app/skill/references/endpoint.md:66`, `references/errors.md:75`). A real partial-update endpoint (a
patch form that sends only the changed fields) cannot follow that advice.

## Approach / acceptance

- Decide first: the empty update answers 400 (a `BadRequestError` the framework raises for a handle update of an
  empty value set, naming the update columns), or the handle answers the current acknowledgement and writes nothing.
  The data layer keeps refusing to bump the version alone either way.
- The generated case of an edit endpoint with only optional fields passes without a fixture.
- Witness: an `orm-dispatch` test where an endpoint updates with `{}` and answers the chosen status, with no row
  changed and no 5xx log line; the skill's "every field required" rule and the 500 row of `errors.md` are rewritten.

## Touch points

`packages/db/src/{store.ts,orm.ts,errors.ts}`, `packages/app/src/implement/{failures.ts,dispatch.ts}`,
`packages/check/src/scaffold-sample.ts`, `packages/app/skill/references/{endpoint.md,errors.md}`.

<!-- Origin: the paved-road sprint, WU10's trial app (docs/archive/sprint-2026-10-11-paved-road-framework.md). -->
