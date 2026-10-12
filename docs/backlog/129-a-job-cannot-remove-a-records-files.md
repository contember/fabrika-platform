---
id: 129
title: A job cannot remove a record's files
blocked-by: []
---

# 129 — A job cannot remove a record's files

**Summary.** An erasure or retention job that anonymizes a record but keeps its row cannot remove the record's files.
An orphaned file's object waits for the next upload or remove request, because no scheduled sweep runs.
Effort: S–M.

## Problem

- Only the collection's own endpoint removes a file: `POST files.<name>.remove`, under the collection's `delete`
  action (`#remove`, `packages/app/src/files/collections.ts:385`). A job has no handle on a collection: the job runner
  gives `ctx.db`, `tx.db` and `tx.sql`, and no files.
- Deleting the owner row orphans its files (`ON DELETE SET NULL`, `packages/app/skill/references/files.md:104`), and
  the sweep deletes orphaned objects. But the sweep runs only from an upload, a remove, or the scan pass of a
  `scan: true` collection (`collections.ts:316`, `:391`, `:427`). `sweep()`, documented as "for a framework job to run
  on a schedule" (`:415`), has no caller. So an orphaned object of a collection that does not scan stays in storage
  until someone uploads or removes a file in that collection.
- The dogfood needs both erasure (blank a record's personal data and delete its files, but keep its consent and
  status history) and retention (anonymize stale records on a schedule). A cron job can blank the columns today. It
  cannot remove the files.

## Approach / acceptance

- A job, and a mutation `on` the owner, get `ctx.files.<collection>.removeAll(owner)`, under the collection's
  `delete` action. It marks the owner's files removed in the invocation's transaction, and the sweep deletes their
  objects after the commit.
- A framework cron job runs `sweep()` for every collection, so an orphaned or removed object leaves storage within one
  period, whether the collection scans or not.
- Witness: a job test that blanks a record and removes its files, after which a `list` answers none and the store
  holds no object after the next sweep. A collection without `scan` loses an orphaned object to the scheduled sweep
  without any request.

## Touch points

`packages/app/src/files/collections.ts`, `packages/app/src/jobs/runner.ts`, `packages/app/src/implement/boot.ts`,
`packages/app/skill/references/{files.md,jobs.md}`.

<!-- Origin: the paved-road sprint, WU21 (the private dogfood). -->
