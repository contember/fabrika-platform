---
id: 297
title: Control accepts any string as an application's default branch
blocked-by: []
---

# 297 — Control accepts any string as an application's default branch

**Summary.** `apps.update`, `apps.create` and `register` store `defaultBranch` unchecked, so a workspace branch or a
name git refuses becomes what Deploy runs and what workspaces start from. P3, size S.

## Problem

The input schema takes any string (`defaultBranch: z.string().optional()`, `packages/control/src/control-rpc.ts`), and
`updateAppUseCase` writes it as it is (`packages/control/src/api/registry/apps.ts`). A manual deploy of an environment
without a concrete trigger ref then runs `refs/heads/<defaultBranch>` (`triggerDeploy`, `packages/control/src/api/runs.ts`),
and a workspace starts from it and opens its pull request into it (`packages/control/src/api/workspaces.ts`). A value
under `fabrika/` (`WORKSPACE_BRANCH_PREFIX`, `packages/control/src/ref-match.ts`) would make Deploy run a workspace
branch, which `canonicalTriggerRef` refuses for a trigger ref; an empty value, one with whitespace or a git-invalid name
(`main/`, `a..b`, `x.lock`, a leading `-`) fails only at deploy, as `ref_not_found`. The console's form refuses the
empty, whitespace and `refs/` cases before it sends; a key or the CLI does not go through it.

## Approach / acceptance

Check `defaultBranch` where it enters, on all three write paths: a non-empty branch name git accepts
(`git check-ref-format --branch` rules), not under `WORKSPACE_BRANCH_PREFIX`, without a `refs/` prefix, refused with a
400 that names the rule. Acceptance: a registry test refuses each of those values on `apps.update` and `register`, and
accepts `main` and `release/1.2`.

## Touch points

`packages/control/src/control-rpc.ts`, `packages/control/src/api/registry/apps.ts`,
`packages/control/src/api/registry/registration.ts`, `packages/control/src/api/registry/validation.ts`.
