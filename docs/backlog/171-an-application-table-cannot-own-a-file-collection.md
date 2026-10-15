---
id: 171
title: An application table cannot own a file collection
blocked-by: []
---

# 171 — An application table cannot own a file collection

**Summary.** E-mail attachments chosen by staff for an application-wide record (a mail template, a bulk send) cannot be
built: a file collection's owner must be a table with a dimension scope, and nothing bounds the total size of one
owner's files. Effort: M; needs a decision on the access form first.

## Problem

- **The owner must own a dimension.** `build.ts` refuses a collection whose owner's scope is not `dimension`: "its
  owner '…' is not a table with a dimension scope" (`packages/app/src/contract/build.ts:975`;
  `packages/app/skill/references/files.md:3`). The collection's endpoints are then `on` the owner's dimension
  (`build.ts:993`, `:1018`). An application table (`scope: 'app'`) has no dimension, so a record such as a send or a
  template that only staff write cannot carry files.
- **No total per owner.** A collection bounds one file (`maxBytes`) and the file count (`maxPerOwner`)
  (`packages/app/src/contract/declaration.ts:251`). A provider's limit on one e-mail is a total ("at most 10 MB
  together"), which `maxPerOwner × maxBytes` only approximates. The job that attaches the files learns about an
  overflow only when it reads them.

`ctx.files(…).open(owner, id, { maxBytes })` already reads a file's bytes from a handler and a job (`files.md:94`), so
the read side is not the gap.

## Approach / acceptance

- Decide the access form for an application-table owner: the collection's actions held app-wide (`{ action, app: true
  }`), as the table's own `app` endpoints are. It is an access-form change: read
  [ADR-0022](../decisions/0022-the-proxy-is-the-only-enforcement-point.md) first. Then accept an
  `app` owner in `build.ts`, with `ctx.files` taking an `app` capability for it. Witness: a contract fixture whose
  collection is owned by an application table builds; its upload, list, open and remove run under app-wide actions in a
  kit test, and a caller without the action is refused.
- `maxBytesPerOwner` on the declaration, checked at upload where `maxPerOwner` is
  (`packages/app/src/files/collections.ts:422`, `:459`).
  Witness: an upload that would take one owner past the total is refused with 413, and the next owner is unaffected.

## Touch points

`packages/app/src/contract/{build.ts,declaration.ts,define.ts,artifact-schema.ts}`, `packages/app/src/files/`,
`packages/app/skill/references/files.md`.

<!-- Origin: framework gaps an application built on the paved road met on the 0.4.1 React stack. -->
