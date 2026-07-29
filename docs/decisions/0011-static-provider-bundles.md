---
id: 0011
title: Compose one static provider bundle per installation
status: accepted
date: 2026-07-29
---

# 0011 — Compose one static provider bundle per installation

## Context

ADR-0002 put deploy-plan derivation behind `DeployDriver`, but the boundary stops
inside `@fabrika/engine`. The closed `AppConfigs` and `DeployTargets` maps still
name both platforms. `defaultDrivers` imports both implementations. The control
plane branches by `app_envs.platform`, stores Zerops-specific columns, and wires
Zerops-specific registration, secret, proxy, and reconciliation logic directly
into shared routes and lifecycle code.

This contradicts the product boundary in ADR-0001: one client installation chooses
one platform for the control plane, IAM, and every deployed app. Runtime
multi-provider dispatch adds coupling without serving a supported deployment
shape.

## Decision

We will package Cloudflare and Zerops as separate, statically composed provider
bundles behind an open provider contract.

The neutral contract will use versioned JSON envelopes for provider-owned target
and artifact data. It will expose small capabilities for deployment, external-run
reconciliation, cancellation, and secret-value management. A generic factory will
adapt each provider's typed codecs and implementation to the opaque runtime
contract without casts.

`@fabrika/engine` will execute a provider-supplied deploy session and will not
contain concrete drivers or a default registry. Shared control-plane lifecycle,
registry, and API code will receive one provider bundle from the installation's
composition root. Only the Cloudflare composition root may import the Cloudflare
provider; only the Zerops composition root may import the Zerops provider.

`@fabrika/platform` remains separate. It describes runtime capabilities such as
SQL, queues, blobs, and assets. The provider contract describes deployment-cloud
semantics. The installation composition root binds both axes together.

We will not preserve compatibility for the current internal API, manifest, or
database shape. Existing immutable migrations remain history; new migrations may
replace their resulting schema directly.

## Consequences

- Adding a provider does not require editing engine or control-core platform maps,
  branches, database columns, or API fields.
- Provider-specific authoring types, manifest codecs, API clients, deploy logic,
  secret policy, and reconciliation live with that provider.
- The control plane cannot load arbitrary provider code named by persisted data.
  The statically wired provider validates that stored envelopes name its own id
  and fails closed otherwise.
- Cloudflare no longer pulls `oblaka-iac` and Workers types into neutral config and
  engine typechecks.
- The number of workspace packages and composition tests increases.
- A future requirement for one installation to manage several providers would
  require a new decision and a runtime registry. It is deliberately not designed
  into this contract.

## Alternatives considered

- **Move only the engine drivers.** This improves dependency hygiene but leaves
  platform branches and provider-specific persistence in the control plane.
- **Load a dynamic provider registry per app-env.** This is appropriate for a
  multi-cloud SaaS control plane or third-party plugins loaded without rebuilding.
  It conflicts with the one-platform-per-installation boundary and adds plugin ABI,
  distribution, and trust concerns with no current consumer.
- **Split every capability into an unrelated port.** Small capabilities remain
  useful inside the chosen provider bundle, but assembling them independently
  would allow invalid combinations and scatter provider invariants across the
  composition root.
