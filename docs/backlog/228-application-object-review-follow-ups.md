---
id: 228
title: Application object review follow-ups
blocked-by: []
---

# 228 — Application object review follow-ups

**Summary.** The P2s and open decisions the reviews of the application object sprint's waves 0–3 left. None blocks
a release; each is small.

## Problem

**Checker (`packages/check`).**

1. `cloudflare-current-timestamp` skips exactly one parenthesis: `DEFAULT ((CURRENT_TIMESTAMP))` passes
   (`src/rules/migrations.ts:60`).
2. The refusal tokenizes SQLite with the shared Postgres lexer. A bracket or backtick identifier gives a false
   positive, and a non-nested `/* */` comment gives a false negative (`migrations.ts:57`). It needs a SQLite mode in
   the tokenizer (shared with [214](214-raw-sql-on-sqlite.md)).

**Timers.**

3. `packages/auth/src/rpc-http.ts:386` and `packages/email/src/http.ts:27` still use `AbortSignal.timeout` in the
   Cloudflare bundle. An uncancelled timer keeps the object resident. They are allow-listed as `UNCLEARED` in
   `packages/provider-cloudflare/src/__tests__/cloudflare-bundle.test.ts`.
4. The timer witnesses of a webhook delivery and of a public procedure need Postgres, and have not run.

**SQLite migration ledger (`packages/db/src/sqlite-migrate.ts`).**

5. The bundle digest hides a ledger edited out of band: a checksum changed, or a row deleted, while
   `fabrika_migration_bundles` still matches. On the full path, a bundle whose digest matches is skipped even when
   one of its ledger rows is missing (`:202`, `:208`).
   - Possible fix: triggers on the ledger that invalidate the bundle's digest.
   - Possible fix: derive pending migrations from the ledger for every bundle on the full path.

**Read-only invocations on SQLite (`packages/db/src/sqlite.ts`).**

Only framework SQL reaches the read path ([214](214-raw-sql-on-sqlite.md) refuses `ctx.sql` on SQLite), so these
gaps are defence in depth.

6. On workerd, a multi-statement string reports only the last statement's `rowsWritten`, so `INSERT …; SELECT 1`
   escapes the backstop (`:141-144`). Refuse more than one statement on the read path.
7. A writable PRAGMA (`PRAGMA ignore_check_constraints = ON`) on the read path is neither counted nor rolled back.
   Refuse state-changing PRAGMAs there.
8. The bun:sqlite double diverges from workerd's gates in two ways:
   - it lets an unrelated reader see another invocation's uncommitted write, because the read path skips the
     async transaction queue;
   - its `rowsWritten`, taken from `total_changes()`, misses schema writes.

**Generated entry (`packages/provider-cloudflare`).**

9. The pin compares paths as text, so a symlinked `workerDir` or Worker `dir` can make wrangler bundle a different
   `fabrika/entry.generated.ts` than the one the bound checked (`src/bounds.ts`). It is not a security boundary,
   because the author owns the Worker. Possible fix: realpath the config and the entry just before the gated
   wrangler spawn.
10. `pipeline.build` inherits the executor environment minus three names, including application and managed
    secrets, and a failed command's output reaches `commandError()` (`src/provider.ts`). The entry build already
    gets only `PATH`, `HOME` and `TMPDIR`. Decide which secrets an authored build may see.
11. The entry build looks for the CLI no higher than the executor's working directory. If a `workerDir` below a
    workspace root keeps the CLI at the root, the build fails. The runner would need to pass the checkout root.
12. **Decision:** a local deploy (no release named) is not pinned. Pinning it moves the runner smoke fixture
    (`packages/runner-container/docker/smoke/fabrika.config.ts`) to the generated entry.
13. **Decision:** queue consumers are not refused under the pinned entry, which exports no `queue()`. A gated
    application's consumer would deploy and never consume. Refuse it until the sprint's queue phase generates a
    consumer.
14. The test "the object's migration keeps tag v0001 when the application binds an object of its own" was deleted
    because both gates are 0.9. If D0 moves `PINNED_ENTRY_SINCE`, restore it with a release between the two gates.

