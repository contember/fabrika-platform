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
   window; only storage grows. Add lifecycle rules to oblaka's bucket resource, release it, bump the pin in every
   package and `runner-container/docker/package.json`, and write the rule on both prefixes at the environment's deploy.
2. A consistent dump's `begun` record lives in the bucket, so a point-in-time restore of the source between two steps,
   which rewinds rows but not the ledger, still matches it. An export of an object that holds an import marker is not
   refused either: an import loads rows at one generation without touching the ledger. The deploy lease prevents both
   interleavings today. Fix idea: keep the record in the object's KV, which PITR rewinds, and refuse a consistent
   export while an import marker exists.
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

14. A due-now kick wake is written at the request's clock (`new Date()` in `dispatch.ts`'s `#recordKicks`), while the
    finish consumes the wakes due at or before the run's `last_started_at` on the database's clock. A request clock
    ahead of the database's leaves the wake to the run the kick started, unconsumed, so the job runs once more with
    nothing to do. Fix idea: write a due-now wake at the database's now, as a job's kicks already do (`leases.now()`).
15. Kicks of one job in one second merge into one wake (`kick:<job>:<s>`) that keeps the earlier due. A run that
    started between the two kicks consumes the merged wake, so the later kick rests on the pending flag alone, and a
    crash between its commit and `markPending` leaves it to the schedule. Fix idea: let a later kick in the same second
    move the merged wake's due to its own time.
16. A wake written by another process reaches a serving process's `WakeTimer` only at its 60 s job check: a claim
    re-arm or a kick for later written by a crontab run (`runContractJob` has no timer) or by a container that stopped
    runs up to 60 s after its due. Decide whether 60 s is the contract, or how a write elsewhere reaches the timer.

## Approach / acceptance

Each item lands with a witness that fails before it. Items 1, 9, 11 and 16 need a decision first; item 1 also an oblaka
release.

## Touch points

`oblaka` (bucket lifecycle), `packages/provider-cloudflare` (`provider.ts`, `bounds.ts`), `packages/app`
(`cloudflare/export.ts`, `cloudflare/restore.ts`, `cloudflare/tracker.ts`, `jobs/schedule.ts`, `jobs/runner.ts`,
`implement/dispatch.ts`, `implement/invocation.ts`, `bun.ts`),
`packages/auth-core` (`ops.ts`), `packages/control` (`data-operations.ts`), `packages/cli` (`env.ts`, `connect.ts`),
`packages/dashboard`.

<!-- Origin: ../sprints/sprint-2026-10-24-application-object.md, run log of waves 4–7. -->
