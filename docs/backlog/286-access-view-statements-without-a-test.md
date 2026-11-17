---
id: 286
title: Access view statements without a test
blocked-by: []
---

# 286 — Access view statements without a test

**Summary.** The data layer's access views (ADR-0076) are tested for lists, counts, `on` and `in` bindings, a
principal-bound `Ref`, an insert under a `Ref` and `relates`. Several statements that carry the same term have no test
of their own. Effort: S.

## Problem

`packages/db/src/__tests__/access-views.test.ts` has no case for:

- an aggregate through the term;
- a queue claim through the term;
- a `Ref` delete through the relation;
- a move into a destination held through the relation;
- an insert into a node that no table owns, held only through an access relation, which must be refused;
- a row reached through two containers, through the dispatcher rather than a hand-built capability.

The fixture has no delete action, no queue, no dimension without an owning table, and no containment between
`account` and `company`. So each case needs a fixture change of its own.

## Approach / acceptance

Extend the fixture, or add one beside it, with each missing shape. Add one test per bullet above, on SQLite and on
Postgres.

## Touch points

`packages/db/src/__tests__/access-views.test.ts`.

<!-- Origin: review round 1 of the data layer's access views PR. -->
