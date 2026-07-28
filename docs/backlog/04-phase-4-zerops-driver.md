---
id: 04
title: Phase 4 — Zerops deploy driver
blocked-by: [./03-phase-3-deploy-driver.md]
---

# 04 — Phase 4 — Zerops deploy driver

**Summary.** Implement `ZeropsDeployDriver` as pure HTTP against the Zerops REST
API — no runner, no container.

## Problem

Nothing deploys to Zerops yet. Per
[ADR-0003](../decisions/0003-no-deploy-runner-on-zerops.md), a Zerops deploy is
five HTTP calls, because Zerops runs the build itself.

## Approach / acceptance

The five calls: push secrets → apply the import YAML → trigger `/app-version` →
poll status and relay logs → reconcile the authorization schema.

Depends on:

- [ADR-0004](../decisions/0004-secrets-live-in-the-platform.md) — secrets are
  written **service-level only**, never project-level. That invariant is a hard
  gate on this work.
- [ADR-0005](../decisions/0005-compile-app-config-to-static-manifest.md) — the
  driver consumes `fabrika.manifest.json`, never executes app config.
- [ADR-0006](../decisions/0006-zerops-project-topology-is-a-registry-field.md) —
  resolve the target project from `app_envs.zerops_project_id`, never from a naming
  convention.

Control-plane requirement that falls out of ADR-0003: **startup reconciliation of
in-flight runs** by polling `/app-version`. Run state must live in the database; a
run whose status is only in memory is a lost run.

Acceptance: a real app deploys end-to-end to a Zerops project from the control
plane; killing the control plane mid-deploy and restarting it recovers the run's
status.

## Touch points

New Zerops driver in `@fabrika/engine`, `@fabrika/control` (run reconciliation),
registry schema (`app_envs.zerops_project_id`).

<!-- Facts and sources: ../reference/zerops-platform.md -->
