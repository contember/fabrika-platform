---
id: 307
title: A burst of privileged sign-ins can stall the security alerts' mark
blocked-by: []
---

# 307 — A burst of privileged sign-ins can stall the security alerts' mark

**Summary.** Operations' security alerts read privileged sign-ins from IAM in lists of at most 500. After a cut list
the mark moves to the last listed row, and the next pass reads from that mark minus 15 minutes. With 500 or more
privileged sign-ins inside those 15 minutes, every pass lists the same rows again. Low severity, about half an agent
day.

## Problem

- **The scenario.** About 33 privileged sign-ins a minute for 15 minutes, for example a script signing in with a stolen
  administrator credential.
  - The first 500 rows each raise an alert.
  - Later passes list the same 500 rows, and the deduplication by `auth_log` id keeps them silent. The mark stays at
    the 500th row, so every newer privileged sign-in goes unalerted.
  - After a day, the lookback cap (`MAX_LOOKBACK_MS`) passes the mark, and the rows older than a day are skipped for
    good. With more than 500 rows in one second, the mark never moves on its own.
- **Where:** `packages/operations/src/security-alerts.ts` (`since` from the mark, `advance` after a cut).
- **A smaller edge in the same place.** When the first channel enqueues and a later one throws, the claim is released.
  If the next pass falls in the next hour, the dedup key changes and the first channel gets the alert twice.
- Found by the second look at the fixes for review round 1 of the security alerts PR.

## Approach / acceptance

- After a cut, resume the privileged list at the last listed row without the 15-minute overlap. Either store a second
  mark for the privileged list, or let IAM's `signInSignals` take a `(created_at, id)` cursor for it.
- A test with more than 500 privileged rows within 15 minutes shows that every row is raised once and that the mark
  passes them.
- Optionally, release a claim only when no channel was enqueued.

## Touch points

- `packages/operations/src/security-alerts.ts`
- `packages/operations/src/repositories/security.ts` (the mark)
- `packages/iam/src/sign-in-signals.ts`, `packages/iam/src/repositories/audit.ts`, `packages/auth-core/src/rpc.ts`, if
  the cursor route is chosen
