---
id: 160
title: A link client lists other mounts' collections, and an XLSX loses carriage returns
blocked-by: []
---

# 160 — A link client lists other mounts' collections, and an XLSX loses carriage returns

**Summary.** Two review findings on the file client and the XLSX writer of backlog 143/144/111, both P2. Effort: S.

## Problem

- **Link client.** `packages/app/src/client/contract.ts:253` gives every link mount's client every `link: true`
  collection, whatever the owner's dimension; `HolderFiles` types them the same way. With a note mount and an invoice
  mount, the note client advertises `files.invoices`, whose endpoints do not exist under its prefix (404). A link
  mount with a procedure group named `files` then makes `createClient` throw, even when none of the collections is
  bound to it. `buildArtifact` serves a collection only under the link mounts bound to the owner's dimension.
- **XLSX carriage return.** `packages/app/src/implement/xlsx.ts:83` writes CR literally inside an inline string. XML
  parsing normalizes CR and CRLF to LF, so a text cell does not keep its value.

## Approach / acceptance

- Filter the link client's collections by the mount's dimension and the owner's, at run time and in the types (the
  contract's `c.files` would carry the owner's dimension as a literal), matching `buildArtifact`; refuse the `files`
  group only where a collection applies. Test two link mounts of different dimensions; update the reference text.
- Write CR as `_x000D_` (keep tab and LF); add independent-reader round trips for CR, CRLF and a literal `_x000D_`
  in `attachment-xlsx.test.ts`.

## Touch points

`packages/app/src/client/{contract.ts,files.ts}`, `packages/app/src/contract/define.ts`,
`packages/app/src/implement/xlsx.ts`, `packages/app/src/__tests__/{files-client,attachment-xlsx}.test.ts`,
`docs/reference/application-runtime.md`.

<!-- Origin: the GPT review of backlog batch H. -->
