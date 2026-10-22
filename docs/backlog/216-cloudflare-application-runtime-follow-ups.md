---
id: 216
title: Cloudflare application runtime follow-ups
blocked-by: []
---

# 216 — Cloudflare application runtime follow-ups

**Summary.** Smaller gaps left by the Cloudflare application runtime (ADR-0065), most from its review. P3 each
unless marked, size S.

## Problem

1. **An orphan R2 object.** On SQLite a file's pending row is written in the invocation's transaction, so only the
   work's memory knows its object until the commit; a known rollback deletes it (`FileWork.wrote`). An object reset
   between the R2 write and the commit loses that memory and leaves an object with no `fabrika_files` row.
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
7. **P2: one handler holds the whole environment.** `enclose` opens the object's transaction before the handler runs,
   so a handler that awaits an outside API for 2 s caps its environment at half a request a second. The deploy caps a
   handler at 25 s (`CLOUDFLARE_MAX_HANDLER_MS`); the serialization itself is not documented for authors.
8. **P2: an application id `<app>-files` takes `<app>`'s files bucket.** `foreignApplication`
   (`packages/provider-cloudflare/src/bounds.ts`) decides by the longest prefix, so app `notes-files` adopts
   `env-notes-files` as its own. The same prefix class predates the bucket (`notes` naming a resource `admin` against an
   app `notes-admin`).
9. **A missing proxy secret fails at request time.** Without `FABRIKA_CONTROL_VAULT_KEY` the deploy writes no
   `FABRIKA_PROXY_SECRET`, succeeds, and every request then fails; the deployer should refuse it.
10. **A failed boot stays failed** for the object instance (`packages/app/src/cloudflare/application.ts`): a transient
    `load()` failure is retried only after eviction.
11. **`like` ignores ASCII case on SQLite**, unlike Postgres; scope predicates use `=` and are unaffected.
12. **No read-only backstop on SQLite.** `openSqlite` ignores `readOnly`, so a fixed framework write in a read-only
    session is refused only by the classifier, where Postgres's `READ ONLY` transaction refuses it too.
13. **`DEFAULT CURRENT_TIMESTAMP`** in an application migration stores `YYYY-MM-DD HH:MM:SS`, which every read of the
    table refuses as `unexpected_row`; codegen or the checker should refuse it and name the `strftime` default.
14. **A binding's method cannot be feature-detected.** On workerd an RPC stub answers `in` and `typeof` with a function
    for every name (local workerd, `wrangler dev` 4.74.0), so `method()` (`packages/app/src/cloudflare/bindings.ts`)
    never reports a missing IAM method, and `boot`'s "no membership transport" refusal cannot fire on Cloudflare; a
    missing method fails at its call. Lopata's stub answers `false`, unlike workerd, which also breaks `bun run dev`
    of `examples/app` (the object finds no `IAM`), and Lopata applies no wrangler `define`, so the example's proxy has no
    manifest. Both are Lopata fixes. So is a third: `lopata/testing` replaces the global `Request` with one that keeps
    the source request's headers when `new Request(request, { headers })` passes others, which broke the proxy tests run
    after it in one process; `bun run test` runs the Lopata suites in `test:lopata`, isolated, until Lopata is fixed.

## Approach / acceptance

1. The sweep lists the bucket's keys and deletes an object past the pending grace that no row names. 2. Document it,
   or fold with a registered function. 3. Detect the tag and refuse with a message. 4–6. Deduplicate. 7. Document it;
   open the transaction at the first statement where the input gate allows. 8. A platform-owned name no application id
   can produce, or refuse such an id at registration. 9–13. As stated. 14. Detect by the IAM release, or drop the detection; fix Lopata's stub and `define`. Each with a test where one can reach it.

## Touch points

`packages/app/src/cloudflare/`, `packages/db/src/sqlite.ts`, `packages/provider-cloudflare/`, `packages/auth-core/`,
`packages/provider-contract/`.
