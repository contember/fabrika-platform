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
3. **A crash loop keeps a dev sandbox awake.** Every launcher report sets `activity_at` (`recordReport` in `packages/control/src/db/dev-sandboxes.ts`). This includes the reports of an application that crashes and respawns. Such a sandbox never looks idle, so maintenance never parks it, nor removes it as stale.
4. **Two doc comments sit on the wrong declaration.**
   - In `packages/control/src/db/registry.ts`, "Every environment an operator marked as an MCP authoring target" sits above `getKeptProtection` instead of above `listAuthoringAppEnvs`.
   - In `packages/github-app/src/repository.ts`, the `TreeWalker` comment ("Resolves repository paths through non-recursive tree reads…") sits above `requireBranchAt`.
5. **Two pieces are duplicated across packages.**
   - `DEV_STATES` in `packages/control/src/api/dev-environments.ts` repeats `DEV_STATUSES` from `@fabrika/app/dev/wire`.
   - `isSourcePath` in `packages/app/src/dev/wire.ts` repeats `isRepositoryPath` from `packages/control/src/api/workspaces.ts`.
6. **A committed launcher state file passes for a restarted container.** `fabrika/dev-state.json` (`DEV_LAUNCHER_STATE_FILE`) is not a protected path (`isProtectedPath` in `packages/control/src/api/workspaces.ts`), and the build does not remove it. A copy committed to the workspace reaches a new container as if that container had already run: the launcher skips the schema check at boot and starts from the committed head instead of the bootstrap's. The same
   file breaks two more things (`readState` in `packages/app/src/dev/launcher.ts`):
   - A committed `"reset": 999` turns `reset_dev` into a no-op that Control reports as done, because
     `resetDevUseCase` accepts any `reset_applied` at or above the requested generation.
   - Invalid JSON throws outside `safeParse`, so the boot fails before the booted marker is written, and the activation
     fails.
7. **A committed booted marker passes readiness early.** A `fabrika/dev-booted` (`DEV_LAUNCHER_BOOTED_FILE`) committed
   to the workspace can pass the dev readiness check before `start` in `packages/app/src/dev/launcher.ts` deletes it.
8. **The booted marker is written after a failed boot.** `start` writes the marker in a `finally`, also when `apply`
   throws. `start` then rejects and `follow` never runs, yet readiness may still pass on the marker.
9. **The boot work counts against the 180 s readiness window.** Before the 30 s health wait come two asks of up to 20 s
   each, a reset, `migrate` and `verify`. The reset's `DROP SCHEMA` has no lock timeout while the superseded container
   is still connected.
10. **A stale schema-types failure after a reset loops.** When `verify` runs after a reset and fails because the
    committed schema types are stale, its message still says "call reset_dev" (`packages/app/src/dev/launcher.ts`), and
    a reset changes nothing.
11. **Open decision: the SPA type check and ADR-0062.** The build's `tsc` covers `web/` for every framework release in
    the window, so an application of an older release whose SPA does not type-check starts failing its build after a
    platform upgrade. The user deferred the decision.
12. **A private_key_jwt client's revocation passes without an assertion while its metadata is unreachable.** `authenticateRevokingClient` (`packages/iam/src/oauth-client-auth.ts`) refuses an assertion-less request only when the client's metadata document is known and declares `private_key_jwt`. This is deliberate: an unreachable document never keeps a token alive, and the token's own client binding still holds. It is recorded so the trade is revisited if a confidential client's revocation must always authenticate.

## Approach / acceptance

1. Read each target independently. A target whose read fails lists its workspaces with no head, plus a per-item note, instead of failing the call. Test: a fake source that fails one target still lists the other target's workspaces.
2. Derive the busy limit from the check chain's own bound: the number of checks times the per-check timeout, plus a margin. Alternatively, have the launcher report a heartbeat while it is busy. Test: a launcher silent for 25 min during a three-check run is not `needs_bootstrap`.
3. Count only progress as activity: a commit, a bind, a sync, a reset or a check request. A report alone does not count. Test: a sandbox whose launcher keeps reporting `failed` is parked after the idle window.
4. Move both comments onto the declarations they describe.
5. Import `DEV_STATUSES` from the wire module. Share one repository-path predicate between `@fabrika/app/dev/wire` and Control, or document why the two must differ.
6. Remove the state file in the build (`rm -f fabrika/dev-state.json` before the generated files are written), or protect it in `isProtectedPath`. Test: a commit that holds the file is refused, or a bootstrap of it boots as a new container.
7. Decide whether a client registered as `private_key_jwt` must always present an assertion to revoke. If so, refuse an assertion-less request when the metadata is unreachable, and document that such a token outlives the outage. Test: either way, a test pins the chosen behaviour with an unreachable metadata document.
8. Remove the marker in the build or in the sandbox deploy before it starts the launcher (`rm -f`), together with item 6's state file.
9. Write the marker only after `apply` returns. Alternatively, catch the error, report `failed` and keep following.
   Test: a boot whose apply throws leaves no marker, or reports `failed` and still answers the next sync.
10. Bound the reset (a `lock_timeout` on the `DROP SCHEMA`), or document the boot's worst case against the window.
11. Name `fabrika db codegen` when `verify` fails right after a reset. Test: a reset followed by stale committed types
    reports the codegen remedy, not `reset_dev`.
12. Either run `tsc` over `web/` only for a release from 0.9 on, or record an ADR-0062 exception for it.

## Touch points

- `packages/control/src/api/workspaces.ts`
- `packages/control/src/api/dev-environments.ts`
- `packages/control/src/db/dev-sandboxes.ts`
- `packages/control/src/db/registry.ts`
- `packages/github-app/src/repository.ts`
- `packages/provider-zerops/src/sandbox/deploy.ts`
- `packages/iam/src/oauth-client-auth.ts`
- `packages/app/src/dev/wire.ts`
- `packages/app/src/dev/launcher.ts`
- `packages/app/src/build-recipe.ts`
