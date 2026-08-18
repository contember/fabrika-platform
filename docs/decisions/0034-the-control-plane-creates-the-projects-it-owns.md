---
id: 0034
title: The control plane creates the projects it owns
status: accepted
date: 2026-08-18
---

# 0034 — The control plane creates the projects it owns

## Context

[ADR-0025](0025-the-operator-installs-the-platform-fabrika-deploys-apps.md) gives the installation a
Zerops INTEGRATION token instead of the operator's personal one, so that a compromised control plane
cannot reach the whole account. `platform install` minted it with client role `NO_ACCESS` and one
project granted `ADMIN`, and `createIntegrationToken` deliberately did not expose `canCreateProjects`,
with the reason written into its doc comment: a token that creates projects receives `OWNER` on what
it creates, "which is exactly the scope this call exists to avoid".

A deployment namespace, meanwhile, IS a Zerops project. Every preset — `cheap`, `mid`, `full` —
compiles a project document and calls `importProject` on `POST /client/{id}/project/import` whenever
the namespace has no `projectId` yet. Registering an application requires a `ready` namespace.

The two decisions had never met on a real account. They meet as a `403`:

```
POST /client/{id}/project/import → 403 insufficientPermissions
```

Measured on 2026-08-18 with the exact token `control` holds on `fabrika-install-test`. Client-scoped
READS with the same token answer `200`, so the token is healthy; it simply may not create a project.
The consequence is total rather than partial: **no application can be deployed by an installation
whose token was minted this way**, on any preset. This is why the live application gate had never been
met — not because nobody had attempted it.

## Decision

We will mint the control plane's integration token with `canCreateProjects: true`, and send the flag
explicitly on every mint, exactly as `roleCode` is already sent when its value is the schema's default.

The scope this widens is bounded and it is the scope the control plane is FOR. `roleCode` stays
`NO_ACCESS`, so a project the token neither created nor was granted remains unreachable. What changes
is that the token may create projects and owns the ones it creates — which is a true description of
the relationship: fabrika provisions an app's project, reconciles it, and is the only thing that
should. ADR-0025's actual concern was account-wide authority, and `NO_ACCESS` still denies that.

The doc comment on `createIntegrationToken` that argued the other way is replaced rather than deleted,
so a future reader sees the trade rather than a bare flag.

## Consequences

An installation can provision app namespaces, which makes `register` and therefore every application
deploy reachable for the first time. A fresh `platform install` gets this from the start.

The blast radius of a compromised control plane grows from one project to that project plus every
project it has created, with `OWNER` on the latter — which includes deleting them. That is a real
increase and it is the price of the feature; the mitigation is that `OWNER` is confined to projects
fabrika itself created, and that the org-wide role stays `NO_ACCESS`.

Existing installations are NOT fixed by deploying this. Their token was already minted, and grants are
fixed at mint time. An operator updates the live token in place — `zops token integration update <id>
--can-create-projects` — and must re-pass the existing project grants in the same call, because the
API replaces the grant set wholesale.

## Alternatives considered

**Have the operator create each project and let control adopt it.** `namespaces.adopt` exists and
skips `importProject` entirely. Rejected as the primary path: the token's ADMIN grants are also fixed
at mint time, so every new app project would still need a re-minted token — the manual step lands in
the same place, and it lands on a human every time an app is onboarded rather than once.

**Let an application live in the installation's own project.** No new project, no new authority, and
it is what the live gate's wording describes. Rejected for now because a namespace resolves its proxy
by the hostname `proxy`, which is also the platform's own enforcement point: adopting the installation
project would reconcile the live proxy and, with `ready: false`, overwrite its manifest with an empty
one. Making an app shareable into the platform project is worth doing, and it is a bigger change than
this one.
