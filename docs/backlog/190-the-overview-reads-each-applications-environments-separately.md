---
id: 190
title: The overview reads each application's environments separately
blocked-by: []
---

# 190: The overview reads each application's environments separately

**Summary.** Give Control one read that returns the environments of several applications, so the console overview
stops making one `apps.environments.list` call per listed application. Small; a contract addition.

## Problem

The overview's applications table shows each application's environments. Control answers environments only for one
application at a time (`apps.environments.list`, `packages/control/src/control-rpc.ts:257`), so the overview's loader
calls it once per listed application, up to `APP_TABLE_LIMIT` (8) calls on every load of the console's landing page
(`packages/dashboard/src/routes/index.tsx:31`). Load time and Control's load grow with the fleet, and the cap is what
keeps the table from showing more applications.

## Approach / acceptance

- A read on the `apps` router that takes a list of application ids (or none, meaning every application the caller
  may manage) and returns their environments grouped by application, in one query
  (`registry.listAppEnvs` for many ids at once).
- Authorization stays per application: an id outside what the caller may `app.manage` is left out of the answer (or
  refused, if the contract prefers that), never answered; the existing single-app read keeps its own check.
- The overview's loader makes one call for the environments, and the table's cap is set by layout, not by request
  count.
- A Control test that a caller managing only some applications gets only their environments; a dashboard test that the
  overview makes one environments call.

## Touch points

`packages/control-contract/src/rpc.ts`, `packages/control/src/control-rpc.ts`,
`packages/control/src/api/registry/environments.ts`, `packages/control/src/db/registry.ts`,
`packages/dashboard/src/routes/index.tsx`.
