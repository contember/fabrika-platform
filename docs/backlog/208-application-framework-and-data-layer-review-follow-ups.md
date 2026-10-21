---
id: 208
title: Application framework and data layer review follow-ups
blocked-by: []
---

# 208 — Application framework and data layer review follow-ups

**Summary.** Six small findings in `@fabrika/app` and `@fabrika/db`. None is reachable as a hole today: a type, a
read-only session or a clock in sync stops each. P3, size S each unless noted.

## Problem

1. **The ALTCHA replay record mixes two clocks.** The verifier computes how long to keep a solution from the
   application's clock (`recordMs = expiresAt * 1000 - Date.now() + maxSkewMs`,
   `packages/app/src/implement/challenge.ts:268`), and the record expires on the database's clock
   (`now() + $3 * interval '1 millisecond'`, `packages/db/src/admissions.ts:73`). If the application's clock runs more
   than `maxSkewMs` (60 s) ahead of the database's, a record expires before the challenge does and a replay passes.
2. **A public procedure's insert is built with `bound`, not `writing`.** `packages/db/src/orm.ts:688` wraps `insert`
   in `bound(site, …)`, so the site-kind refusal of `writing` (`orm.ts:215-222`) never runs for it. A query-kind public
   site that calls `insert` is stopped only by the types and the `READ ONLY` session, and answers 500 instead of the
   typed `read_only` refusal.
3. **`.input()` silently drops an earlier `.require()`.** `ProcedureBuilder.input` returns a new builder with no
   requirements (`packages/app/src/rpc/builder.ts:45-48`). `t.procedure.require(x).input(schema)` compiles and runs
   without `x`. No call in the repository has that order today.
4. **Prototype methods in data-layer checks.** The rule in `packages/db/CLAUDE.md` ("The guard and every policy and
   allowlist check use only the built-ins `builtins.ts` captured at load…") names `store.ts`, and `scopeTerms`
   (`packages/db/src/store.ts:411-470`) uses `slice`, `map` and `join`. Outside the rule's list,
   `packages/db/src/file-references.ts:45-59` calls `Set.prototype.add` and `has` on the readable-id set (its WeakMap
   methods are captured), and `readsFile` (`packages/db/src/file-columns.ts:29-31`) calls `Array.prototype.includes`.
   A same-process patch of those methods changes a check that already ran its guard.
5. **Under `in`, a top-level scope's own row offers an `insert` that cannot succeed.** `in` and `creates` both bind
   `ctx.db.target` with the `in` `TargetForm` (`packages/app/src/implement/invocation.ts:370-373`), and that form
   gives the scope's own table an `OwnerRow` with `insert` (`packages/db/src/orm.ts:297-298`,
   `packages/db/src/orm-types.ts:413`). An `in` request resolves only a value that exists
   (`packages/app/src/implement/dispatch.ts:772-785`: not found otherwise), so its own row is always there and the
   insert always conflicts. Only `creates` can insert it.
6. **`Admissions.releaseBytes` is dead.** Its one caller went with the old forms; charging the whole `maxBytes` is
   the decision (ADR-0061 §7, ADR-0012). The method and `SQL_RELEASE_BYTES` stay
   (`packages/db/src/admissions.ts:31`, `:64`, `:106-110`) with only their own test.

## Approach / acceptance

1. Let the verdict carry an absolute expiry (ALTCHA's signed `expiresAt`; for Turnstile its issue time plus the
   maximum age) and keep the record until that time plus `maxSkewMs` in SQL, so the database's clock alone decides.
   Witness: an admissions test (Postgres) with an application clock 5 minutes ahead.
2. Use `writing(site, 'insert', …)`. Witness: a query-kind public procedure's `insert` refuses with `read_only`.
3. Make `.input()` after `.require()` a type error (a builder state without requirements is the only one with
   `.input`), or keep the requirements. Witness: a type test in the builder's tests.
4. Replace them with index loops and a `NameSet` (or the captured built-ins of `builtins.ts`), and add
   `file-references.ts` and `file-columns.ts` to the rule's list in `packages/db/CLAUDE.md`. Witness: extend the
   patched-prototype cases of the data layer's attack tests to these checks.
5. Give `creates` its own `TargetForm` (`created`) that holds the `OwnerRow`, and drop the own table from `in`. Size
   S–M: the types, the binding and the checker's expectations change; an application that inserts its own row under
   `in` fails to compile, which it already fails at run time.
6. Delete `releaseBytes`, `SQL_RELEASE_BYTES` and their test.

## Touch points

`packages/app/src/implement/challenge.ts`, `packages/db/src/admissions.ts`, `packages/db/src/orm.ts`,
`packages/db/src/orm-types.ts`, `packages/app/src/implement/invocation.ts`, `packages/app/src/rpc/builder.ts`,
`packages/db/src/store.ts`, `packages/db/src/file-references.ts`, `packages/db/src/file-columns.ts`,
`packages/db/CLAUDE.md`.

<!-- Origin: a platform review. -->
