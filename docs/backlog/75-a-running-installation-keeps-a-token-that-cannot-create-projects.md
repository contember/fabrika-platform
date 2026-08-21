---
id: 75
title: Re-mint an installation's integration token in place
blocked-by: []
---

# 75 — Re-mint an installation's integration token in place

**Summary.** A Zerops integration token's grants are fixed at mint time. An installation minted before
[ADR-0034](../decisions/0034-the-control-plane-creates-the-projects-it-owns.md) holds a token without
`canCreateProjects`, and nothing in `fabrika` can give it one. Effort S.

## Problem

`platform install` mints with `canCreateProjects` since ADR-0034 (`packages/installation-zerops/src/install.ts`),
but a token minted earlier fails the first `namespaces create` at `POST /client/{id}/project/import` with
`403 insufficientPermissions` — the wall the first live namespace hit, cleared by a manual
`zops token integration update`. The repair must re-pass every existing project grant in the same call,
because the update API replaces the grant set wholesale.

The diagnosis half of this item is done: since the cheap-rebuild sprint, a failed namespace carries the
platform's own code (`insufficientPermissions`) and message on its row, the console points at the
token's grants, and the failure lands at the first call — before a project exists. What is left is the
repair: no `fabrika` command re-mints or updates the token, and there is no pre-ADR-0034 installation
left to exercise one against, so this ships only when one exists or when a fresh token can be
deliberately under-granted for the test.

A synchronous preflight (refusing `create` before enqueueing) was considered and not built: no
introspection endpoint that reads a token's own capabilities is recorded in
[`../reference/zerops-platform.md`](../reference/zerops-platform.md), and guessing one is not evidence.
If the rebuild's live run finds such an endpoint, record it there first.

## Approach / acceptance

A `fabrika platform` verb that re-mints or updates the installation's token in place, carrying every
existing project grant forward and writing the new value to the `control` service only. Witness: on an
installation whose token lacks the flag, one documented command restores it without dropping a grant,
and the next `namespaces create` reaches `ready`.

## Touch points

`packages/installation-zerops/src/`, `packages/provider-zerops/src/api.ts` (`createIntegrationToken`,
and the update call once it is measured live), `packages/cli/src/`.

<!-- Origin: found while provisioning the first live app namespace, 2026-08-18; rescoped by the cheap-rebuild sprint WU7, 2026-08-21. -->
