---
id: 14
title: Wire edit-time secret write-through to the Zerops env API
blocked-by: [./13-control-plane-cannot-target-zerops.md]
---

# 14 — Wire edit-time secret write-through to the Zerops env API

[ADR-0004](../decisions/0004-secrets-live-in-the-platform.md) decides that on Zerops
the platform holds secret values and fabrika holds only references — and that the
write happens **when someone edits a secret**, not during a deploy. That is why the
Zerops plan has no `sync-secrets` step.

## Problem

`ZeropsApi.putServiceEnv` exists and is service-addressed. **Nothing calls it.** So
today a secret entered in fabrika reaches Zerops by no route at all.

Note the invariant this must not violate: never write an app secret to project-level
env, and the API client deliberately exposes no method that could
(`packages/engine/src/drivers/zerops/` — a test asserts the absence). Write-through
must stay service-level.

## Acceptance

Setting or changing a secret on a Zerops-targeted app-env writes it to that
service's `envSecrets` through the env API; the vault holds no copy; and the
existing "no env writes during a deploy" test still passes.

## Touch points

`packages/control/src/api/` (the secret routes), `src/secret-resolver.ts` (the
Zerops arm resolves to "already at the target"), `packages/engine`'s `ZeropsApi`.
