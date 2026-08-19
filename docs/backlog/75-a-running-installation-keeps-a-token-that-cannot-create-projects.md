---
id: 75
title: A running installation keeps a token that cannot create projects
blocked-by: []
---

# 75 — A running installation keeps a token that cannot create projects

**Summary.** [ADR-0034](../decisions/0034-the-control-plane-creates-the-projects-it-owns.md) made
`platform install` mint the integration token with `canCreateProjects`. Every installation minted
before it still holds a token without the flag, and nothing tells its operator. Effort S.

## Problem

A Zerops integration token's grants are fixed at mint time (`docs/reference/zerops-platform.md`, the
2026-08-18 section), so the flag cannot be acquired later by the control plane itself. An installation
that predates ADR-0034 therefore fails the first `namespaces create` with `403
insufficientPermissions` on `POST /client/{id}/project/import` — the same wall the live installation
hit, which took a manual `zops token integration update` to clear.

Two things make it worse than a one-line release note. The repair must re-pass every existing project
grant in the same call, because the update API replaces the grant set wholesale; and the failure it
prevents is currently reported as a bare `namespace provision failed`
([72](72-a-failed-namespace-reports-nothing-an-operator-can-act-on.md)), so the operator has nothing
to connect to the note.

## Approach / acceptance

Either a `fabrika platform` verb that re-mints or updates the installation's token in place, carrying
the existing grants forward, or a preflight in `namespaces create` that names the missing capability
before anything is provisioned. The second is cheaper and fixes the diagnosis; the first fixes the
installation.

Witness: an installation whose token lacks the flag is told so — by name, before or instead of a
failed provision — and a documented single command restores it without dropping a grant.

## Touch points

`packages/installation-zerops/src/install.ts`, `packages/provider-zerops/src/api.ts`
(`createIntegrationToken`), `packages/provider-zerops/src/namespace.ts`, `packages/cli/src/`.

<!-- Origin: found while provisioning the first live app namespace, 2026-08-18. -->
