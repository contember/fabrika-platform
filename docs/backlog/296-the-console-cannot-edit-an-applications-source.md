---
id: 296
title: The console cannot edit an application's source fields
blocked-by: []
---

# 296 — The console cannot edit an application's source fields

**Summary.** On an application with a protected environment only a person may change its default branch, worker
directory, build command, config path or repository, but the console has no form for any of them; the person has to
call `apps.update` from the browser's developer tools. P3, size S.

## Problem

`apps.update` on an application with a protected environment refuses every caller but a person
(`requirePersonToChangeSource`, `packages/control/src/api/registry/apps.ts`; ADR-0050 §4): a key gets 403 "only a
person changes its application's defaultBranch". The console shows `repoUrl` and `defaultBranch` read-only
(`packages/dashboard/src/routes/apps/detail.tsx`) and `workerDir` and `buildCmd` as plain fields; its only
`apps.update` call is the GitHub installation binding (`BuildConfigSection.tsx`). Moving a protected `prod` from a
feature branch to `main` after the merge therefore takes a hand-written `fetch` to `/api/rpc` in the console's own
page, the one path that satisfies the rule. Unregistering and registering again is no way out: deleting a protected
environment takes a person too, and the environment starts protected again.

## Approach / acceptance

An edit form in the app's Build config section for `defaultBranch`, `workerDir`, `buildCmd` and `configPath` (and
`repoUrl`, if moving an application to another repository is to be supported), shown to a holder of `app.manage`, that
sends only the changed fields through `apps.update` and shows Control's refusal as it is. Acceptance: a console test
changes the default branch of an application with a protected environment through the form, and the request carries
only `defaultBranch`.

## Touch points

`packages/dashboard/src/components/app-detail/BuildConfigSection.tsx`, `packages/dashboard/src/routes/apps/detail.tsx`.
