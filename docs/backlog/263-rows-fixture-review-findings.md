---
id: 263
title: The rows fixture leaves an in report with a unique row per target and a few checker gaps
blocked-by: []
---

# 263 — The rows fixture leaves an in report with a unique row per target and a few checker gaps

**Summary.** Review findings on `rows` under every access form (#107) that did not block it: one narrow case the kit
cannot seed and three small gaps. Effort: S.

## Problem

- **An `in` report whose named table allows one row per target.** The leak case of an `in` endpoint with `sql`
  (`inScopesOf`, `packages/app/src/testing/endpoint-access.ts`) seeds worlds of every table that lies in the dimension,
  and the named table among them. On the named table's own turn, its world row already lies in the target, and
  `rowsIn` adds a second row there. Under known scope values every turn shares the target, so the named rows pile up
  in it. A unique index on the container column (one settings row per workspace) then fails with a `SeedLimitError`
  that asks for a default or a nullable column. The checker accepts the fixture. `on`, the `in` denial, `over` and
  capabilities seed the named row once per scope and are not affected.
- **The capability cases cannot show where a row lands.** Each capability case expects a refusal before the handler
  runs, so its rows prove only that the kit seeds them, not where. Placement was checked by hand, not by a test.
- **Two keys of one endpoint can name the same field** (`'X#a': { f: 't' }` and `'X#b': { f: 't' }`). `inputOf`
  (`packages/check/src/scaffold.ts`) keeps the last one, and no finding is raised.
- **Messages and docs.** A field finding under a `#capability` key prints the endpoint id, not the key, and reads "in a
  organization". `docs/reference/application-runtime.md` says one row per scope, where the `in` leak case seeds one per
  table that lies in the dimension. The `EndpointAccessKit.capability` doc comment does not mention rows.

## Approach / acceptance

- On the named table's own turn, use its world row as the named row. Under known scope values, seed each named row
  once per side and reuse it. Witness: an `in` endpoint with `sql` over a table with `unique (workspace_id)` passes its
  leak case, with fresh and with known scope values.
- A capability placement test that reaches the handler, for example the other capability refused after the named one
  is minted, or a test that watches the seeded rows' scopes.
- An `endpoint-fixture` finding for a field named under two keys. Name the key in field findings, fix the article, and
  correct the two docs.

## Touch points

`packages/app/src/testing/endpoint-access.ts`, `packages/check/src/scaffold.ts`, `docs/reference/application-runtime.md`.

<!-- Origin: review round 1 of the rows-under-every-access-form change (#107). -->
