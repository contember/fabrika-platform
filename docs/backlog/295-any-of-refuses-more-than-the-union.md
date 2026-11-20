---
id: 295
title: An anyOf endpoint refuses some work that one of its held actions alone may do
blocked-by: []
---

# 295 — An anyOf endpoint refuses some work that one of its held actions alone may do

**Summary.** Under `access: { anyOf, app: true }`, `ctx.db.app` reaches the union of what each held action reaches alone
and refuses what that union cannot express. In three places the refusal is wider than the union, so a caller holding
more listed actions can do less. Nothing widens access. P2 for the first item, P3 for the others.

## Problem

- **An insert under several path conditions** (`packages/db/src/store.ts` `insertCondition`, and `upsertingActions`
  for an upsert). With `when: { 'o.a': { 'kind_id.tag': { eq: 'a' } }, 'o.b': { 'kind_id.tag': { eq: 'b' } } }`, an
  insert of `{ kind_id: 'ka' }` passes under `o.a` alone. Under `anyOf(['o.a', 'o.b'])` it is refused as
  `unenforceable`, because the insert check follows at most one path. Dispatch maps only `wrong_action` to 403, so this
  answers a recorded 500 that depends on what the caller holds.
- **`ctx.sql.scope`** (`store.ts` `heldCondition`). It refuses when any held action has a `when`, even one that does
  not admit the operation. Under `anyOf([X.read, X.edit])`, where only `X.edit` has a `when`, a read fragment is
  refused. A caller holding only `X.read` gets every row.
- **A column with its own read action** (`policy.ts` `readsAsAction`). It shows only where its action reads every row,
  or where that action is the only held action reaching the operation. Under `anyOf(['p.del2', 'p.self'])`, `get` hides a
  `p.self` column on a row `p.self` alone reads. The rule is deliberate: per-row masking was the alternative.

## Approach / acceptance

- **Insert and upsert:** judge several path conditions as one OR inside the insert's transaction, the way
  `judgeInserted` judges one, so a row passes when any held action's condition admits it. A test: the insert above
  succeeds under `anyOf(['o.a', 'o.b'])`, and a row neither condition admits is a 409.
- **`ctx.sql.scope`:** consider only the held actions that admit the use. The scope is `'all'` when one of them has no
  `when`; it is refused only when each of them has one. A test with the scenario above.
- **Own-read columns:** decide whether per-row masking (`CASE WHEN <when[X]>`) is worth its cost. Filters, sorts and
  aggregates on such a column would still have to be refused. Otherwise keep the rule and document it as final.
- Every change keeps a single-action grant byte-for-byte as before, and keeps the round-3 widening probes of
  `packages/db/src/__tests__/any-of-sqlite.test.ts` passing.

## Touch points

`packages/db/src/store.ts` (`insertCondition`, `upsertingActions`, `heldCondition`), `packages/db/src/policy.ts`
(`readsAsAction`), `packages/app/src/implement/dispatch.ts` (`heldActionsRefused`).

<!-- Origin: review round 3 of the anyOf PR. -->
