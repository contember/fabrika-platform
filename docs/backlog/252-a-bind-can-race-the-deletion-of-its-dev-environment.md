---
id: 252
title: A bind can race the deletion of its dev environment
blocked-by: []
---

# 252 — A bind can race the deletion of its dev environment

**Summary.** Deleting a `dev` environment, or its app, is refused while it has a sandbox row, but the check and the
delete are separate statements. A `bind_dev` between them leaves a Box sandbox and a proxy secret that no record names.
Small.

## Problem

`deleteAppEnvUseCase` and `deleteAppUseCase` call `assertNoDevSandboxes` (`packages/control/src/api/registry/apps.ts`)
and then delete the environment row. `dev_sandboxes` references `app_envs` with `ON DELETE CASCADE`
(`migrations*/0025_dev_sandboxes.sql`). A `bind_dev` that inserts its `creating` row after the check is deleted by the
cascade; its Box sandbox, created next, and its proxy secret's vault row are then named by nothing, and no maintenance
pass finds them. A row that outlived its environment some other way fails `removeDevSandbox` on every pass, because the
removal reaches the Box host through the environment (`packages/control/src/dev/service.ts`).

## Approach / acceptance

Make the check part of the delete's batch: delete the environment only where no `dev_sandboxes` row exists, under the
coordinate lock the delete already takes, and have `insertCreating` take the same lock. Test: a bind that inserts a row
between the check and the delete makes the delete fail with the sandbox refusal, and leaves the row.

## Touch points

- `packages/control/src/api/registry/apps.ts`
- `packages/control/src/api/registry/environments.ts`
- `packages/control/src/db/registry.ts`
- `packages/control/src/db/dev-sandboxes.ts`
