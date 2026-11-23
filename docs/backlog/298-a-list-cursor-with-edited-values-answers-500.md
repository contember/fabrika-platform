---
id: 298
title: A list cursor with edited values answers 500 on Postgres
blocked-by: []
---

# 298 — A list cursor with edited values answers 500 on Postgres

**Summary.** A well-formed list cursor whose values a client edited is not refused as the caller's 400; on Postgres a
value the order column's type cannot parse fails the statement (500 and a failure report). Small; P2.

## Problem

`decodeCursor` (`packages/db/src/orm.ts`) refuses a cursor that does not decode, has another shape, or names another
table or order (`list_cursor`, answered 400 by `errorResponse` in `packages/app/src/implement/dispatch.ts`). It cannot
tell an edited value from one the database printed: the cursor is unsigned, and the layer knows the type of only some
columns (`dates`, `timestamps`, `booleans`, `json` through `rowColumnsOf`), not a uuid or a number. So a cursor carrying
`"x"` for a uuid, integer or timestamp order column reaches the statement, Postgres refuses the bound text, and the
request answers 500 (`DatabaseError`). On SQLite it pages from the edited position. Rows stay within the capability's
scope either way: no leak, a 500 any client can provoke.

The cursor also carries the table and its order columns by their database names, in plain base64url JSON.

## Approach / acceptance

Sign the cursor with a key the framework already holds (`FABRIKA_TOKEN_KEYS`, as `implement/tokens.ts` signs tokens),
handed to the data layer at bind, and refuse an unsigned or mis-signed cursor with `list_cursor`; the signed payload can
then carry a digest of the table and order instead of their names. A cheaper partial step: refuse a value that does not
parse for a column whose type the layer knows. Acceptance: `list-cursor.test.ts` gains an edited-value case answered
400 on SQLite and, under `FABRIKA_TEST_POSTGRES_URL`, on Postgres.

## Touch points

`packages/db/src/orm.ts` (`encodeCursor`, `decodeCursor`), the data layer's bind (`@fabrika/db/framework`),
`packages/app/src/implement/boot.ts`, `packages/app/src/__tests__/list-cursor.test.ts`.

<!-- Origin: review of the PR that made a malformed list cursor a 400. -->
