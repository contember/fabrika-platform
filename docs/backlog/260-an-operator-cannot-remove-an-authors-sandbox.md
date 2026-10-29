---
id: 260
title: An operator cannot remove an author's sandbox
blocked-by: []
---

# 260 — An operator cannot remove an author's sandbox

**Summary.** Deleting a dev environment or an application is refused while any workspace has a sandbox, and the refusal
tells the operator to call `delete_workspace`, which only the workspace's owner may call. Medium; an operator waits up to
14 days or asks every author.

## Problem

`assertNoDevSandboxes` (`packages/control/src/api/registry/apps.ts`) refuses with a 409 that names the workspaces and
says to delete them with `delete_workspace` or wait for maintenance. `delete_workspace` is an MCP tool scoped to the
workspace's owner; maintenance removes a sandbox only when its workspace is abandoned or saw no activity for 14 days, so
an author who keeps committing keeps the environment undeletable. A row stuck in `removing` (see
[257](257-a-failed-sandbox-delete-is-replayed-forever.md)) blocks the delete until the removal succeeds.

## Approach / acceptance

Give the environment delete an operator path: with an explicit flag, mark every sandbox of the environment (or of the
authoring environment's workspaces) `removing`, run `removeDevSandbox` for each, then delete, under the same fence the
delete uses ([252](252-a-bind-can-race-the-deletion-of-its-dev-environment.md)). Until then, the 409 names what the
operator can do. A test: an operator deletes a dev environment with two live sandboxes; both Box sandboxes, their keys and
secrets are gone and the namespace is republished.

## Touch points

`packages/control/src/api/registry/apps.ts`, `packages/control/src/api/registry/environments.ts`,
`packages/control/src/dev/service.ts`, `packages/cli/src/`, `docs/reference/mcp-authoring.md`.

<!-- Origin: the comprehensive review of the per-workspace dev sandboxes PR (#84). -->
