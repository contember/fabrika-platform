---
id: 144
title: The typed client has no file collections and no answer type
blocked-by: []
---

# 144 — The typed client has no file collections and no answer type

**Summary.** `createClient` covers RPC and link procedures only, so an SPA uploads and lists files with a hand-written
`fetch`, and the client exports no type for a procedure's input or answer. Effort: S–M.

## Problem

- **Files.** `packages/app/src/client/contract.ts` builds a tree of procedures; `files.<name>.upload`, `.list` and the
  download are not in it. An application built on the paved road wrote the upload as the `fetch` that
  `packages/app/skill/references/public-intake.md` shows, with the link key as a bearer. To show whether a document was
  uploaded, a staff screen would need the same hand-written call to `/api/files.<name>.list`.
- **Types.** `packages/app/src/client/index.ts` exports `ProcedureCall` and `ContractClient`, but no `ResultOf` /
  `InputOf`. A view that maps an answer needs its type; the application wrote both helpers itself over the client's
  function types.

## Approach / acceptance

- The client gains `files.<name>` per collection the mount serves (`upload(owner, file)`, `list`, `download`), typed by
  the contract, for a session and for a link key.
- `@fabrika/app/client` exports `ResultOf<F>` and `InputOf<F>` (or equivalent) for a client procedure.
- Witness: a client test that uploads, lists and downloads through a link client against the test kit, and a type
  test of the two helpers. The skill's recipe drops the hand-written `fetch`.

## Touch points

`packages/app/src/client/{contract.ts,index.ts}`, `packages/app/skill/references/{files.md,public-intake.md}`.
