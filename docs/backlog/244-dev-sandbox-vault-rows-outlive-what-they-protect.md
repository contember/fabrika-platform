---
id: 244
title: Dev sandbox vault rows outlive what they protect
blocked-by: []
---

# 244 — Dev sandbox vault rows outlive what they protect

**Summary.** Two leftovers of the dev sandboxes outlive their owner: a vault row and IAM return origins. None grants
access on its own; each is clutter a later audit has to explain. Small.

## Problem

1. **The sandbox host key.** `deployment_namespaces.sandbox_key_ref` names a vault row that Control seals the first time
   a namespace's dev environment needs its Box host (`packages/control/src/dev/sandbox-keys.ts`). Removing the namespace
   (`fabrika control namespaces remove`) does not delete that vault row.
2. **Stale return origins.** IAM's return origins of a dev environment are the origins of its ready sandboxes, sent with
   the next bootstrap run (`packages/control/src/return-origins.ts`). A removed sandbox's origin stays registered until
   another workspace of the environment bootstraps, and the last sandbox's origin stays registered for good, because
   IAM refuses an empty set.

## Approach / acceptance

1. Delete the sandbox host key's vault row in the namespace removal use case. Test: after `namespaces.remove`, the
   vault holds no row under the namespace's sandbox key purpose.
2. Re-register the environment's return origins after a sandbox removal, and decide what a dev environment with no
   sandbox registers. Test: after removing one of two sandboxes, IAM's return origins of `<app>@<env>` hold only the
   other's origin.

## Touch points

- `packages/control/src/api/namespaces.ts`
- `packages/control/src/dev/service.ts`
- `packages/control/src/return-origins.ts`
