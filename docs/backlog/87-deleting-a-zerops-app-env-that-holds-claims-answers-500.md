---
id: 87
title: Deleting a Zerops app env that holds claims answers 500
blocked-by: []
---

# 87 — Deleting a Zerops app env that holds claims answers 500

**Summary.** `namespace_resource_claims (owner_app_id, owner_env)` references `app_envs` with
`ON DELETE RESTRICT`, and every Zerops app env acquires claims at registration. `deleteApp` and
`deleteAppEnv` issue a bare `DELETE`, so on Zerops both raise a foreign-key error and answer 500
before the proxy republish the security review added ever runs. The app stays routed by the proxy
and stays in the registry. Needs a decision, not just a fix. Effort M.

## Problem

- The `namespace_resource_claims` foreign keys in `packages/control/migrations/0001_init.sql` and
  `migrations-postgres/0001_init.sql` make the claim rows
  restrict the env delete; `app_envs.app_id` cascades from `apps`, so an app delete hits the same wall.
- `deleteAppEnv` / `deleteApp` (`packages/control/src/db.ts`) delete only the env or app row;
  `deleteNamespaceResourceClaimsForOwner` exists but is called only from the registration rollback.
- The review's fix for finding H6 republishes the namespace proxy after a delete
  (`namespaceProxyChanged`, `packages/control/src/api/namespaces.ts`). It is reachable today only for
  an env without claims, which on Zerops means none.

## The decision

Releasing the claims in the delete transaction is the one-line fix and the wrong default: a claim
is what stops another app from adopting the deterministic service name
(`packages/provider-zerops/src/service-names.ts`), and the live service, its database and its
secrets survive the registry delete. A released name is adoptable by the next app registered
with the same id, which then inherits the orphaned service and everything in it
([ADR-0034](../decisions/0034-the-control-plane-creates-the-projects-it-owns.md) makes control the
owner of what it created). The options:

1. **Delete releases claims and tears the services down**, in one job: refuse the delete when the
   namespace is not `ready`, enqueue a removal job that deletes the claimed services through the
   provider, then releases the claims and the env row, then republishes the proxy. Slow, complete.
2. **Delete releases claims and leaves the services**, marking them orphaned in the namespace for
   an operator to remove. Fast; the orphan is adoptable unless adoption of an existing service is
   refused for a claim that was released rather than never held.
3. **Delete is refused while claims exist**, with a message naming the `namespaces` verb that
   releases them. Turns today's 500 into a 409 and moves the decision to the operator.

## Approach / acceptance

Pick one in a short ADR or a decision line in this item, then: `deleteAppEnv` and `deleteApp` run
their claim handling in the same guarded transaction as the row delete; the proxy republish runs
after it; a registry test seeds an env WITH claims and asserts the chosen outcome (today's tests seed
without claims and say so). Whatever is chosen, the delete answers a real status, never a raw
foreign-key 500.

## Touch points

- `packages/control/src/db.ts` — `deleteAppEnv`, `deleteApp`, `deleteNamespaceResourceClaimsForOwner`.
- `packages/control/src/api/registry/{apps,registration}.ts` — the two delete use cases.
- `packages/control/src/api/namespaces.ts` — a removal job if option 1.
- `packages/control/CLAUDE.md` — the "namespace proxy FOLLOWS the registry" bullet.

<!-- Origin: security review 2026-09-02, finding H6 (A7-3); found by the independent review of the fix. -->
