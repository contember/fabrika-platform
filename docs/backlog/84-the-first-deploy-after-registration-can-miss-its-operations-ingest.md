---
id: 84
title: The first deploy after registration can miss its Operations ingest
blocked-by: []
---

# 84 — The first deploy after registration can miss its Operations ingest

**Summary.** On the 2026-08-21 live rebuild the second registered application deployed twice without
`FABRIKA_OPERATIONS_DSN`, `FABRIKA_APP_ID`, `FABRIKA_ENVIRONMENT` and `FABRIKA_SERVICE_KEY` — the
Operations-managed values the deploy injects only when the app's ingest config is active — although
Operations already listed the source. A later catalog change (an identical environment PUT) made the
next deploy carry them. Cause not established. Effort M.

## Problem

Timeline, all on one installation running `v0.0.25`: `register` of the second app at T; `deploy` at
T+30 s and again at T+8 min, both `DEPLOY_FAILED` because the example app requires the DSN at start;
the service's environment read back carried `FABRIKA_IAM_ISSUER` and `FABRIKA_RELEASE` only. The
Operations console's Sources page listed the new source by then — the source reaches Operations only
through the catalog reconcile, so a sync had run and been accepted. After `apps environments put` with
unchanged values at T+17 min the next deploy carried all four keys and succeeded. The first app,
registered 35 minutes before its successful deploy, never showed the gap. No `operations catalog sync
failed` line was logged in the window.

`run-lifecycle.ts` reads `getActiveIngestConfig`, which needs `dsn`, `ingest_project_id` and
`activated_revision` all set; `markApplied` sets them per `(app, env, service_key, credential_id)`
from the reconcile response. Candidates, none confirmed: the change-triggered flush returned
`coalesced` against a lock left behind by the `v0.0.25` restart 12 minutes earlier (TTL 5 min) and
the 5-minute maintenance replay filled the gap later; a reconcile that applied on the Operations side
but failed before `markApplied` without reaching the log; a response whose `ingest` omitted the new
source. The deploy itself does not wait for, or report, a missing ingest config.

## Approach / acceptance

1. Establish the cause with the control database of a fresh installation: register two apps
   minutes apart, read `operations_ingest_configs` and `operations_catalog_sync` after each, and
   capture the catalog sync summaries (log them at info level — `applied` / `coalesced` / `failed`
   with the revision — so a live installation can answer this without database access).
2. Decide whether a deploy should wait briefly for a pending catalog projection, or at least write a
   run-log line naming that the Operations values were skipped because no ingest config was active.
3. Witness: a control test that registers an app while a catalog flush holds the lock and asserts
   the app's ingest config is active before its first deploy reads it, or that the deploy log names
   the gap.

## Touch points

`packages/control/src/operations-catalog.ts`, `packages/control/src/run-lifecycle.ts`,
`packages/control/src/db.ts`, `packages/control/src/__tests__/`.

<!-- Origin: cheap-rebuild sprint WU8 run log, 2026-08-21. -->
