<!--
On close, prepend an OUTCOME block here, then `git mv` this file to ../archive/:

> **OUTCOME — shipped YYYY-MM-DD.** <one-paragraph result.> Commit map: WU1 → <sha>,
> WU2 → <sha>, … Verification: <the gate command + numbers>. Backlog closed:
> <ids deleted/rescoped>. Deferred: <honest notes>.
-->

# Sprint — the application Durable Object (2026-10-24)

**Goal.** Make the Cloudflare application object a runtime that varied internal applications can rely on, and give
Control a way to inspect, back up and recover its data.

**Theme.** The design and its rationale are in
[`../ideas/application-object-runtime-and-operations.md`](../ideas/application-object-runtime-and-operations.md); every
§ below refers to it. The batch succeeds when an environment sleeps unless it has work, a query no longer blocks the
environment, Control can take and restore a consistent backup, and a side restore recovers data from time T without
rewinding the serving database.

## Refs re-verified at HEAD (2026-10-24)

The proposal's §6 turned into units for a lead agent that runs implementation subagents, one git worktree each. Territories were
checked against the code at `62fcfd2ba`. Units in one wave have disjoint write territories. A seam lands in its own
unit before the units that build on it. Paths below `app/`, `db/`, `control/` mean `packages/<name>/src/`.

## Decisions

Settled by the owner on 2026-10-24:

- **D0**: this work ships in framework 0.9.0, so the gate constants equal `runsInObject`. The SQLite `fabrika` bundle
  keeps `0001_framework.sql` unchanged: every new framework table goes in a new migration file (ADR-0017).
- **Q1**: an environment without a domain gets no ops channel, and so no backups.
- **Q2**: `data.content.read` belongs to the installation's operators only. App owners get `data.read` (metadata:
  sizes, counts, state, the backup list), never row contents.
- **Q3**: the barrier fails closed. A cold start that cannot read its maintenance state from R2 answers 503.
- **Q4**: daily consistent backups are the default for every Cloudflare environment, kept 30 days, and the file
  tombstone window is 30 days too. An environment can opt out.
- **Q5**: 14-minute segments with chunking through claims stay the rule (5.6). A contract-declared Workflow,
  generated into the entry, is planned as the escape hatch:
  [backlog 235](../backlog/235-a-long-job-on-cloudflare-has-no-workflow-escape-hatch.md).
- **Q6**: option E stays out.
- **3.0** is accepted through its PR. Waves 2–4 build on the draft in the same sprint branch.

## Seams and shared files

| Seam                                                                                                                                                                                                                                                                                                                        | Unit | Built on by        |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ------------------ |
| Release gates in `provider-cloudflare/src/contract-support.ts`: one `releaseAtLeast(release, since)`, `runsInObject` rewritten onto it, and the four gate constants (`pinsGeneratedEntry`, `servesOps`, `servesAlarms`, `capsJobSegments`) declared once, so later units only import them.                                  | S1   | 1.6, 3.x, 5.4, 5.6 |
| Per-object storage scope (§3a, gap 7): the storage adapter that `app/cloudflare/application.ts` hands `openSqlite` and `migrateSqlite`, resolved from an `AsyncLocalStorage` scope per object; `transactionSync` added to `SqliteStorage` (`db/sqlite.ts`) and to `bunSqliteStorage` (`db/sqlite-bun.ts`).                  | S2   | 1.3, 2.1, 3.3, 5.2 |
| Ops wire: new `packages/auth-core/src/ops.ts` (prefix, request and answer shapes, the export manifest) and `FABRIKA_OPS_KEY_DIGESTS`, `FABRIKA_APPLICATION_OBJECT`, `FABRIKA_APPLICATION_OBJECTS` in `framework-variables.ts`.                                                                                              | S3   | 3.x, 4.x, 6.x      |
| Control's operation record: `app_env_data_operations` in `packages/control/migrations/` and `migrations-postgres/` (both, per `control/DATABASE.md`), its repository in `control/db/`, `data.read`, `data.content.read`, `data.manage` in `control-contract/src/access.ts` (beside `mail.*`), and the RPC DTOs in `rpc.ts`. | S4   | 3.4, 4.4, 6.2      |

