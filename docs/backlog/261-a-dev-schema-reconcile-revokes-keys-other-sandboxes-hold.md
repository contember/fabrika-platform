---
id: 261
title: A dev schema reconcile revokes keys other sandboxes hold
blocked-by: []
---

# 261 — A dev schema reconcile revokes keys other sandboxes hold

**Summary.** All sandboxes of a dev environment share one IAM application, and IAM's schema reconcile revokes the keys
of every workload the published schema no longer declares. Control's additive reconcile keeps its record of such a key
and hands it to the next sandbox as fresh. Medium.

## Problem

Workspace A's contract drops job J (or every membership operation) and A bootstraps. IAM's schema reconcile
(`packages/iam/src/repositories/app-schema.ts`) revokes J's keys, or deletes the membership keys, for `<app>@<env>`.
Control reconciles in additive mode (`packages/control/src/workload-credentials.ts`,
`packages/control/src/membership-transport.ts`), so it drops no record, and the record still has more than half its
lifetime left. When workspace B's sandbox, whose contract still declares J, bootstraps again, it receives the revoked key,
and `dev_sandboxes.keys_expire_at` says the keys are good for weeks. B's webhooks, public procedures or member operations
fail until a rotation. Jobs do not run in a sandbox, so a job key is harmless; the rest are not.

## Approach / acceptance

In additive mode, issue a new key for a slot whose recorded key IAM no longer honours: either IAM's schema reconcile
reports the credential ids it revoked and Control drops those records, or the additive reconcile asks IAM whether the
recorded credential is active. A test: A publishes a contract without a webhook, then B's bootstrap gets a new webhook
key that IAM accepts.

## Touch points

`packages/control/src/workload-credentials.ts`, `packages/control/src/membership-transport.ts`,
`packages/iam/src/repositories/app-schema.ts`, `packages/control/src/run-lifecycle.ts`.

<!-- Origin: the review round of the dev key expiry fix (#89). -->
