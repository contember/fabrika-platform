---
id: 0038
title: Size namespaces cheaply by default
status: accepted
date: 2026-08-21
---

# 0038 — Size namespaces cheaply by default

## Context

An app namespace used to key its database off the environment NAME. `env === 'prod'` bought
`postgresql:ha@18` at `oltp-production` and `corePackage: SERIOUS`; every other name got the cheap
shape. A name is not a size, and most apps are small on every environment they have.

The name did not even buy headroom. On Zerops a profile chooses the FLOOR and the PostgreSQL tuning
preset, not the cap: every PostgreSQL profile shares the same 8-core / 48 GB / 250 GB ceiling and the
same vertical autoscaler, measured against a live account and recorded in
[`../reference/zerops-platform.md`](../reference/zerops-platform.md) and in the comment on `oltp-hobby`
in `packages/installation-zerops/zerops/topology.ts`. What `oltp-production` buys is a floor of two
DEDICATED cores and 4 GB per container, and HA runs three containers — so a namespace named `prod` and
running one small application held six dedicated cores and 12 GB at rest, and could grow no further
than the cheapest profile could.

## Decision

We will size every namespace at the cheapest shape that runs, on **every** environment.

- `defaultPostgres` returns `postgresql:single@18` at `oltp-hobby` and no longer takes `env`
  (`packages/provider-zerops/src/namespace.ts`).
- `corePackage` defaults to `LIGHT` everywhere. The argument for `SERIOUS` in `installation-zerops` is
  that the platform project repairs the apps project, which no app namespace does.
- The namespace proxy floors at one container instead of two. `maxContainers` is unchanged, so load
  still scales out.
- The light platform tier's shared `db` moves from `oltp-staging` to `oltp-hobby`, dropping a 1 GB
  memory floor to 0.25 GB. An installation that wants a specific floor sets one on the service, which
  is where a per-installation value belongs ([ADR-0004](0004-secrets-live-in-the-platform.md)).
- The worked example stops branching on `env` for its database type, profile and container floor — an
  example is where people copy their defaults from.

**Invariant:** an app namespace's size never follows its environment name. HA and larger floors stay
available and become a deliberate act, through `--postgres-type` and `--postgres-profile`
(`packages/provider-zerops/src/cli-args.ts`, validated per type in
`packages/provider-zerops/src/namespace-command.ts`).

This does **not** cover the standard two-project platform tier. It keeps its two HA PostgreSQL
services and their stated profiles, deliberately untouched: identity and control-plane latency is felt
by every request, and that tier is not what an app namespace is.

## Consequences

A namespace's idle floor becomes one shared core and 0.25 GB of database plus one proxy container,
instead of six dedicated cores and 12 GB. The cheap shape is now what an unattended install, the CLI
and the worked example all produce, so nobody pays a production bill by naming an environment `prod`.

Flooring the namespace proxy at one container is a real availability trade: the proxy is the only
enforcement point ([ADR-0022](0022-the-proxy-is-the-only-enforcement-point.md)), so a restart is a
short outage rather than a rolling one. It is taken because a second container is a whole core of idle
floor on every namespace, and most namespaces hold one small app.

An application that genuinely needs HA must say so when the namespace is created. A namespace's stored
target is fixed at creation — `namespaces.reconcile` re-applies what is stored and takes no new target
— so choosing wrong is not cheap to undo; that gap is tracked in
[backlog 79](../backlog/79-a-namespace-target-cannot-be-changed-after-creation.md). Existing
namespaces are not resized by deploying this; their target is whatever was written when they were
provisioned.

## Alternatives considered

**Keep `prod` special.** The smallest change: leave the name-keyed branch and only lower the other
environments. Rejected because the branch is the defect. An environment name carries no size
information — a `prod` that serves ten requests a day and a `stage` that mirrors production load are
both ordinary — and the name bought no ceiling anyway, only a floor.

**Leave the defaults production-shaped and downscale per installation.** Every installation would
write its own smaller values where it wanted them. Rejected because a value that must be overridden on
every installation is not a default, and because the two failure modes are not symmetric:
over-provisioning is silent and arrives monthly, while under-provisioning is visible and fixable at
any time.
