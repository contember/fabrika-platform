---
id: 0006
title: Zerops project topology is a registry field, defaulting to project-per-environment
status: accepted
date: 2026-07-28
---

# 0006 — Zerops project topology is a registry field, defaulting to project-per-environment

## Context

A Zerops **project** is the unit of isolation: a VXLAN private network with its own
balancers, DNS and firewall. Within a project, every service reaches every other by
hostname; across projects there is no private network at all — cross-project traffic
must use public access
([infrastructure](https://docs.zerops.io/features/infrastructure),
[internal access](https://docs.zerops.io/references/networking/internal-access)).

So "how do fabrika's app environments map onto Zerops projects?" is a real question
with real consequences, and it is tempting to answer it once, in the architecture.

Two facts push hard toward **one project per environment**:

- **There is no network isolation inside a project.** If staging and production
  share a project, a staging service can open a TCP connection to the _production_
  database by hostname. Nothing in the platform prevents it — service isolation
  governs environment-variable references, not reachability.
- **`corePackage` is per-project and cannot be downgraded** — `LIGHT` or `SERIOUS`,
  upgrade-only ([import reference](https://docs.zerops.io/references/import)). One
  project means one availability tier forced on both environments: either staging
  pays for HA, or production doesn't get it, permanently.

The counter-argument for a single project is that separating environments pushes
app→IAM traffic over the public internet. That argument is weak here: the IAM
service must be publicly exposed **anyway** for the browser OIDC flow, and the
app→IAM RPC path is cold-path only — the warm path verifies tokens locally
([ADR-0007](0007-proxy-based-auth-enforcement.md)).

## Decision

Zerops project topology is a **registry field**, not an architectural constant:
`app_envs.zerops_project_id`.

The **default** is project-per-environment. A deployment that wants a different
grouping sets the field; nothing in the engine or the driver assumes a particular
mapping.

The **control plane lives in its own `platform` project**, separate from the apps
project.

## Consequences

- Topology becomes a per-installation decision that can change without a code
  change — and different clients can differ.
- **Stage cannot reach prod.** That is the boundary that actually matters, and it is
  enforced by the platform rather than by convention.
- Each environment picks its own `corePackage`; production can be `SERIOUS` while
  staging stays `LIGHT`.
- **A client who breaks the apps project cannot take down the thing that repairs
  it.** Putting the control plane in its own project is a blast-radius decision, not
  a tidiness one.
- **Accepted and deliberate: apps within one environment can reach each other's
  databases.** One environment is one trust domain. Nobody should later "discover"
  this and treat it as a vulnerability — it is a chosen position, and the boundary
  we defend is stage↔prod, not app↔app.
- Cross-project hops (app → IAM, control plane → apps) traverse public endpoints, so
  they need real authentication rather than network-position trust. Given the IAM
  service is public anyway, this changes nothing in practice.
- Anything that enumerates or reconciles Zerops resources must key off the registry
  field, never off a naming convention.

## Alternatives considered

- **One project per app, all environments inside it.** Rejected: it puts staging and
  production on the same private network with no isolation, so staging can reach the
  production database; and it forces a single non-downgradeable `corePackage` on
  both. The only benefit — private cross-environment traffic — is a benefit for a
  path that shouldn't exist.
- **One project for everything, including the control plane.** Rejected for the same
  reasons plus one more: the control plane is the recovery tool. Sharing a failure
  domain with the apps it repairs means the repair tool dies with the thing that
  needs repairing.
- **Fix the topology in code (no registry field).** Rejected: the correct grouping
  depends on client size, budget and compliance posture, and getting it wrong is a
  migration rather than a config change. One byte in the registry avoids a
  permanent argument.
