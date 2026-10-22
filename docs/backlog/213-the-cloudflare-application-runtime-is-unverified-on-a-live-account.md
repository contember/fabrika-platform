---
id: 213
title: The Cloudflare application runtime is unverified on a live account
blocked-by: []
---

# 213 — The Cloudflare application runtime is unverified on a live account

**Summary.** ADR-0065's runtime is tested on Lopata and on a local workerd (`wrangler dev`), not on an account. Three
facts it relies on cannot be checked locally. P1 before a Cloudflare installation serves an application; size M.

## Problem

`docs/reference/cloudflare-platform.md` records what a local workerd run settled (savepoints, the input gate, `?`
parameters, R2's conditional put, a 230 KB `define`, foreign keys) and what was probed on an account. Still open:

1. `wrangler deploy --secrets-file` turns an existing plain variable of the same name into a secret in one deploy.
2. The provider's Durable Object migration (`new_sqlite_classes`) applies to an existing application Worker, including
   one that already declared a tag of its own (216 item 3).
3. The account accepts the upload of a proxy Worker whose `define` bakes a manifest of 200 KB and more (it builds and
   runs locally).

## Approach / acceptance

A probe per row on a throwaway Worker in a test account, deleted after; each result moves into
`cloudflare-platform.md` with its date. Then deploy `examples/app` through a Cloudflare installation and run its
opice suite against it. A row that fails is a bug against ADR-0065, not a note.

## Touch points

`docs/reference/cloudflare-platform.md`, `packages/provider-cloudflare/`, `packages/app/src/cloudflare/`,
`packages/db/src/sqlite.ts`.
