---
id: 160
title: An XLSX text cell loses carriage returns
blocked-by: []
---

# 160 — An XLSX text cell loses carriage returns

**Summary.** A review finding on the XLSX writer of backlog 143/144/111, P2. Effort: S.

## Problem

- **XLSX carriage return.** `packages/app/src/implement/xlsx.ts:83` writes CR literally inside an inline string. XML
  parsing normalizes CR and CRLF to LF, so a text cell does not keep its value.

## Approach / acceptance

- Write CR as `_x000D_` (keep tab and LF); add independent-reader round trips for CR, CRLF and a literal `_x000D_`
  in `attachment-xlsx.test.ts`.

## Touch points

`packages/app/src/implement/xlsx.ts`, `packages/app/src/__tests__/attachment-xlsx.test.ts`.

<!-- Origin: the GPT review of backlog batch H. -->
