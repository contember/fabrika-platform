---
id: 73
title: A failed namespace cannot be removed
blocked-by: []
---

# 73 — A failed namespace cannot be removed

**Summary.** The namespace contract has `list`, `get`, `plan`, `create`, `adopt` and `reconcile`, but
no delete. A namespace whose provisioning failed occupies its id permanently. Effort S.

## Problem

`ControlRpcContract.namespaces` (`packages/control-contract/src/rpc.ts:145-152`) exposes no removal,
and neither does the REST router. A failed row therefore stays, holds its resource claims, and keeps
its id reserved — `createDeploymentNamespace` refuses a duplicate id with 409, so a retry under the
same name is impossible and the operator must invent `notes-prod-2`.

Retrying under a NEW id is worse than it looks: provisioning may already have created a real project
before it failed, and the marker-based recovery that would have re-adopted it is keyed to the
namespace id. A second id therefore strands the first project rather than reusing it.

The omission is defensible for a READY namespace — deleting one that hosts running applications is a
destructive act needing its own design — but a namespace that never reached `ready` and owns no
registered app is a different case.

## Approach / acceptance

Add removal for the narrow case only: a namespace with no registered app environments, refusing while
any app references it. Decide explicitly whether it also deletes the provider project it created —
the safe default is that it does not, and says which project it is orphaning, since fabrika holds
`OWNER` on projects it creates ([ADR-0034](../decisions/0034-the-control-plane-creates-the-projects-it-owns.md)).

Witness: a failed namespace is removed and its id becomes reusable; a namespace with a registered app
is refused; the response names any provider resource left behind.

## Touch points

`packages/control-contract/src/rpc.ts`, `packages/control/src/api/namespaces.ts`, the registry
repository, `packages/cli/src/control.ts`, `packages/dashboard/src/routes/namespaces/`.

<!-- Origin: found while provisioning the first live app namespace, 2026-08-18. -->
