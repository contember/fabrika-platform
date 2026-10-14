---
id: 122
title: The generated tests cannot seed a foreign key outside the chain or name a child row
blocked-by: []
---

# 122 — The generated tests cannot seed a foreign key outside the chain or name a child row

**Summary.** Two seed limits break an ordinary schema's generated tests. The seed writes a text marker into a
nullable text foreign key, so every policy test fails with `23503`. And no fixture can name a seeded child row, so an
endpoint that addresses a child row by id gets a sample id and a 404. Effort: S–M.

## Problem

- **A foreign key outside the chain.** The isolation seed writes a marker into every text column, nullable or not
  (`isMarkable`, `packages/db/src/testing.ts:127`–`:130`; `insert`, `:325`–`:337`). A nullable foreign key to a
  reference table (a record's reason, taken from a code list) is a text column, so every seeded row breaks the key.
  Each policy test then fails with `23503`. `references/tests.md:41` advises "give it a default or make it nullable",
  which is what the agent did. To get green tests, the agent dropped the foreign key and checked the value in the
  handler instead. A `uuid` key is not affected: it is not text, so a nullable one is seeded `null`.
- **A child row by id.** A fixture sets the input (`fixtures`), the state of the dimension's own row (`seeds`) and a
  picked member (`members`) (`packages/check/src/endpoint-fixtures.ts:2`–`:6`; `scaffold.ts:175`). None can name a
  child row that the kit seeded. An endpoint `on` a record whose input names one of the record's child rows
  (`{ id, childId }`) gets a sample `childId` in its `own` and `leak` cases. That id belongs to no seeded row, so the
  case answers 404 and fails. The agent reshaped the endpoint to address the child rows by another field.
- **The seeds shape the domain model.** A second application built on the paved road met all of these, and a `CHECK`
  on a text column, which fails the seeded marker rows (`references/tests.md:51`–`:52` advises an `ENUM` instead).
  It changed its contract to fit the generator: a withdrawal addresses the consent by purpose, not by the child row's
  id. A link mutation whose precondition is a child row (an open request, a delivery) cannot be seeded either, and its
  own case expects exactly 200 (`packages/check/src/scaffold.ts:293`–`:298`), so the application answers 200 for
  "nothing to do" where a 409 is the honest answer. `askAs` throws on every 400 as a broken fixture
  (`packages/app/src/testing/endpoint-access.ts:362`–`:365`), so a handler's own 400 for a domain refusal reads as the
  author's mistake.

## Approach / acceptance

- The seed leaves a column that holds a foreign key outside the containment chain unmarked: `null` when nullable. A
  required one keeps the existing refusal ("give the column a default or make it nullable"), with the key named.
  Its leak markers come from the row's other text columns.
- A fixture can name an input field as a child row of a table, like `members`:
  `export const rows = { '<endpoint id>': { childId: '<child table>' } }`. The kit then seeds one row of that table
  under each world's target and sends its key. The leak case sends the other world's key.
- Consider the general form instead of one export per case: declarative relational fixtures with named rows (a
  child row, a reference row, a row in a state), which the kit seeds in both worlds and a case refers to by name. A
  schema or endpoint the generator cannot seed is reported as a generator limit, with the column or field named, not
  as a failing case of the handler.
- Witness: the isolation fixture (`packages/cli/src/__tests__/fixtures/isolation-app/`) gains a nullable text
  foreign key to a reference table and an `on` endpoint with a child id field, and its regenerated tests pass.
  `references/tests.md` ("Fixtures and seeds") then drops "and not text" from its advice on such a key.

## Touch points

`packages/db/src/testing.ts`, `packages/check/src/{endpoint-fixtures.ts,scaffold.ts}`,
`packages/app/src/testing/endpoint-access.ts`, `packages/cli/src/__tests__/fixtures/isolation-app/`,
`packages/app/skill/references/tests.md`.

<!-- Origin: the paved-road sprint, WU21 (the private dogfood). -->
