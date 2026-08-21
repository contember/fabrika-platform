---
id: 84
title: A catalog projection can wait out a lease left behind by a dead flush holder
blocked-by: []
---

# 84 — A catalog projection can wait out a lease left behind by a dead flush holder

**Summary.** The silence around this is closed (sprint "a bring-up without surprises", WU2): every
catalog sync now logs its outcome and revision, most changes that coalesce against the flush holder's
own release are now delivered by that holder rather than by the maintenance replay, and a deploy
that finds no active ingest configuration writes one run-log line naming the catalog state it saw.
What remains is the one window the reproduction could not close: a projection lease left behind by a
container that died mid-flush refuses every change AND every maintenance replay until it expires.
Effort S.

## Problem

`runCatalogSync` takes a `deploy_locks` lease with a five-minute TTL. A holder that dies never
releases it, so for up to five minutes every registry change returns `coalesced` and every scheduled
replay returns `coalesced` too — the replay is refused by the same lease it is meant to repair. The
first replay after expiry is up to one cron period later, so an application registered inside that
window can wait about ten minutes for the ingest configuration its first deploy reads. Reproduced in
`packages/control/src/__tests__/operations-catalog-window.test.ts` ("a lock left behind by a dead
holder drops every change until the lease expires").

Three smaller findings from the same reproduction, none changed yet:

- The handoff passes narrow the coalescing window rather than close it: after the last pass there is
  no final `getState`, so a change that lands in that pass's own release window still waits for the
  maintenance replay, on the cadence above.
- The deploy's run-log line lives on `runs/<id>/logs.ndjson`, which a relay-backed provider re-flushes
  in full from its own buffer (`packages/runner-cloudflare/src/relay.ts`). Control writes the line
  before the provider starts, so it can never truncate a relay log — but on those providers the line
  survives only in the control-plane log, not in the run log an operator opens in the console.
- `OperationsCatalogRepository.markApplied` updates each ingest row by
  `(app_id, env, service_key, credential_id)` and advances `applied_revision` regardless of how many
  rows the update matched. A configuration whose credential changed between the snapshot and the
  response is skipped with no error and no log line.
- A reconcile accepted by Operations whose local `markApplied` never runs (the process ends between
  the response and the write) leaves Operations listing a source that control has no active
  configuration for. Nothing can log this — the next successful sync repairs it, on the cadence above.

## Approach / acceptance

1. Decide how a projection lease should self-heal faster than its TTL: a shorter lease with a
   heartbeat, a lease the maintenance replay may break when it is older than one cron period, or
   accepting the window now that both ends of it are visible in the logs.
2. Whatever is chosen, the maintenance replay must not be refused by a lease no process holds.
3. Witness: extend the reproduction above — the replay after a dead holder delivers the pending
   revision without waiting out the full TTL.

## Touch points

`packages/control/src/operations-catalog.ts`, `packages/control/src/db.ts`,
`packages/control/src/__tests__/operations-catalog-window.test.ts`.

<!-- Origin: cheap-rebuild sprint WU8 run log, 2026-08-21; rewritten by WU2 of the
     bring-up-without-surprises sprint after the reproduction. -->
