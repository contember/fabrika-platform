---
id: 287
title: An attachment's row schema is not compared with its approved columns
blocked-by: []
---

# 287 — An attachment's row schema is not compared with its approved columns

**Summary.** A file of rows is validated by the row schema the application evaluated, not by the approved one.
Effort: S.

## Problem

- Boot reads the contract artifact the build compiled. On an endpoint's first use, the runtime compares the schema the
  application evaluated with the approved shape (`packages/app/src/implement/approved.ts`). An attachment output is
  skipped there.
- An attachment's column names and order come from the approved shape, so no undeclared field reaches the file. Each
  cell is still validated only by the evaluated row schema.
- Failure scenario: the approved column is a `uuid` and the evaluated one is `z.string()`. The file then carries any
  string in that column.

## Approach / acceptance

- Compare the evaluated row schema's fields with the approved `columns[].shape` on first use, as `approvedOutput` does
  for JSON. A mismatch answers `schema_unapproved`.
- Witness: an approved artifact whose attachment column is narrower than the evaluated one gives a 500 with that fault,
  and a matching one serves the file.

## Touch points

- `packages/app/src/implement/approved.ts` (`approvedOutput`)
- `packages/app/src/implement/dispatch.ts` (the attachment answer)
