---
id: 209
title: A public procedure binds a token's row id to its purpose
blocked-by: []
---

# 209 — A public procedure binds a token's row id to its purpose

**Summary.** A public procedure updates or deletes a row whose id appears anywhere in any verified signed token of its
request. Bind the id to the token's purpose and the table it names, so one token unlocks only the row it was signed
for. P3, size M; it changes the framework API.

## Problem

ADR-0063 §3 lets a public procedure update or delete only a row "that a verified signed token of this request
carries". The implementation reads that literally:

- `TokenVerifier.verifyFields` (`packages/app/src/implement/tokens.ts:155-170`) verifies each token field of the
  input or the query (`packages/app/src/implement/dispatch.ts:523`, `:534`, `:633`) and adds every string anywhere in
  its claims to one `carried` set (`collectTexts`, `tokens.ts:207-215`).
- The public site's `update` and `remove` accept an id that is in that set (`packages/db/src/orm.ts:649-659`), for
  every versioned table the procedure reaches under its declared actions.

So the purpose of the token, the field it arrived in, the claim that held the text and the table are all lost. An
application that signs two purposes (a booking link and a newsletter link), or puts more than the id in a token's
claims (an email address, another row's id), lets a token signed for one row unlock another row of another table
whose id equals any of those texts. With UUIDv7 ids a collision needs a claim that holds a real row id of the other
table; the risk is an application that signs related ids together.

## Approach / acceptance

Let a token purpose declare what it names: the table, and the claim that holds the row id (for example
`signs: { booking: { table: 'bookings', id: 'bookingId' } }`, or a typed `ctx.tokens.sign` whose claims schema marks the
id). The public site then accepts an id for a table only from a token whose purpose names that table, and only the
marked claim. To decide:

- The declaration's shape in the contract (ADR-0012 §14), and whether the contract artifact carries it. If the
  artifact or the manifest changes, it changes additively (ADR-0062): a 0.7 contract without it keeps today's reading.
- Whether an undeclared purpose keeps today's "any text" reading, with a checker warning, or stops unlocking rows.
- The migration guide for an application that relies on today's reading.

Witness: a public procedure test where a token of purpose `a` naming a row of table `x` cannot update a row of table
`y` with the same id, and a token whose claims hold a second id unlocks only the marked one.

ADR-0063 §3 and ADR-0012 §14 are rewritten with the decision.

## Touch points

`packages/app/src/implement/tokens.ts`, `packages/app/src/implement/dispatch.ts`, `packages/app/src/implement/invocation.ts`,
`packages/db/src/orm.ts`, `packages/app/src/contract/`, `packages/check/`, ADR-0012, ADR-0063.

<!-- Origin: a platform review; ADR-0063 §3 now states the current reading. -->
