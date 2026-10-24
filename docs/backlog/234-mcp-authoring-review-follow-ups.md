---
id: 234
title: MCP authoring and dev environment review follow-ups
blocked-by: []
---

# 234 — MCP authoring and dev environment review follow-ups

**Summary.** These are the P2 and P3 findings from the review of the MCP authoring and dev environment change. The P1 findings were fixed in that change. Each item below is small and independent.

## Problem

1. **One repository fails `list_workspaces`.** `listWorkspacesUseCase` (`packages/control/src/api/workspaces.ts`) reads each target's branches with one `readBranches` call per target. If any of these calls fails, the whole list fails, including the workspaces of every other target.
2. **A long `run_checks` reads as a gone launcher.** `DEV_LAUNCHER_BUSY_SILENT_SECONDS` (15 min, `packages/control/src/api/dev-environments.ts`) is shorter than the worst case of the check chain: three checks of up to 10 min each. While such a chain runs, `get_dev_status` reports `needs_bootstrap`, and `bind_dev` starts a bootstrap it does not need.
3. **A crash loop keeps a dev service running.** Every launcher report sets `activity_at` (`report` in `packages/control/src/db/dev-environments.ts`). This includes the reports of an application that crashes and respawns. Such an environment never looks idle, so `stopIdleDevServices` never stops it.
4. **A deleted workspace stays bound.** `abandonWorkspaceUseCase` (`packages/control/src/api/workspaces.ts`) deletes the branch and marks the workspace abandoned. It leaves `dev_environments.workspace_id` pointing at it, and the dev container keeps following the deleted branch's last head.
5. **Two doc comments sit on the wrong declaration.**
   - In `packages/control/src/db/registry.ts`, "Every environment an operator marked as an MCP authoring target" sits above `getKeptProtection` instead of above `listAuthoringAppEnvs`.
   - In `packages/github-app/src/repository.ts`, the `TreeWalker` comment ("Resolves repository paths through non-recursive tree reads…") sits above `requireBranchAt`.
6. **Two pieces are duplicated across packages.**
   - `DEV_STATES` in `packages/control/src/api/dev-environments.ts` repeats `DEV_STATUSES` from `@fabrika/app/dev/wire`.
   - `isSourcePath` in `packages/app/src/dev/wire.ts` repeats `isRepositoryPath` from `packages/control/src/api/workspaces.ts`.
7. **A fresh dev container migrates before its pending reset.** A switch to another workspace that also needs a bootstrap run raises the reset generation. The new container learns the generation that the database's last container applied, so its boot reconcile migrates the new workspace once, on the old schema. Only its next wait asks for the pending reset, which drops that schema and migrates again. The outcome is right, but the first migration can fail and briefly show `failed`.

## Approach / acceptance

1. Read each target independently. A target whose read fails lists its workspaces with no head, plus a per-item note, instead of failing the call. Test: a fake source that fails one target still lists the other target's workspaces.
2. Derive the busy limit from the check chain's own bound: the number of checks times the per-check timeout, plus a margin. Alternatively, have the launcher report a heartbeat while it is busy. Test: a launcher silent for 25 min during a three-check run is not `needs_bootstrap`.
3. Count only progress as activity: a commit, a bind, a sync, a reset or a check request. A report alone does not count. Test: an environment whose launcher keeps reporting `failed` is stopped after the idle window.
4. When a workspace is abandoned, unbind it from its dev environment in the same use case. Test: after `delete_workspace`, `get_dev_status` of the dev environment reads `unbound`, and a wait gets no sync.
5. Move both comments onto the declarations they describe.
6. Import `DEV_STATUSES` from the wire module. Share one repository-path predicate between `@fabrika/app/dev/wire` and Control, or document why the two must differ.
7. Let the launcher's first answer carry whether a reset is pending, as an additive wire field, so the boot reconcile resets before it migrates. Test: a switching bootstrap reports one migration, after the reset.

## Touch points

- `packages/control/src/api/workspaces.ts`
- `packages/control/src/api/dev-environments.ts`
- `packages/control/src/db/dev-environments.ts`
- `packages/control/src/db/registry.ts`
- `packages/control/src/dev/receiver.ts`
- `packages/github-app/src/repository.ts`
- `packages/app/src/dev/wire.ts`
- `packages/app/src/dev/launcher.ts`
