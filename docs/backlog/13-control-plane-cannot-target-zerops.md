---
id: 13
title: The control plane cannot target Zerops
blocked-by: []
---

# 13 — The control plane cannot target Zerops

**This is the item that keeps Zerops support a library rather than a feature.** The
driver, the proxy and the Postgres layer are built and tested; nothing connects them
to a trigger.

## Problem

- `assembleJob` / `run-lifecycle.ts` build only a `cloudflare` target for
  `DeployContext`. There is no branch that produces the `zerops` arm, even though
  the union has one ([ADR-0009](../decisions/0009-per-driver-target-and-collaborators.md)).
- **`app_envs.zerops_project_id` does not exist as a column**, though
  [ADR-0006](../decisions/0006-zerops-project-topology-is-a-registry-field.md) makes
  it the whole mechanism by which topology is a registry field rather than an
  architecture. Without it there is nowhere to record which project an env deploys
  into.
- `RunnerJob` is the Cloudflare credential carrier and correctly stays that way
  (ADR-0003: Zerops has no runner). A Zerops deploy must therefore NOT go through
  the runner path at all — it runs in-process, as HTTP calls. That is a second code
  path in `executeDeploy`, not a variation on the existing one.

## Acceptance

A registered app whose env carries a `zerops_project_id` can be deployed from the
dashboard or a webhook; the run row, the relayed logs and the terminal status look
the same to the API as a Cloudflare run does; and no `RunnerJob` is constructed.

## Touch points

`packages/control/src/run-lifecycle.ts`, `src/index.ts` / `src/consumer.ts`, a new
migration in both `migrations/` and `migrations-postgres/`, `src/api/`.
