---
id: 134
title: A SQL scope fragment does not tie its action to the statement
blocked-by: []
---

# 134 — A SQL scope fragment does not tie its action to the statement

**Summary.** `ctx.sql.scope(capability, table)` renders the rows a capability reaches, whatever the statement does
with them and whatever the table's actions are. A `sql: 'write'` site can write a dimension table under an `app`
fragment of its read action, and a `Ref` or `Within` fragment scopes a table whose actions do not name its action.
Effort: S–M; it needs a decision first.

## Problem

- `scopeTerms` (`packages/db/src/store.ts:337`–`:385`) checks for a `Ref` and a `Within` only that the table's chain
  holds the dimension (`:340`–`:349`, `:356`–`:359`); it never compares the capability's action with the table's
  actions. For an `app` capability it checks the read action since WU23c (`checkAppReach`, `:416`–`:434`), and then
  answers every row.
- The fragment knows nothing of the statement. `scope(capability, table, alias?)` takes no operation
  (`packages/db/src/sql.ts:569`–`:581`), and the tag classifies the text only after it spliced the fragments in
  (`:557`–`:558`).
- So on a `sql: 'write'` site `update candidates set … where ${ctx.sql.scope(ctx.app, 'candidates')}` under the read
  action renders `(true)` and updates every row, although `ctx.db.app.candidates` is read-only
  (`packages/db/src/orm.ts:420`–`:421`). A `Ref` of a read action scopes an `update` of its own object; a `Within`
  scopes a read of a table whose read action is another to the caller's scope. A `sql: 'write'` statement also still
  writes a reference table, which no handle writes (WU23b's Run log).
- `packages/db/CLAUDE.md` describes the fragment as "what the handles of `capability` match"; the handles check the
  action and the operation, the fragment does not. `sql: 'write'` is a declared deviation with a closer-review line,
  and the runtime role bounds it to the schema, so this is a gap in the road's promise, not an escape.

## Approach / acceptance

Decide one of these:

- **(a) The fragment takes the statement's operation.** The tag passes the classified statement's kind and, for an
  `UPDATE` or `DELETE`, its target table; a fragment on that table requires the capability's action to be the
  table's action for that operation (and an `app` capability an application table), and a fragment elsewhere requires
  an action the table reads with, as the handles do. A reference table as an `UPDATE`/`DELETE`/`INSERT` target is
  refused.
- **(b) State it.** A fragment scopes rows, not actions. `packages/db/CLAUDE.md`, the runtime reference and the
  skill say that `sql: 'write'` is the declaration the approver reviews, and the fragment does not stand for it.

- Witness: `raw-sql.test.ts` cases for each grant kind: a write under a read action, a read under an action the table
  does not name, and a reference table as a write target.

## Touch points

`packages/db/src/{sql,store}.ts`, `packages/db/src/__tests__/raw-sql.test.ts`, `packages/db/CLAUDE.md`,
`docs/reference/application-runtime.md`, `packages/app/skill/references/endpoint.md`.

<!-- Origin: the paved-road sprint, WU23c (out of its scope) and WU23b's Run log. -->
