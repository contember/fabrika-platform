---
id: 122
title: The leak sweep cannot seed a child row's state and says nothing when a mutation answers 409
blocked-by: []
---

# 122 — The leak sweep cannot seed a child row's state and says nothing when a mutation answers 409

**Summary.** A row the sweep seeds for a `GENERATED_ROW_PREFIX` input gets sampled state, and `seeds` covers only the
addressed row, so a mutation whose precondition is a child row in a state answers 409. The sweep counts that as answered
and prints no hint, so the endpoint's write path is never checked and nobody is told. Effort: S–M.

## Problem

`seedUnder` (`packages/db/src/testing.ts`) gives the named row the first value of its state's enum or `IN` list, which
may not be the one the handler needs. `leakOutcome` (`packages/app/src/testing/endpoint-access.ts`) treats any answer
but 401, 403, 404 and 5xx as answered, so a precondition's 409 passes silently.

## Approach / acceptance

- Let the sweep's options give a named row its values (a child row, a row in a state), seeded in both worlds.
- Print a hint when an asked mutation answers 409, naming the option that would give it the state it needs.
- Witness: a link mutation whose precondition is a child row in a state reaches its handler in the sweep.

## Touch points

`packages/db/src/testing.ts`, `packages/app/src/testing/endpoint-access.ts`, `packages/app/src/testing/leak-sweep.ts`,
`packages/app/skill/references/tests.md`.

<!-- Origin: the paved-road sprint (WU21); rescoped to the leak sweep after the generated tests were removed. -->
