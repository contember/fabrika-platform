---
id: 143
title: No server code reads a file collection
blocked-by: []
---

# 143 — No server code reads a file collection

**Summary.** A handler or a job cannot list a record's files, read a file's scan state or open its bytes, and only a
dimension table can own a collection. So an e-mail cannot attach a stored file, and a mutation cannot require that a
document was uploaded. Effort: M; it needs a decision first.

## Problem

An application built on the paved road met three walls:

- **No read.** Neither `EndpointContext` nor `JobKitContext` has a files handle (`packages/app/src/contract/context.ts`).
  `ctx.sql` refuses every `fabrika_*` name (`sql_name`), no `unscoped` declaration reaches a `fabrika_files_*` table,
  and a migration view over it is refused: `a reference to the framework's fabrika_files_documents is not allowed`
  (`packages/platform-node/src/migration-classify.ts:332`). Only the collection's own endpoints read it
  (`packages/app/src/files/collections.ts`).
- **The owner must own a dimension.** `build.ts:904` refuses an owner that is not a dimension table, so an application
  table (an outgoing e-mail, a catalogue entry) cannot own a collection of attachments.
- **No total bound.** `maxBytes` bounds one file and `maxPerOwner` the count; "at most 10 MB together" cannot be checked.

What the application did: its e-mails carry no attachment, and its "complete with a document" request type is refused
(400) until the server can see the document.

## Approach / acceptance

- Decide the handle: `ctx.files.<collection>.list(owner)` (id, status, size, created_at) for a handler or job that
  holds the collection's `read` on the owner, and `open(id)` (a stream) for a job, under the same action. Design it
  together with [129](129-a-job-cannot-remove-a-records-files.md), which needs the same handle for removal.
- Decide whether an application table may own a collection (the `app` form's capability), and whether a collection
  takes a per-owner byte total.
- Witness: a job that attaches an owner's clean file to an e-mail; a mutation that refuses while no clean or
  quarantined file exists; a refusal for a capability without the collection's `read`.

## Touch points

`packages/app/src/files/collections.ts`, `packages/app/src/contract/{context.ts,build.ts,define.ts}`,
`packages/app/src/jobs/runner.ts`, `packages/app/skill/references/files.md`.
