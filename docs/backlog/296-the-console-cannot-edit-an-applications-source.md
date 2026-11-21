---
id: 296
title: The console cannot edit an application's default branch or worker directory
blocked-by: []
---

# 296 — The console cannot edit an application's default branch or worker directory

**Summary.** On an application with a protected environment only a person may change its default branch or worker
directory, but the console has no form for either; the person has to call `apps.update` from the browser's developer
tools. P3, size S.

## Problem

`apps.update` on an application with a protected environment refuses every caller but a person
(`requirePersonToChangeSource`, `packages/control/src/api/registry/apps.ts`; ADR-0050 §4): a key gets 403 "only a
person changes its application's defaultBranch". The console shows `repoUrl` and `defaultBranch` read-only
(`packages/dashboard/src/routes/apps/detail.tsx`), and `workerDir` and `buildCmd` read-only too; its only
`apps.update` call is the GitHub installation binding (`BuildConfigSection.tsx`).

The default branch decides what the console's Deploy button deploys on an environment without a concrete trigger ref
(none, or a pattern; `triggerDeploy`, `packages/control/src/api/runs.ts`), and the base of a new MCP workspace and of
its merge (`packages/control/src/api/workspaces.ts`). Moving a protected, manually deployed `prod` from a merged
feature branch to `main` therefore takes a hand-written `fetch` to `/api/rpc` in the console's own page. Deleting the
environment and registering it again is no substitute: it drops the environment's secrets, variables and run history,
and the new environment starts protected again.

The application's `buildCmd` and `configPath` need no form: Control hands them to the provider
(`ProviderSource.buildCommand`, `configPath`) and no provider reads them; Cloudflare takes its config path from the
environment's artifact, which the console edits.

## Approach / acceptance

An edit form in the app's Build config section for `defaultBranch` and `workerDir`, shown to a holder of `app.manage`,
that sends only the changed fields through `apps.update` and shows Control's refusal as it is. Acceptance: a dashboard
component test changes the default branch through the form and the request carries only `defaultBranch`; an unchanged
form sends nothing; a 403 from Control is shown with its message.

## Touch points

`packages/dashboard/src/components/app-detail/BuildConfigSection.tsx`, `packages/dashboard/src/routes/apps/detail.tsx`,
`packages/dashboard/src/__tests__/`.
