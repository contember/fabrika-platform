---
id: 111
title: An attachment has no XLSX format
blocked-by: []
---

# 111 — An attachment has no XLSX format

**Summary.** `attachment()` encodes CSV only; an export a spreadsheet opens with typed cells and no import dialog needs
`format: 'xlsx'`. Effort: M.

## Problem

`attachment({ format, filename, row, maxBytes })` (`packages/app/src/contract/attachment.ts`) answers RFC 4180 CSV
(`packages/app/src/implement/attachment.ts`), and `buildArtifact` refuses every other `format`. CSV loses cell types
(a date or a number is text until the spreadsheet guesses), and its import dialog asks the reader for the encoding
and the separator. The paved-road sprint's design review dropped a hand-written XLSX writer from WU19: a ZIP container
and its XML parts are too much format to get right beside the CSV escape and the size bound, without a dependency.

## Approach / acceptance

- `format: 'xlsx'` on the same `AttachmentShape`: one sheet, the header row from the row schema's field names, a
  typed cell per column kind (number, boolean, text; a date string stays text unless the schema says it is a date).
- The same bounds as CSV: `maxRows`, the cell limit and `maxBytes` counted over the encoded file before anything is
  sent; the same formula rule (a text cell is an inline string, never a formula).
- Decide first: a vetted dependency or a framework writer (stored ZIP, inline strings), and its size in the package.
- Witness: a dispatch test that opens the file with an independent reader and finds each cell's type and value; an
  over-limit file sends no body; the approval diff names the format change.

## Touch points

`packages/app/src/contract/{attachment.ts,build.ts}`, `packages/app/src/implement/attachment.ts`,
`packages/auth-core/src/contract.ts` (`AttachmentShape.format`), `packages/app/src/contract/artifact-schema.ts`,
`packages/app/skill/references/endpoint.md`.

<!-- Origin: the paved-road sprint, WU19 and its binding design review (item 8). -->
