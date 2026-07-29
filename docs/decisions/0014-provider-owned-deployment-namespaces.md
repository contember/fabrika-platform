---
id: 0014
title: Model deployment namespaces as provider-owned placement boundaries
status: accepted
date: 2026-07-29
---

# 0014 — Model deployment namespaces as provider-owned placement boundaries

## Context

ADR-0006 made Zerops project placement registry data instead of a code-level
constant. That permits several apps to target one project, but repeats the
project coordinate in every app environment and leaves the shared placement
itself unmanaged. The control plane cannot provision or reconcile the project's
proxy, identify infrastructure shared by its apps, or prevent one app import
from overriding another app's service.

ADR-0011 moved provider semantics behind statically composed provider bundles.
A placement abstraction therefore belongs in the open provider contract, while
its topology, target data, and lifecycle remain provider-owned.

Zerops projects are network and failure boundaries. Every service in one project
shares its private network, project resources, and `corePackage`. Separating
every app maximizes isolation but costs more; sharing a project reduces cost but
makes its apps one network trust domain. Operators need both choices without
leaking Zerops project concepts into the neutral control core.

Some shared projects also need one PostgreSQL service. Zerops supplies its
connection credential through a service-variable reference. Fabrika can safely
let apps consume that reference, but it cannot claim per-app database isolation
unless it also brokers databases, users, credentials, rotation, and deletion.

## Decision

We will model a deployment namespace as one provider-owned placement boundary.
The neutral control plane stores its identity, logical environment, provider,
ownership policy, provider target envelope, lifecycle state, and generic
resource claims. A provider may expose namespace normalization, provisioning,
and reconciliation capabilities. Providers that do not need namespaces remain
valid provider bundles without that capability.

On Zerops, one deployment namespace maps to exactly one project and owns exactly
one `proxy` service. All app environments assigned to it use the same logical
environment and provider. The `platform` project is not a deployment namespace;
global IAM, control, their database, and run storage remain outside this model.

Namespace assignment is registry data, not app source configuration. An app
environment may join a shared namespace or an exclusive namespace reserved for
that app. A successful deployment fixes the assignment. Moving deployed
services or data requires an explicit migration workflow and cannot be expressed
as an ordinary namespace update.

We will offer `cheap`, `mid`, and `full` as Zerops operator presets that resolve
to explicit placement, exclusivity, and resource policy. They are compositions,
not a closed enum in the provider-neutral contract:

- **Cheap:** several apps share a namespace, its proxy, and one namespace-owned
  `postgres` service. Each app owns its runtime services.
- **Mid:** several apps share a namespace and its proxy. Each app owns
  deterministically prefixed runtime and database services.
- **Full:** one namespace is exclusive to one app. It contains the namespace
  proxy and only that app's services; app service names need not carry a
  shared-namespace prefix.

The namespace owns its proxy and every shared infrastructure service. App
manifests may reference namespace-owned services but may not declare, mutate, or
delete them. Each app environment owns claims for its provider resources.
Claims survive removal from a later manifest; releasing or deleting a resource
requires an explicit operation. Shared namespaces require deterministic app
prefixes so ownership can be validated before any provider mutation.

**Invariant:** a Zerops namespace owns exactly one project and exactly one
reserved `proxy` service.

**Invariant:** an app import must not declare or override a namespace-owned
service or a provider resource claimed by another app environment.

For the cheap preset, all assigned apps share the physical PostgreSQL service
and its platform-issued connection credential. They form one database trust
domain. Fabrika does not create per-app databases, users, or credentials and
does not promise schema-level isolation. Apps consume
`${postgres_connectionString}` directly through Zerops service-variable
resolution.

**Invariant:** Fabrika never resolves, persists, or logs the shared PostgreSQL
connection value, and never copies it into project-level environment variables.

Failure boundaries follow ownership:

- A namespace proxy failure affects every app in that namespace.
- A cheap namespace PostgreSQL failure or credential rotation affects every app
  that consumes it.
- An app-owned runtime or mid/full database service failure remains app-owned,
  although apps in a shared Zerops project still share its network and project
  resource boundary.
- A full namespace isolates project network, capacity, and proxy failures from
  every other app namespace.
- The separate `platform` project remains available to reconcile an app
  namespace failure.

Existing Zerops environment rows will migrate once by grouping their provider
targets by project ID. Project and proxy coordinates then live in the namespace
target; the app target retains only app-specific coordinates. The migration
must reject inconsistent groupings rather than guess ownership. There will be
no dual-read compatibility path for the old envelope. Automatic project
deletion, claim release, and data movement are not part of namespace
reconciliation.

## Consequences

- Project placement, proxy initialization, shared resources, and app assignment
  gain one lifecycle and one provider-owned target.
- The neutral control core can support namespaced providers without naming
  Zerops or constraining future providers to the three Zerops presets.
- Shared-project deploys can validate resource ownership before an import with
  `override: true` reaches Zerops.
- Cheap is materially cheaper but intentionally has the broadest network,
  proxy, database, and credential blast radius.
- Mid isolates physical database services, but does not create a network
  boundary between apps in the shared project.
- Full has the clearest isolation and simplest ownership rules, at the cost of a
  project and proxy per app.
- Operators cannot move a deployed app by editing its namespace. A future
  workflow must copy data, switch domains, and retire the old services.
- Namespace adoption and reconciliation must validate reserved services and
  claims. They must fail closed when existing project state cannot be assigned
  safely.
- Per-app database/user brokerage inside a shared PostgreSQL service remains a
  separate feature requiring its own secret and data lifecycle.

## Alternatives considered

- **Keep project IDs duplicated in app targets.** Rejected because the control
  plane cannot own, provision, or reconcile the shared proxy and resources, and
  cannot attach authoritative cross-app claims to the placement boundary.
- **Put `cheap | mid | full` in the neutral provider contract.** Rejected because
  these names describe Zerops cost and isolation compositions. Another provider
  may expose different placement and resource policies.
- **Always use one project per app.** Rejected because it removes the requested
  lower-cost shared-project options. Full remains available when its stronger
  boundary is worth the cost.
- **Use one project for all environments or include the platform project.**
  Rejected by ADR-0006's stage/production and recovery-boundary analysis.
  Namespaces may share apps only within one logical environment.
- **Broker one database and user per app inside shared PostgreSQL.** Deferred
  because safe provisioning also requires credential storage, rotation,
  backup/restore, and deletion semantics. Cheap instead names its shared
  credential trust boundary explicitly.
- **Copy the shared connection string through Fabrika.** Rejected because Zerops
  already resolves service-variable references and ADR-0004 forbids Fabrika
  from becoming a second store for platform-managed secret values.
