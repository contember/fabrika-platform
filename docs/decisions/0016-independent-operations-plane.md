---
id: 0016
title: Add an independent Operations plane
status: accepted
date: 2026-07-30
---

# 0016 — Add an independent Operations plane

## Context

Fabrika presents Delivery and Access as two parts of one operator console.
Delivery owns application registration, environments, resources, deploy runs,
and release execution. Access owns principals, policy, credentials, and audit.
Neither plane owns the runtime feedback that tells an operator whether a
successfully deployed application is healthy.

Poplach is a separate Sentry replacement in `projects/oss/poplach`. It already
implements Sentry-envelope ingestion, queue-backed persistence, issue grouping
and triage, source-map resolution, regressions, alert rules and notification
channels, and ingest-pipeline health. It also consumes the same application
runtime and IAM capabilities that Fabrika now publishes as `@fabrika/app` and
`@fabrika/auth`. Keeping it separate would require coordinated releases and a
second application, environment, identity, and operator-navigation model.

Absorbing Poplach directly into `@fabrika/control` would remove a repository
boundary but create a worse runtime boundary. Telemetry intake is public,
high-volume, asynchronous, and retention-heavy. Control is the authoritative
registry and deploy coordinator. Sharing its request path or persistence with
telemetry would couple deployment availability and latency to an unrelated data
plane.

The broader possible destination is described in
[the Operations plane idea](../ideas/operations-plane.md). Logs, metrics, traces,
and incident management are useful possibilities, but committing to them before
their query, retention, and operating requirements are known would turn the
initial integration into an open-ended observability-platform build.

## Decision

We will add **Operations** as a third Fabrika product plane beside Delivery and
Access.

The initial Operations version will absorb Poplach as an **Errors** capability
and add the Fabrika-native context required to make it part of the platform:

- application, environment, and service identity from the Delivery registry;
- deploy-run, commit, release, and source-map correlation;
- error ingestion, grouping, triage, assignment, regressions, and alerts;
- active service health plus telemetry-pipeline health;
- IAM-owned principals, authorization, and audit;
- one Operations section in the unified Fabrika console.

Operations will be a separate backend service with its own persistence,
background work, and direct telemetry-ingest endpoints. Control will expose a
narrow same-origin operator gateway, as it does for IAM administration, but it
will not proxy application telemetry or store Operations domain data.

Control remains the authority for applications, environments, services, and
deploy runs. Operations stores their stable identifiers and its own derived
state; it does not retain a second authoritative project registry. IAM remains
the authority for principals and permissions. Operations uses IAM identities for
assignment and emits audit events for operator mutations.

The service will have Cloudflare and Bun/Zerops composition roots. Its shared
domain will depend on runtime-neutral repositories and platform ports. A signal
may use a provider-specific storage implementation when its semantics cannot be
represented honestly by a common lowest-level store.

The console and package vocabulary will use **Operations** for the plane and
**Errors** for the imported Poplach capability. The Poplach repository and name
may remain during migration, but they are not a permanent second platform
boundary.

Logs, general-purpose metrics, distributed traces, and incident management are
not accepted by this ADR. They remain target-state ideas and require their own
decisions when their concrete product and storage requirements are known.

## Consequences

- Fabrika covers the feedback loop after delivery without making control a
  telemetry database.
- Errors can link directly to the deploy and release that introduced them.
- Applications no longer need a separately administered Poplach project.
- The installation topology gains another stateful service on both supported
  platforms.
- Operations needs portable SQL, blob, queue, scheduling, notification, and
  frequency-aggregation implementations. Existing Fabrika ports cover only part
  of that surface.
- Direct ingest and the operator gateway require distinct authentication,
  authorization, rate-limit, and availability policies.
- Migrating existing Poplach installations requires an explicit adoption and
  cutover path.
- The broad Operations name reserves product space without claiming that the
  initial version already provides full logs, metrics, and tracing.

## Alternatives considered

### Keep Poplach standalone and link to it

This preserves repository independence but duplicates application registration,
environment identity, release metadata, IAM integration, deployment, and
operator navigation. Most valuable release correlations would remain eventual
cross-product integrations.

### Move Poplach into the control service

This gives the smallest package count but couples a high-volume telemetry data
plane to the deploy coordinator's persistence and availability. It also makes
future logs or traces structurally dangerous to add.

### Integrate only the Poplach UI

A shared console alone does not remove the duplicate project and release models
or provide portable installation and lifecycle management. It creates the
appearance of one platform without the underlying ownership model.

### Build logs, metrics, and tracing in the first version

Those signals have different storage, query, sampling, and retention economics.
Building them before concrete requirements would delay the already useful error
and release-health integration and risk a generic but shallow observability
system.
