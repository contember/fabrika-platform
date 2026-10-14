---
id: 157
title: An endpoint holds one capability
blocked-by: []
---

# 157 — An endpoint holds one capability

**Summary.** An access form hands one capability. An operation that reads records of one dimension and writes into
another (match records to a partner's request, hand chosen ones over into the partner's scope) goes off the road:
raw SQL and `unscoped` reads. Effort: M–L; it needs a decision first.

## Problem

- `AccessContext` gives one of `target`, `within` or `created` (`packages/app/src/implement/types.ts:22`–`:26`).
- An application built on the paved road ranks records of one dimension against a request of another, then copies
  the chosen fields into the request's scope. The ranking holds the records' read action (`app: true`) and reads the
  request through `unscoped`; the handover holds the request and reads the records, and their related rows
  `unscoped`, and writes in raw SQL (`sql: 'write'`). Two declared deviations for one ordinary workflow.
- [97](97-the-generated-tests-have-no-move-case.md) needs the same: a move takes two `Ref`s.
  An export of every record no longer needs one: a table names its export action in `actions.appRead`
  ([ADR-0012](../decisions/0012-fabrika-app-runtime.md) §7).

## Approach / acceptance

- Decide one access form for two capabilities (each an action and a dimension or `app`), checked by the proxy as two
  requirements and handed as two minted capabilities, and how the generated tests cover it.
- Witness: the handover as an endpoint with two capabilities, no `unscoped` and no `sql`, with its generated cases.

## Touch points

`packages/app/src/contract/`, `packages/app/src/implement/{types.ts,dispatch.ts,invocation.ts}`,
`packages/auth-core/src/requirement.ts`, `packages/check/src/scaffold.ts`, `packages/app/src/testing/endpoint-access.ts`.
