---
id: 70
title: A failed Zerops build hangs `await-deploy` for seventy minutes
blocked-by: []
---

# 70 — A failed Zerops build hangs `await-deploy` for seventy minutes

**Summary.** A `stack.build` process that fails leaves its app version at `WAITING_TO_BUILD` forever,
and `await-deploy` watches only the app version — so the deploy sits for 70 minutes and then reports a
timeout that names neither the build nor the reason. Effort S.

## Problem

Observed live on 2026-08-11 (`fabrika-install-test`, throwaway service `wu1probe`). An import declaring
`buildFromGit` started a build whose process was `FAILED` **500 ms** after it started
(`started 12:33:41.202`, `finished 12:33:41.702`) — no build container was ever created, and the
process object carries no message explaining why. Its app version still read `WAITING_TO_BUILD` eight
minutes later, and there is no reason to think it would ever change.

`await-deploy` polls `getAppVersion` and nothing else:

- `packages/provider-zerops/src/provider.ts:211-219` — the step resolves `state.appVersionId` and polls
  the version's status.
- `packages/provider-zerops/src/provider.ts:28` — `POLL_TIMEOUT_MS = 70 * 60 * 1000`, chosen as "a
  little slack past" Zerops' own one-hour pipeline limit, which is the right bound for a build that is
  genuinely running.

So a build that fails **before** it produces a container is indistinguishable from one that is queued.
The run holds its per-app-environment lock for the whole 70 minutes, and the operator sees a timeout
rather than a failure.

There is a second, smaller half: `zops logs <service> --build` answers
`app version #N has no build container (it was deployed, not built)`, so even by hand there is nothing
to read. The signal that exists is the **process** status, which the driver never looks at.

## Approach / acceptance

Watch the process as well as the version. The trigger already returns a process
(`ZeropsProcess`, `api.ts:321-330`), and `ListServiceStackProcesses` /`GetProcessDetails` expose its
terminal state. A `FAILED` process for the version being awaited is a failed deploy, immediately —
whatever the version's own status says. Keep the version poll: it is what reports `ACTIVE`.

Witness: a deploy whose build cannot start fails in **seconds** with a message naming the failed
process, and a suite test drives the fake through the state pair (`process FAILED` +
`version WAITING_TO_BUILD`) that the live account produced.

## Touch points

`packages/provider-zerops/src/provider.ts`, `packages/provider-zerops/src/api.ts`.

<!-- Origin: sprint-2026-08-11-fabrika-deploys-an-app-on-zerops, WU1 run log (finding A). -->
