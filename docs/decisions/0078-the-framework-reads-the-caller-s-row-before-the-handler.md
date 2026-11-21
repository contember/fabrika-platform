---
id: 0078
title: The framework reads the caller's row before the handler
status: accepted
date: 2026-11-21
---

# 0078 — The framework reads the caller's row before the handler

## Context

An application usually keeps its own row per person: a staff card, a profile, an account, bound to the IAM principal
by a column that holds the principal id. IAM grants outlive what the application knows about the person: a card is
archived, a person is not yet bound to one, and the roles in IAM still admit them. So every handler starts the same
way: read the caller's row, refuse with 403 when there is none or when it is archived, then do the work.

A large application on the framework measured the cost: 1 116 handlers start with the same call, in 147 modules, and
only five procedures skip it on purpose (the one that binds the account to its card, for one). The refusal is a
convention: a new endpoint that forgets the line serves an archived person, and the application tests the refusal
through one endpoint, not through every one. It also reads the row through each endpoint's own `ctx.db`, which works
only because that table is readable by every action.

## Decision

1. **An application declares its caller row once, in `defineApp`'s options:**
   `caller: { table, principal, missing, refuse? }`. `table` holds one row per person, `principal` is the text column
   that holds the person's principal id, `missing` is the message of the 403 for a person without a row, and `refuse`
   lists rules `{ column, equals | not, message }`: the first rule the row meets is a 403 with its message. The rules
   are data, not a function, because `src/app-kit.ts` is part of the contract's literal source graph, which the static
   reader reads without evaluating it.
2. **Every procedure of an RPC group that names callers reads it, unless it opts out with `caller: false`.** The
   default is on, so a new endpoint cannot forget it. A public procedure, a link or export procedure, a job and a
   webhook read none; `caller: false` anywhere else is refused by the types and again by `serve`.
3. **The read runs after the proxy's decision and before the access form, in the invocation's transaction.** Order:
   the requirement, admission, the input, the caller's row, the access form, then the handler. A `creates` access form
   asks IAM to create a scope, so a person without a row or with a refused one gets the 403 before IAM is asked and
   before the handler runs; nothing is created or written. The handler gets the row as `ctx.caller`, typed as the
   table's row read with its read action; a file column of it is a reference the request may serve and open.
4. **Only a person has a row.** A `human` caller's principal id is looked up; any other caller kind of the group
   (`machine`) gets `ctx.caller === null`, which the type says (`Row | null` for a group of `['human', 'machine']`).
5. **The read is the framework's own, of one table, by the principal column only.** `@fabrika/db`'s handles gain
   `rowsNaming(table, column, value)`, an unscoped read of at most two rows that no application handle reaches. It
   reads the columns the table's read action reads, whatever the endpoint's action. Two rows for one principal are a
   500 (`caller_ambiguous`), never a pick of one; a refusal that names a column the row does not hold is a 500
   (`caller_column`), never a pass.
6. **It is framework API, not platform protocol.** Neither the declaration nor `caller: false` reaches the contract
   artifact: the static reader accepts both and the artifact is the one the same contract without them compiles to.
   The proxy, Control and IAM see nothing of it, and it decides no access: the proxy's decision already ran, and the
   access form still runs after it. It is authorization in the vocabulary of `docs/reference/overview.md`, like `.require`.

## Consequences

- The 403 for an unbound or archived person is tested once by the framework (`caller.test.ts`), not by each
  application endpoint, and a new endpoint has it without a line of code.
- An application reads its caller row with every procedure, also one whose handler would not have read it: one
  indexed select per request. The principal column should carry a unique index; without one, a second row is a 500.
- A handler sees the caller's whole row (the columns of the table's read action) even where its own action could not
  read that table. That is the declaration's purpose: the row is the caller's own, named by the token's principal id.
- A procedure that must run before a row exists (binding an account to a card) declares `caller: false` and reads
  `ctx.principal` itself.
- No installation, environment variable or provider state changes; an application meets the API only when it raises
  its pin and declares `caller`.

## Alternatives considered

- **A refusal function in the declaration** (`refuse: (row) => string | null`). It reads naturally, but the static
  reader refuses a function in the contract's source graph, and moving the declaration out of `src/app-kit.ts` would
  separate it from the types that give `ctx.caller` its row type.
- **A group-level prologue** (`app.group({ callers, caller })`). Each group would have to repeat it, so a new group
  could forget it, which is what the convention already suffers from.
- **Reading through the endpoint's own `ctx.db`.** It works only where the endpoint's action reads the caller table,
  and member, `creates` and several-capabilities endpoints have no `ctx.db.app` at all.
- **Recording the declaration in the artifact for Control.** It decides nothing the platform enforces, and an artifact
  change is a protocol change (ADR-0062) for no reader.