**Prereleases (from the merge review of PR #56).**

15. `cloudflare-current-timestamp` scans every migration file, applied ones included (`packages/check/src/rules/migrations.ts`),
    and the ledger refuses an edited applied file. A 0.9.0-dev application with an applied `DEFAULT CURRENT_TIMESTAMP`
    migration fails the checker, and editing the file stops its object from booting. Refuse only files the ledger does
    not hold yet, or document the reset for prerelease applications.
16. The 0.9 gate of `assertGeneratedEntry` (`packages/provider-cloudflare/src/bounds.ts`) also catches the published
    `0.9.0-dev.*` prereleases: a dev application with a hand-written `main`, its own Durable Object, a workflow or a
    container is refused on its next deploy. State it in the release notes, or settle D0 before tagging.

**Hold metric and ops channel (waves 2–3).**

17. The `transaction_held` report has an end-to-end test only for a mutation; the public procedure and webhook paths
    have none.
18. An anonymous `POST /__fabrika/ops/*` still reaches the application Worker, which refuses it before any object
    lookup. An edge rate budget for the path would keep a flood off the Worker too.
19. The older-pin test of the provider checks the endpoints and the two object variables, not byte-identical generated
    configs (`packages/provider-cloudflare/src/__tests__/provider.test.ts`). Pin the full emitted configs for a 0.8.x
    and a release-absent run (ADR-0062).
20. `inspect`'s file and webhook delivery summaries scan every row, with grouping temp B-trees, on the object that
    serves all traffic (`packages/app/src/cloudflare/ops.ts`); table counts are capped, these are not. Counters kept by
    the framework's mutations, or bounded summaries stated on the S3 wire.
21. The S3 view cannot say "not booted yet": a cold object reports `bootFailure: null`, as a healthy one does. An
    additive `boot` state on `OpsView`.
22. `inspect` skips a table name by asking `parseOpsView` about a one-table view. Export the identifier check from
    `@fabrika/auth-core` and use it directly.
23. An ops key insert that throws with an unknown outcome after the row committed deletes the fresh vault row and
    leaves a dangling record, as the token key code does.
24. A deploy's write that throws abandons the lease, and so stops the data operation that handed it in. No test covers
    it.

**Merge review of the ops channel.**

25. Control sends the ops key to the domain the registry holds now, not the one the key was handed to with
    (`packages/control/src/data-operations.ts`, `httpOpsTransport`). Between a domain change and the next deploy, a
    holder of an app-scoped `app.manage` can point the host at a server they run and receive the key. Record the
    domain with the key, and call only that one.
26. The ops row forwards any `Authorization`, a person's `px_` platform key included
    (`packages/proxy-core/src/authorize.ts`); webhook rows exclude those. Refuse `px_` on the ops row.
27. `app_env_data_operations` references only `apps` (`0018_data_operations.sql`), so a running record of a deleted
    environment refuses deploys of a recreated one with the same name. Cascade on `app_envs`.
28. `data.view` on an environment with a domain but no issued key tries zero keys and answers 502 (`unreachable`),
    not 409 (`no_channel`).
29. Every `inspect` counts up to 100,000 rows per table synchronously, and a `data.read` holder can call it without a
    bound. Cache the view or rate-limit the call.
30. Deleting an environment leaves its ops keys' vault rows behind, as it does for token keys.
31. `servesOps` counts a prerelease as its minor, so a Cloudflare environment pinned to 0.9.0-dev.0 to 0.9.0-dev.4 gets the
    ops row, the key digests and a required vault, although those prereleases were published before the object served
    the ops channel. The ops row then reaches an application that answers no ops request. Gate on the first release
    that ships the ops handler, prerelease included. Not by SemVer order alone: `0.9.0-cloudflare.1` sorts
    below `0.9.0-dev.0`, and the cloudflare channel ships the handler (`contract-support.test.ts` pins it as served).

## Approach / acceptance

Each item lands with a witness that fails before it. Items 12 and 13 need a decision first. Item 14 follows D0 in
the sprint, and item 16 is settled with it.

## Touch points

`packages/check`, `packages/auth`, `packages/email`, `packages/db` (`sqlite-migrate.ts`, `sqlite.ts`,
`sqlite-bun.ts`), `packages/provider-cloudflare` (`bounds.ts`, `provider.ts`), `packages/runner-container`,
`packages/app` (`cloudflare/ops.ts`, `cloudflare/invocation.ts`), `packages/auth-core` (`ops.ts`), `packages/control`
(`ops-key.ts`, `data-operations.ts`).

<!-- Origin: ../sprints/sprint-2026-10-24-application-object.md, run log of waves 0–3. -->