**Why `auth-core` holds the ops wire.** `@fabrika/control-contract` depends on `@fabrika/app`, so the app importing it
would be a cycle, and it serves the console. `@fabrika/operations-contract` is the Operations plane.
`@fabrika/auth-core` already owns the app↔platform wire (`wire.ts`, `framework-variables.ts`), is published, and is
imported by `@fabrika/app`, `@fabrika/control` and `@fabrika/proxy-core`. It has no dependencies, so the shapes are
parsed with its `json.ts` readers, not zod.

**Shared files that are not units.** Each unit edits the skill file of the rule it changes
(`packages/app/skill/`); the lead regenerates `examples/zerops-app/AGENTS.md` at integration. The ops router
(`app/cloudflare/ops.ts`) and Control's composition (`control/services.ts`) take one line per unit; the lead merges
those lines. ADR-0065 is edited by 2.1, 4.x and 5.x, each in a different wave.

**Release placement (decision D0, settled above).** The object runtime ships as framework 0.9, and Control reads 0.8
applications with the 0.8.2 reader. 0.9 shipped first on the `cloudflare` channel, as 0.9.0-cloudflare.1 and .2, cut
from `channel/cloudflare` ([release channels](../reference/release-process.md#release-channels)); how those
prereleases sort against the release floors is [backlog 240](../backlog/240-channel-prereleases-sort-below-the-release-floors.md).
The 0.9.0-dev.0 to 0.9.0-dev.4 prereleases on `next` were cut before the object runtime and lack it, although the
minor gates (`runsInObject`, `pinsGeneratedEntry`, `servesOps`) admit them
([backlog 228](../backlog/228-application-object-review-follow-ups.md)). A unit that ships in 0.9.0 needs no gate of
its own: `runsInObject` covers it, and S1's constants equal it. A unit after 0.9.0 gets the next minor. The SQLite
`fabrika` bundle keeps `0001_framework.sql` unchanged; every new framework table is a new file (ADR-0017).

## Work units

**Phase 0 – probes.**

| WU                   | Territory                                    | Depends on | Witness                                     |
| -------------------- | -------------------------------------------- | ---------- | ------------------------------------------- |
| 0.1 Probe Worker (M) | a scratch directory, nothing committed       | —          | one script per §6 Phase 0 row               |
| 0.2 Run (human)      | a throwaway account                          | 0.1        | the raw results                             |
| 0.3 Record (S)       | `docs/reference/cloudflare-platform.md` only | 0.2        | each row with its source and date, as today |

Probe 11 (backlog 213) needs a full installation, not a probe Worker.

**Phase 1 – sleep hygiene and correctness.**

| WU                     | Territory                                                                                                                                                                              | Depends on | Verify first                                                                                                                                                              | Witness (backend)                                                                                                                                                                                                                        |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1 Gates (S)           | `contract-support.ts`                                                                                                                                                                  | D0         | callers: `provider-cloudflare/src/control.ts:300`, `provider.ts:595`                                                                                                      | the gate rows of `provider.test.ts` and `control.test.ts` unchanged; a table test of `releaseAtLeast` (none)                                                                                                                             |
| S2 Storage scope (S)   | `app/cloudflare/application.ts` (`Booted`, `attach`, `bootApplication`), `db/sqlite.ts` (the port only), `db/sqlite-bun.ts`                                                            | —          | the shared `storage.current` swap, `application.ts:137-141,183-187`; `bunSqliteStorage` already has `transactionSync` (`sqlite-bun.ts:103`), so the port only promotes it | `cloudflare-runtime-adapter.test.ts`: two objects of one isolate, interleaved, each reads only its own rows (bun:sqlite); `cloudflare-runtime.test.ts` green (Lopata)                                                                    |
| 1.1 Deadlines (S)      | `app/implement/bounded.ts`, `dispatch.ts` (body reads at `:1075,1486,1558`), `anonymous.ts` (deadline helpers), `workload.ts:48`, `app/jobs/report.ts:146`                             | —          | `grep -rn 'AbortSignal.timeout' packages/app/src` lists these plus `files/clamscan.ts:233` (Bun-only, not reachable on Cloudflare) and test fixtures                      | `request-signal.test.ts`: every timer a request sets is cleared when it settles; `cloudflare-bundle.test.ts` refuses `AbortSignal.timeout` in the bundle (none)                                                                          |
| 1.3 Boot hygiene (S)   | `application.ts` (`dueJobsOf` gone, failed-boot retry), `app/implement/boot.ts` (one job list), `needsMinuteTick` in `contract-support.ts`                                             | S1, S2     | 216/4, /10, /16 still open                                                                                                                                                | adapter test: a failed `load()` boots again after backoff; `provider.test.ts`: legacy collections alone write no tick (none)                                                                                                             |
| 1.4 Ledger digests (S) | `db/sqlite-migrate.ts`                                                                                                                                                                 | D0         | `fabrika_migrations` keeps no bundle digest                                                                                                                               | `db/__tests__/sqlite-migrate.test.ts`: an attached instance reads one row; an edited file is still refused (none)                                                                                                                        |
| 1.5 Skill, checker (S) | `packages/app/skill/SKILL.md` (Cloudflare section, `:298-301`), `references/endpoint.md`; `packages/check/src/rules/cloudflare.ts`, `rules/migrations.ts`                              | —          | the skill names the 25 s cap, not the serialization (216/7)                                                                                                               | `skill-code.test.ts`, `agent-skill.test.ts`; checker tests: a hint on a mutation that declares `egress` or `connect`, a refusal of `DEFAULT CURRENT_TIMESTAMP` (none)                                                                    |
| 1.6 Pin `main` (M)     | `provider-cloudflare/src/bounds.ts` (`main` at `:80`, the refused keys at `:96-98`), `provider.ts` (`case 'build'`, `:375`, then `fabrika app build --provider=cloudflare`), `plan.ts` | S1, D0     | the plan omits `build` without `pipeline.build` (`plan.ts:74`) and the executor returns early (`provider.ts:377`); both change                                            | `provider.test.ts`: a gated release with a hand-written `main` is refused; the build step runs the application's `fabrika app build` after an authored pipeline and without one, in that order; an older release deploys as today (none) |

Rollout: only 1.6 touches protocol (the build step). Its commit says that an environment changes on its next deploy at
a gated release, and that an older pin deploys unchanged. The commits close 216/4, /7, /10, /13 and /16.

**Phase 2 – read-only invocations.**

| WU                  | Territory                                                                                                                                                        | Depends on                         | Verify first                                                                                                                          | Witness (backend)                                                                                                                                                                                                                                           |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2.1 Read-only (S)   | `db/database.ts` (`InvocationTransaction.enclose` skips a read-only SQLite invocation), `db/sqlite.ts` (per-statement `transactionSync`, `rowsWritten` backstop) | S2; probe 8 confirms `rowsWritten` | `dispatch.ts:528,986` already passes `readOnly` to `Invocation`, so no `dispatch.ts` change; `openSqlite` ignores `readOnly` (216/12) | new `db/__tests__/sqlite-read-only.test.ts`: two reads across an await see a write committed between them; a framework write in a read-only session throws and leaves nothing (bun:sqlite); a slow query does not delay another request's mutation (Lopata) |
| 2.2 Hold metric (S) | `db/database.ts` (`heldMs`), `app/implement/failures.ts` (`transaction_held`)                                                                                    | 2.1                                | —                                                                                                                                     | `sqlite-engine.test.ts` with an injected clock; `request-failures.test.ts` for the event's fields (none)                                                                                                                                                    |

ADRs: 2.1 amends ADR-0012 (`0012:274`) and ADR-0065 §2, and the skill line that says queries are enclosed. No protocol.

**Phase 3 – ops channel, inspection, maintenance.**

| WU                    | Territory                                                                                                                                                                                                                                                       | Depends on         | Verify first                                                                                                                                                                                                                                 | Witness (backend)                                                                                                                                                                                                                                                                                                |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 3.0 ADR (S)           | new ADR "Control reaches an application environment's object"; the ADR-0022 amendment                                                                                                                                                                           | Q1–Q3              | —                                                                                                                                                                                                                                            | the owner accepts it; it carries the barrier's fault matrix (Deferred findings)                                                                                                                                                                                                                                  |
| S3 Ops wire (S)       | `packages/auth-core/src/ops.ts`, `framework-variables.ts`, `index.ts`                                                                                                                                                                                           | 3.0                | authored paths under `/__fabrika` are already refused (`app/contract/build.ts`)                                                                                                                                                              | `auth-core/src/__tests__/ops.test.ts`: unknown keys refused; `framework-variables.test.ts`: the names are platform-only (none)                                                                                                                                                                                   |
| S4 Control record (M) | see Seams                                                                                                                                                                                                                                                       | 3.0; Q2 for grants | the `mail.*` triple; `0005_approved_access.sql` for a table rebuild                                                                                                                                                                          | `postgres-schema.test.ts` (Postgres); the repository on SQLite (none)                                                                                                                                                                                                                                            |
| 3.1 Ops key (M)       | new `control/ops-key.ts` (after `proxy-secret.ts`), `provider-contract/src/control.ts` (a capability like `applicationHopSecret`), `provider-cloudflare/src/control.ts`                                                                                         | S1, S3             | `proxySecretPurpose` as the vault-purpose pattern                                                                                                                                                                                            | `control/__tests__/ops-key.test.ts`: a rotation keeps both digests until the next deploy; `control.test.ts`: the variable only at a gated release, removed by `deleteStaleSecrets` after a downgrade                                                                                                             |
| 3.2 Provider side (M) | `proxy-core/src/manifest.ts` (the composed row form), `provider-cloudflare/src/provider.ts` (`platformProxied` adds the row, `withApplicationRuntime` writes the object variables), `bounds.ts`                                                                 | S1, S3, Q1         | `contractProxyTable` (`manifest.ts:385`) is the only producer; Control's `zerops/older-proxies.ts` never judges a Cloudflare row                                                                                                             | `proxy-core/__tests__/manifest.test.ts`: the row parses only in its composed form; `proxy-worker.test.ts`: `/__fabrika/ops/*` reaches `APP` without a token, other paths unchanged (none)                                                                                                                        |
| 3.3a Ops handler (M)  | `app/cloudflare.ts` (object selection, ops routing), new `app/cloudflare/ops.ts`, `application.ts` (pre-boot branch, key check, the §4.2 view)                                                                                                                  | S2, S3             | `createContractWorker` resolves the stub by `APPLICATION_OBJECT_NAME` (`cloudflare.ts:87`)                                                                                                                                                   | new `cloudflare-ops.test.ts`: a wrong key is 404, a broken boot is still inspectable, an unlisted object is refused (bun:sqlite); routing (Lopata)                                                                                                                                                               |
| 3.3b Barrier (L)      | new `app/cloudflare/maintenance.ts`, the storage adapter in `application.ts` (write fence), `dispatch.ts` (in-flight counts), `app/jobs/runner.ts` (stop controller for every run, `:364`)                                                                      | 3.3a, 1.1, Q3      | every framework write on SQLite reaches storage through the adapter `application.ts` builds. If so, the fence is one check inside its `transaction`/`transactionSync` and before an autocommit `sql.exec`, and no `@fabrika/db` file changes | new `cloudflare-maintenance.test.ts`: a write admitted before `read-only` rolls back on a stale generation; the drain waits for a mutation and a kicked run; opening writes R2 first (bun:sqlite); R2 conditional puts (Lopata)                                                                                  |
| 3.4a Control ops (M)  | new `control/data-operations.ts`, `control-rpc.ts`, `run-lifecycle.ts` (refuse a deploy while not `open`; **seam:** a deploy entry point that runs under a lease the maintenance operation already holds), `platform/src/deploy-locks-sql.ts` (lease ownership) | S4, 3.0            | the deploy lock is `SqlDeployLocks` (`services.ts:38`) and is not re-entrant (`deploy-locks-sql.ts:11`); `RunInvocation.acquire` takes it again (`run-lifecycle.ts:421`) and `executeDeploy` defers on failure (`:496`)                      | against a fake ops endpoint: resume from the recorded step, idempotent by generation, a deploy refused under `read-only`; with the real SQL lock: the owning operation deploys under its lease, an unrelated deploy stays excluded, a lost lease aborts the operation (Postgres via `FABRIKA_TEST_POSTGRES_URL`) |
| 3.4b Console (M)      | a data view under `packages/dashboard/src/routes/apps/`                                                                                                                                                                                                         | S4                 | `routes/apps/detail.tsx`                                                                                                                                                                                                                     | a new `packages/dashboard/src/__tests__/data-view.test.tsx`, run with `bun run --cwd packages/dashboard test`                                                                                                                                                                                                    |
| 3.4c CLI (S)          | new `packages/cli/src/env.ts` (`env inspect`, `env maintenance`), routing in `cli/src/index.ts`                                                                                                                                                                 | S4                 | the `control` area as the transport precedent                                                                                                                                                                                                | CLI tests against a fake Control (none)                                                                                                                                                                                                                                                                          |
| 3.5 Tracker (S)       | new `app/cloudflare/tracker.ts`, one route in `ops.ts`                                                                                                                                                                                                          | 3.3a               | —                                                                                                                                                                                                                                            | adapter test: a leaked timer is listed with its stack, and nothing after eviction (bun:sqlite)                                                                                                                                                                                                                   |

Rollout: the three variables, the handler and the row arrive with an environment's next deploy at a gated release.
`platform upgrade` alone changes no app. Witnesses: `provider.test.ts`, a redeploy of an older pin writes neither row
nor variables; `control.test.ts`, an upgrade without an app deploy.

**Phase 4 – backups and importer.**

| WU                      | Territory                                                                                                                                                              | Depends on                                  | Verify first                                                                     | Witness (backend)                                                                                                                                                  |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 4.1 Export (M)          | new `app/cloudflare/export.ts`, one route in `ops.ts`                                                                                                                  | 3.3a, S3; probes 8, 9                       | the `(typeof, text)` projection against workerd's int64-to-double (§4.4)         | new `app/src/__tests__/cloudflare-export.test.ts`: per-table counts and sha256 match, a 2 MB row and a 64-bit integer survive (Lopata)                             |
| 4.2 Importer (M)        | new `app/cloudflare/import.ts`, one route in `ops.ts`                                                                                                                  | 4.1, S3; probe 8 (`defer_foreign_keys`)     | —                                                                                | new `app/src/__tests__/cloudflare-import.test.ts`: export, import, compare; a fuzzy dump and a ledger mismatch refused (Lopata)                                    |
| 4.3 File retention (S)  | `db/stored-files.ts` (the sweep takes only keys past the window; a restore cancels keys), `app/files/kinds.ts` and `app/contract/build.ts` (reserved `__fabrika` kind) | Q4                                          | the deletion queue exists (`stored-files.ts:135-204`); the window is zero on Bun | `stored-files-sqlite.test.ts` (bun:sqlite) and `stored-files.test.ts` (Postgres): a key inside the window survives, a cancelled key stays                          |
| 4.4 Control backups (M) | `control/data-operations.ts`, `control/cron.ts`                                                                                                                        | 3.4a (the lease-owned deploy), 4.1, 4.2, Q4 | the `*/5` cron, `packages/control/fabrika.config.ts:67`                          | against a fake ops endpoint: one backup a day; the pre-migration deploy runs read-only, backup, verify, deploy; a failed verify reopens and does not deploy (none) |

ADRs: retire ADR-0065's "no bulk export" (`0065:84`); new ADR "Data protection of an application environment on
Cloudflare". Rollout as §6 Phase 4.

**Phase 5 – scheduler with durable retries.**

| WU                        | Territory                                                                                                                                                                                                                                                                           | Depends on                     | Verify first                                                                                                     | Witness (backend)                                                                                                                                                                                            |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 5.1 Wakes store (M)       | new `db/job-wakes.ts`, `db/migrations-sqlite.ts`, `db/migrations.ts`, `db/job-leases.ts` (projection hook on each lease statement), the framework-store wiring (`db/registry.ts:20`, `store.ts:2078`, `framework.ts:31`)                                                            | D0                             | `SQL_REAP` and `tryAcquire`, `job-leases.ts:118-177`                                                             | new `job-wakes-sqlite.test.ts` (bun:sqlite) and `job-wakes.test.ts` (Postgres): dedupe keys, T1 < T2, nothing consumed before a fenced finish                                                                |
| 5.2 Cloudflare driver (L) | `application.ts` (`alarm()`, repair), `app/cloudflare.ts` (`scheduled` becomes the repair tick), `app/jobs/runner.ts` (durable retry on Cloudflare; one deadline over the whole segment: IAM setup, the attempt and its finish)                                                     | 5.1, 3.3b; probes 3, 4, 5      | IAM authority is awaited before the handler timer (`runner.ts:679,706`) and the lease finishes after it (`:562`) | the §3b fault-injection list, a zero-traffic install, exhausted alarm retries (Lopata); a segment deadline that cancels setup and gives the handler only the remaining budget, with an injected clock (none) |
| 5.3 Delayed kick (M)      | `app/contract/context.ts`, `dispatch.ts` (`#kickAll`), `app/implement/invocation.ts` (the kick recorder, `:470`, today one argument into a `Set`), `runner.ts`, `db/orm.ts` (the claim returns its next eligible due, `:748-809`), `db/nodes.ts` (`:356`), `app/bun.ts` (the timer) | 5.2                            | —                                                                                                                | `mutation-kick.test.ts`, `public-kick.test.ts` (Postgres): a rolled-back mutation leaves no durable kick; a scoped claim re-arms from its own eligibility and does not loop (Lopata); `job-types.test.ts`    |
| 5.4 Trigger (S)           | `provider-cloudflare/src/provider.ts` (`applicationRuntime`, `MINUTE_TICK` at `:136`), `bounds.ts`                                                                                                                                                                                  | S1; 3.2 for the reconcile call | —                                                                                                                | `provider.test.ts`: tick release to alarm release, the hourly cron at the environment's minute, zero traffic (none)                                                                                          |
| 5.5 Kit clock (S)         | `app/testing/kit.ts`                                                                                                                                                                                                                                                                | 5.2                            | —                                                                                                                | `test-kit.test.ts`: `kit.clock.advance` fires a due wake (none)                                                                                                                                              |
| 5.6 Segment cap (S)       | `assertCloudflareContract` in `contract-support.ts`, `check/rules/cloudflare.ts`                                                                                                                                                                                                    | S1, Q5                         | §6 gives §3f's cap no phase; this unit adds it                                                                   | `provider.test.ts`, `control.test.ts`: `timeoutMs` over 14 min refused only at a gated release (none)                                                                                                        |

ADRs: rewrite ADR-0065 §5; amend ADR-0060. Rollout as §6 Phase 5.

**Phase 6 – side restore.**

| WU                   | Territory                                                                                | Depends on                               | Witness (backend)                                                                                |
| -------------------- | ---------------------------------------------------------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------ |
| 6.1 PITR path (M)    | new `app/cloudflare/restore.ts`, one route in `ops.ts`                                   | 3.3a; probe 7 happy path                 | live account only: Lopata does not restore                                                       |
| 6.2 Flow (M)         | `control/data-operations.ts`; the pointer deploy in `provider-cloudflare/src/control.ts` | 4.4, 6.1; the lease-owned deploy of 3.4a | each §4.5 failure row resumes, against a fake ops endpoint (none); one restore on a live account |
| 6.3 Console, CLI (S) | the data view; new `packages/cli/src/data.ts`                                            | 6.2                                      | dashboard and CLI tests                                                                          |

## Sequencing and agents

| Wave | Units                              | Starts when                       |
| ---- | ---------------------------------- | --------------------------------- |
| 0    | S1, S2, 1.1, 1.5, 0.1, 3.0 (draft) | now                               |
| 1    | 1.3, 1.4, 1.6, 2.1, 5.1            | wave 0 merged; D0                 |
| 2    | 2.2, S3, S4                        | 3.0 accepted                      |
| 3    | 3.1, 3.2, 3.3a, 3.4a               | S3, S4; Q1, Q2                    |
| 4    | 3.3b, 3.4b, 3.4c, 3.5, 4.1, 4.3    | 3.3a; Q3, Q4; probes 8, 9 for 4.1 |
| 5    | 4.2, 5.2, 5.4, 5.6                 | 4.1; probes 3, 4, 5, 10; Q5       |
| 6    | 4.4, 5.3, 5.5, 6.1                 | 4.2, 5.2; probe 7                 |
| 7    | 6.2, then 6.3                      | 6.1                               |

**Can start now, without probes or decisions:** S2, 1.1, 1.5, 0.1 (writing the probes, not running them), and the
3.0 draft. S1 can start too; only its constants' values wait for D0.

**Roles.**

- **Lead.** Writes each unit's brief from its row: territory, verify-first, witness, ADR text. Keeps one integration
  branch for the sprint. A wave starts from a recorded integration commit that holds every unit it depends on: each
  unit gets a worktree from that commit (`git worktree add <path> -b wu/<id> <integration-sha>`, then `bun install`),
  never from `origin/main`. Merges in wave order, merges the one-line seams, regenerates
  `examples/zerops-app/AGENTS.md`, and commits each unit atomically with its rollout note. The gates that count run on
  the integration branch after each merge.
  Runs `cpu-lease run -n 4 -- bun run check:ci` before a push to `main`.
- **Implementer.** An Opus subagent in its own worktree. It runs the verify-first check, writes the witness before
  the code, and stays inside its territory. A needed write outside it stops the unit and goes back to the lead.
- **Reviewer.** A GPT agent (`gpt-6.1-sol`). It gets the brief, the diff and the ADR, never the implementer's
  summary. One round: a P1 blocks; anything else becomes a backlog item.

**The human.**

- Phase 0 needs a throwaway Cloudflare account and its token. The probes deploy Workers with wrangler, so the human
  runs them or explicitly allows that deploy. The same holds for backlog 213's rows and the live witnesses of 6.1 and
  6.2.
- Decisions: D0 (release placement) before waves 1 and 5; Q1 before 3.2; Q2 before S4's grants and 3.4a; Q3 before
  3.3b; Q4 before 4.3 and 4.4; Q5 before 5.6. Q6 blocks nothing: option E stays out.
- Accepting the Phase 3 ADR (3.0) opens waves 2 to 4.

## Out of scope (explicit)

- Everything in §6 "Later, on demand".
- §3d.5's 25 s cap on job transactions: after 5.2, once probe 5 answers.
- §3e's typed binding parsers. `app/cloudflare/bindings.ts` already exists for the framework's own bindings, so the
  author module needs another name.
- The cost view from Cloudflare's GraphQL analytics (§4.2, probe 2).
- The signals `alarm_lag`, `queue_stuck`, `boot_slow` and `backup_failed`. Only `transaction_held` (2.2) is planned.
- The remaining checker hints of §5: a claim-only `* * * * *` job, an unbounded `UPDATE` or `DELETE` in a migration.
- The Lopata fixes of 216/14, which belong to Lopata's own repository.

## Run log

<!-- Append as you work: discoveries, deviations, blockers. Graduate each entry:
     changed the *why* → ../decisions/NNNN ; new future work → ../backlog/NN ;
     transient → leave it (dies with the sprint on archive). After graduating,
     trim to a one-line pointer ("→ ADR-0022"). -->

- 2026-10-24: D0 settled (see Decisions): 0.9.0, new migration files only.
- 2026-10-24: 5.1 (the wakes store) moved from wave 1 to wave 5, next to its driver, so that no framework table ships unused.
- 2026-10-24: Waves 0–1 shipped: S1, S2, 1.1, 1.3, 1.4, 1.5, 1.6 and 2.1. Review P2s and two open decisions (pinning a local deploy, refusing queue consumers) → [backlog 228](../backlog/228-application-object-review-follow-ups.md).
- 2026-10-24: 0.1 is done. The probe project lives outside the repo, nothing was deployed, and the human runs it (0.2). A dry run on local workerd, to be confirmed live:
  - **Probe 5:** a timer set inside a `storage.transaction` callback does not fire while the callback awaits R2 I/O, so a timer cannot cap a transaction at 25 s.
  - **Probe 8:** `transactionSync` is a savepoint inside the request's implicit transaction, so a deferred foreign-key violation fails only when the request ends, and it resets the object. A bigint binding throws, and `cast(real as text)` loses precision, which 4.1's projection has to avoid.
  - **Probe 9:** R2 refuses multipart parts of unequal size (10048), so 4.1's gzip parts need a fixed part size or one object per part.
- 2026-10-24: Waves 2–3 shipped: 2.2, ADR-0069 (accepted through the PR), S3, S4, 3.1, 3.2, 3.3a and 3.4a. Review P2s → [backlog 228](../backlog/228-application-object-review-follow-ups.md) items 17–24.
- 2026-10-24: 3.3a: an ops request never boots the object, so boot now starts lazily on the first ordinary request or tick, not in the constructor. The application Worker authenticates the ops key before it selects an object, so an anonymous request wakes none.
- 2026-10-24: 3.1: Control presents up to two candidate ops keys, newest first, instead of tracking which digest the running version activated; the transport tries the next one only after the uniform refusal. The digests are a public variable.
- 2026-10-24: 4.4 must settle a Cloudflare deploy started under a data operation's lease under that same lease (`RunInvocation.underLease` + `settleUnfinishedRun`); otherwise the cron waits until the operation ends.
- 2026-10-24: Merge review of #59: one started maintenance operation made the environment undeployable, because the object answers `state` with 501 until 3.3b and the record stays `running`. `data.start` and `data.recover` now answer 501. 3.3b lifts that only for an environment whose release serves `state`, and an object's "not implemented" must fail the record, not leave it running.
- 2026-10-25: Waves 3–6 integrated on `feat/application-object-3` with local tests only: 3.3b, 3.4b, 3.4c, 3.5, 4.1–4.4, 5.1–5.6, 6.1–6.3. Live probes (0.2) and a deploy to a real account are the next part. Review P2s and open decisions → [backlog 237](../backlog/237-application-object-waves-4-7-follow-ups.md); the in-handler upload gap → [backlog 236](../backlog/236-an-in-handler-upload-leaves-bytes-after-an-eviction.md).
- 2026-10-25: Integration found that a backup spanning two maintenance passes restarted forever: each pass published `read-only` at a new generation, which changed the dump's digest. A consistent dump now spans one stretch of modes that write nothing (ADR-0070 §2), and Control continues the recorded dump id, starting a new one only on `ledger_mismatch`.
- 2026-10-25: 4.4b first guarded a deploy's migrations by the published ops snapshot; they now follow what the last succeeded deploy installed (`runs.migration_barrier`), so a domain added later does not block deploys. Its gap → backlog 237 item 16.
- 2026-10-25: The merge review found that the 0.9.0 prereleases on npm (`dev.0`–`dev.4`, `cloudflare.1`–`cloudflare.2`) passed every 0.9 gate although their object has no alarm and answers `state` and `migrate` 501. The alarm, the segment cap and the data operations now hold from `0.9.0-dev.5` in semver precedence (`releaseFrom`); the channel stays at the minor. Transport P2s → backlog 237 items 20–21.
