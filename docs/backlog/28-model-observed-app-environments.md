---
id: 28
title: Model observed sources from the Fabrika registry
blocked-by: [./27-absorb-poplach-service.md]
---

# 28 — Model observed sources from the Fabrika registry

**Summary.** Replace Poplach's independent project directory with stable
application, environment, and service coordinates owned by Delivery.

## Problem

Poplach currently creates and lists its own projects, generates project DSNs, and
uses a `project` IAM scope. Fabrika control already owns applications,
environments, provider targets, deployment namespaces, and deploy runs. Keeping
both catalogs would allow names, lifecycle state, authorization scopes, and
deletion behaviour to drift.

Operations still needs local mutable state for alert policy, issue state, and
ingest configuration. It must distinguish that derived state from the canonical
Delivery registry.

## Approach / acceptance

- Define a versioned Operations source coordinate containing stable Fabrika
  application and environment ids plus an optional service id.
- Expose the minimum private catalog contract Operations needs; do not grant it
  direct access to the control database.
- Create, update, disable, and delete Operations projections from explicit
  registry lifecycle events or idempotent reconciliation.
- Map authorization to Fabrika-owned application/environment scopes rather than
  a second Poplach project scope.
- Remove project creation and rename flows from the Operations operator surface.
- Prove that registry retries are idempotent, deleted or disabled environments
  stop accepting new telemetry as specified, and existing Operations state stays
  attached to stable ids across display-name changes.

## Touch points

- Operations service and contract
- `packages/control/`
- `packages/control-contract/`
- `packages/auth-core/`
- `packages/dashboard/`

<!-- Origin: ../ideas/operations-plane.md and ADR-0016. -->
