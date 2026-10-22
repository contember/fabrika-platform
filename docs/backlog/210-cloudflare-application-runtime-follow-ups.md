---
id: 210
title: Cloudflare application runtime follow-ups
blocked-by: []
---

# 210 — Cloudflare application runtime follow-ups

**Summary.** Smaller gaps left by the Cloudflare application runtime (ADR-0065). P3 each, size S.

## Problem

1. **An orphan R2 object.** An object reset during `ctx.files.put` (after the R2 write, before the commit) leaves an
   object with no `fabrika_files` row; the sweep only finishes deletions it recorded.
2. **`ilike` on non-ASCII text.** SQLite's `like` folds ASCII case only, so `ilike` on SQLite misses `Č`/`č`.
3. **An existing Worker with its own Durable Object tag.** The provider writes its migration tag; a Worker whose
   config already used that tag fails with 10074.
4. **The job list is built twice.** `packages/app/src/cloudflare/application.ts` derives the due jobs (declared jobs
   plus the file sweep) on its own, beside the boot's list in `packages/app/src/implement/boot.ts`; a new framework job
   added to one is missed by the other.
5. **IAM's mint answer is parsed by three schemas**: `packages/proxy-core/src/iam.ts`,
   `packages/app/src/implement/workload.ts` and `packages/app/src/cloudflare/bindings.ts`. One exported schema in
   `@fabrika/auth-core` would serve all three.
6. **The public and sensitive variable names are listed in each provider** instead of once in `@fabrika/provider-contract`.

## Approach / acceptance

1. Record the object key in `fabrika_files` as `pending` before the R2 write, as the Bun path does, or sweep R2
   objects without a row. 2. Document it, or fold with a registered function. 3. Detect the tag and refuse with a
   message. 4–6. Deduplicate. Each with a test where one can reach it.

## Touch points

`packages/app/src/cloudflare/`, `packages/db/src/sqlite.ts`, `packages/provider-cloudflare/`, `packages/auth-core/`,
`packages/provider-contract/`.
