---
id: 104
title: The query builder cannot express common reports
blocked-by: []
---

# 104 — The query builder cannot express common reports

**Summary.** `@fabrika/db`'s scoped query description covers lists, search, counts and children, but not the next
reports an application asks for. The decided answer is declared, scoped report kinds, never raw access. Needs a design
pass; medium to large effort.

## Problem

A store reaches rows only through `ScopedSelect` (`packages/db/src/description.ts:109`: `columns`, `where`,
`whereAny`, `contains`, `orderBy`, `limit`, `offset`, and an inner `join` to a declared child) and `t.aggregate`
(`packages/db/src/store.ts:561`: `groupBy`, `count`, `sum`, `min`, `max`, and `where` conditions only). The data-layer
spike found that the five most common queries of a notes application fit: a paginated list, search, a count per
workspace, the comments of a note, the latest N. These do not:

- an aggregate over a join (notes with their comment counts);
- "notes without comments" (no `LEFT JOIN`, no `NOT EXISTS`);
- nested AND/OR groups (`whereAny` is one OR group);
- SQL functions (`lower`, `date_trunc`);
- full-text search and JSON columns.

There is no unscoped handle and no `sql` template, by design (`packages/db/CLAUDE.md`, "No raw handle leaves the
package"; `@fabrika/check` refuses raw SQL). An agent that hits one of these gaps will push for raw access, or load
every row and compute in the handler.

## Approach / acceptance

- Add the most common shapes as declared report kinds of the scoped layer: each takes a `Ref` or a `Within`, carries
  its scope predicate as the top-level conjunct, and passes the operation-tree guard. Start from the list above,
  ordered by what real applications ask for.
- Never add a raw handle, a `sql` escape or an unscoped capability to close a gap.
- Witness: each new kind gets attack rows in `guard.test.ts` and `type-attacks.test.ts`, and an isolation case in the
  generated tests (a caller of one scope sees no row of the other).

## Touch points

`packages/db/src/description.ts`, `packages/db/src/nodes.ts`, `packages/db/src/guard.ts`, `packages/db/src/store.ts`,
`packages/db/CLAUDE.md`, `packages/app/skill/SKILL.md`, `docs/reference/application-runtime.md`.

<!-- Origin: the application framework plan's "out of scope for v1" (deleted at close; see git history). -->
