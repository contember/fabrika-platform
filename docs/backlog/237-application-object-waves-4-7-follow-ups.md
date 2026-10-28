---
id: 237
title: Application object follow-ups, waves 4–7
blocked-by: []
---

# 237 — Application object follow-ups, waves 4–7

**Summary.** The P2s, open decisions and missing pieces the reviews of the application object sprint's waves 4–7 left
(the data view, backups, the importer, restore, the alarm driver, kicks and the Bun timer). None blocks a release;
item 1 needs an oblaka release first.

## Problem

**Backups and dumps.**

1. **The deploy writes no R2 lifecycle rule** (ADR-0070 §5). oblaka 0.0.18's `R2Bucket` has no lifecycle option, so a
   dump outlives its 30 days in the bucket, and an upload that never completes is not aborted by a rule either.
   Control never offers a backup older than 30 days, so a restore cannot meet a file whose tombstone is past the
   window; only storage grows. A `begin` that loses its conditional create of the begun record leaves the multipart
   upload it opened, which only such a rule aborts. Add lifecycle rules to oblaka's bucket resource, release it, bump the pin in every
   package and `runner-container/docker/package.json`, and write the rule on both prefixes at the environment's deploy.
2. A consistent dump's `begun` record lives in the bucket, so a point-in-time restore of the source between two steps,
   which rewinds rows but not the ledger, still matches it. The deploy lease prevents that interleaving today. Fix
   idea: keep the record in the object's KV, which PITR rewinds.
3. Control's `state` transport reads any 422 as `invalid_answer`, so a transition the barrier refuses as `wrong_mode`
   (an import in progress) fails closed without saying why. Parse the data refusal there as `export` and `import` do.

**The data view and the CLI.**

4. The CLI parses `data.view` and `data.content` with auth-core's strict parsers, so an additive field from a newer
   Control makes an older CLI refuse the whole answer (`packages/cli/src/env.ts`). Fix idea: a lenient projection of
   the known fields for the CLI, keeping the app-side wire strict.
5. `packages/cli/src/connect.ts` keeps its own looser origin rule (`.+\.localhost`, only `127.0.0.1`); share
   `controlOrigin` from `control.ts`.
6. A caller with only data permissions reaches the console's data view by direct link only; no page they can load
   lists environments.

**The alarm driver and the repair tick.**

7. The deploy calls no `reconcile` ops operation after a gated deploy (design §3b, I5): the wire has none. A new
   environment with no traffic gets its first alarm from the hourly repair tick, up to an hour after the deploy. Fix:
   an additive `reconcile` operation and a post-deploy call when the release serves ops.
8. `needsMinuteTick` now decides any cron trigger, the minute tick or the hourly repair; rename it once backlog 216 and
   the sprint stop citing it.
9. A local deploy keeps the minute tick while it runs the object as the current release, which serves it as a repair
   tick every minute. Decide whether a local deploy gets the hourly repair tick.
10. `jobs/schedule.ts`'s header still describes the minute tick, and the next-fire helper the alarm driver needs lives
    in `runner.ts`; move it next to the schedule parser.

**Restore and the timers view.**

11. `arm` does not require a prepared sentinel; a blind re-arm after a restore makes `verify` say `absent` either way.
    Fix idea: an additive `not_prepared` data refusal.
12. The timers tracker is per isolate, not per object: with `application` and `rehearsal` in one isolate the view lists
    both.
13. Timer stacks are scrubbed of credential patterns only, not of the environment's secret values (the isolate tracker
    has no environment). Fix idea: hand the tracker `environmentScrubber(environment)` once captured and scrub at read
    time.

**Kicks and the Bun timer.**

14. A wake written by another process reaches a serving process's `WakeTimer` only at its 60 s job check: a claim
    re-arm or a kick for later written by a crontab run (`runContractJob` has no timer) or by a container that stopped
    runs up to 60 s after its due. Decide whether 60 s is the contract, or how a write elsewhere reaches the timer.

**Migrations before a deploy.**

15. A `migrate` operation that failed (`deploy_failed`, `migration_failed`) leaves the object restricted, and
    `data.recover` offers only `open` for a failed operation. No retry keeps the restriction: an operator who wants the
    migration run again before the object opens has nothing to call. Fix idea: a recovery resolution that resumes a
    failed `migrate` operation at its `deploy` or `migrate` step under a fresh fence.
16. Whether a deploy guards its migrations follows the last succeeded run's `migration_barrier`. A run whose provider deploy
    landed but which failed afterwards (a failed schema reconcile) leaves the record describing the version before it:
    a channel installed that way lets one migrating deploy run plainly, and a channel removed that way blocks migrating
    deploys until a run succeeds. Fix idea: record what the provider accepted, not only succeeded runs.
17. The ops `migrate` of an object that holds an import marker answers 500 (`ImportInProgress` thrown), not a data
    refusal. Unreachable today: an import keeps the object in `inspect`, which refuses `migrate` first. Fix idea: an
    explicit marker check in the barrier's `migrate` that answers `wrong_mode`.
18. A side restore never fails `objects_not_deployed` against the real transport. An object the deployed version does
    not list gets the uniform empty 404, and `httpOpsTransport.call` reads "every key refused" as `unreachable`, never
    `channel_refused`; only the test double answers `channel_refused`. With a runner that ignores the pointer, the
    restore stays running at `list` and blocks deploys until an operator recovers it. Fix idea: tell a refusal of every
    key apart from no answer in the transport, and fail `list` on it.
19. The same mapping on the rehearsal side: when the deployed version does not list `rehearsal`, a backup or a
    migration stays interrupted at `verify` on every pass, a migration with the object read-only. Fix with item 20.

**The console.**

18. The shared `Modal` (`components/Modal.tsx`) traps no focus, leaves the page behind it reachable, and does not
    return focus to the control that opened it. Every confirmation in the console inherits that, the side restore's
    included. Fix it once in `Modal` with a native `<dialog>` and `showModal()`.
19. A side restore's operation DTO does not carry the clone's and the original's object names, so the console and
    the CLI cannot show which object serves after `point` or which one keeps the rewound data. Add them additively to
    `DataOperationDto` from the restore record.

## Approach / acceptance

Each item lands with a witness that fails before it. Items 1, 9, 11 and 14 need a decision first; item 1 also an oblaka
release.

## Touch points

`oblaka` (bucket lifecycle), `packages/provider-cloudflare` (`provider.ts`, `bounds.ts`), `packages/app`
(`cloudflare/export.ts`, `cloudflare/restore.ts`, `cloudflare/tracker.ts`, `jobs/schedule.ts`, `jobs/runner.ts`,
`implement/dispatch.ts`, `implement/invocation.ts`, `bun.ts`),
`packages/auth-core` (`ops.ts`), `packages/control` (`data-operations.ts`), `packages/cli` (`env.ts`, `connect.ts`),
`packages/dashboard` (`components/Modal.tsx`), `packages/control-contract` (`rpc.ts`).

<!-- Origin: ../archive/sprint-2026-10-24-application-object.md, run log of waves 4–7. -->
