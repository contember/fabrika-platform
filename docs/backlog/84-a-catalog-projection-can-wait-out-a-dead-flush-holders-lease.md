---
id: 84
title: Catalog projection windows that remain after the shared lease
blocked-by: []
---

# 84 — Catalog projection windows that remain after the shared lease

**Summary.** The silence around this is closed (sprint "a bring-up without surprises", WU2): every
catalog sync logs its outcome and revision, most changes that coalesce against the flush holder's own
release are delivered by that holder, and a deploy that finds no active ingest configuration writes one
run-log line naming the catalog state it saw. A lease left behind by a dead flush holder now blocks for
at most one lease TTL (90 s): the sync holds the shared lease primitive of ADR-0044, and the
reproduction in `packages/control/src/__tests__/operations-catalog-window.test.ts` ("a lock left behind
by a dead holder drops every change until one lease TTL") witnesses it. What remains are the smaller
findings of the same reproduction, none changed yet. Effort S.

## Problem

- The handoff passes narrow the coalescing window rather than close it: after the last pass there is
  no final `getState`, so a change that lands in that pass's own release window still waits for the
  maintenance replay.
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
  configuration for. Nothing can log this — the next successful sync repairs it.

## Approach / acceptance

1. Decide per finding whether to close it or accept it now that both ends are visible in the logs.
2. A closed finding gets a witness in the reproduction above.

## Touch points

`packages/control/src/operations-catalog.ts`, `packages/control/src/db.ts`,
`packages/control/src/__tests__/operations-catalog-window.test.ts`.

<!-- Origin: cheap-rebuild sprint WU8 run log, 2026-08-21; rewritten by WU2 of the
     bring-up-without-surprises sprint after the reproduction; trimmed when ADR-0044's lease
     replaced the five-minute catalog lock. -->
