---
id: 207
title: The Cloudflare application runtime is unverified on a live account
blocked-by: []
---

# 207 — The Cloudflare application runtime is unverified on a live account

**Summary.** ADR-0065's runtime is tested on Lopata and `bun:sqlite` only. Several facts it relies on are read from
workerd's source or wrangler's help, not probed. P1 before a Cloudflare installation serves an application; size M.

## Problem

`docs/reference/cloudflare-platform.md` marks what is _not verified live_. The runtime also assumes:

1. `wrangler deploy --secrets-file` turns an existing plain variable of the same name into a secret in one deploy.
2. R2's conditional put (`onlyIf`) behaves as the file store's create-only write expects.
3. A proxy Worker whose `define` bakes a manifest of 100 KB and more uploads and boots.
4. The provider's Durable Object migration (`new_sqlite_classes`) applies to an existing application Worker, including
   one that already declared a tag of its own.
5. The input gate holds back the answer to the object's own I/O made outside `storage.transaction`, which is why the
   handler runs inside it (`InvocationTransaction.enclose`).
6. A transaction started inside the callback nests as a savepoint on workerd, as on Lopata.
7. Kysely's SQLite compiler emits `?` parameters, which `sql.exec` binds on workerd.
8. Foreign keys are enforced in an object's SQLite.

## Approach / acceptance

A probe per row on a throwaway Worker in a test account, deleted after; each result moves into
`cloudflare-platform.md` with its date. Then deploy `examples/app` through a Cloudflare installation and run its
opice suite against it. A row that fails is a bug against ADR-0065, not a note.

## Touch points

`docs/reference/cloudflare-platform.md`, `packages/provider-cloudflare/`, `packages/app/src/cloudflare/`,
`packages/db/src/sqlite.ts`.
