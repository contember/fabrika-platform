---
id: 122
title: A generated case cannot seed a child row's state
blocked-by: []
---

# 122 — A generated case cannot seed a child row's state

**Summary.** The seed now leaves a foreign key outside the chain `null` or references a reference row, satisfies an
`IN` list CHECK, names what it cannot seed (`SeedLimitError`), `rows` names a row by id under every access form with
a scope (`on`, `in`, `over` and each capability), and `appRows` seeds a row of an application table, in a state, that a
leak and an own case read (the guide a link holder downloads). Two limits of the evidence remain. Effort: S–M.

## Problem

- **A child row's state.** `rows` (`src/__tests__/endpoint-access.fixtures.ts`) seeds one row of the named table in
  each scope's object with sampled values (`seedUnder`, `packages/db/src/testing.ts`). A link mutation whose
  precondition is a child row in a state (an open request, a delivery not yet sent) gets the first value of the
  state's enum or `IN` list, which may not be the one the handler needs.
- **The own case expects exactly 200** (`packages/check/src/scaffold.ts`, `endpointCases`). A mutation whose honest
  answer to "nothing to do" is 409 needs a seed of the state that makes it act.

## Approach / acceptance

- Consider the general form of relational fixtures: named rows (a child row, a reference row, a row in a state) that
  the kit seeds in both worlds, with their own values, and a case refers to by name.
- Witness: the isolation fixture (`packages/cli/src/__tests__/fixtures/isolation-app/`) gains a link mutation whose
  precondition is a child row in a state, and its regenerated tests pass.

## Touch points

`packages/db/src/testing.ts`, `packages/check/src/{endpoint-fixtures.ts,scaffold.ts}`,
`packages/app/src/testing/endpoint-access.ts`, `packages/app/skill/references/tests.md`.

<!-- Origin: the paved-road sprint, WU21 (the private dogfood), and a second application built on the paved road. -->
