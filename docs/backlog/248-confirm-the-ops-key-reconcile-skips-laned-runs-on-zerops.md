---
id: 248
title: Confirm the ops key reconcile is a no-op for a laned run on Zerops
blocked-by: []
---

# 248 — Confirm the ops key reconcile is a no-op for a laned run on Zerops

**Summary.** A dev bootstrap is a run in its workspace's lane, and the ops key reconcile is per environment. It is
probably never reached on Zerops; confirm it, and pin it with a test. Small.

## Problem

`executeDeploy` (`packages/control/src/run-lifecycle.ts`) reconciles the environment's ops key
([ADR-0069](../decisions/0069-control-reaches-an-application-environments-object.md)) when the provider serves the ops
channel for the approved access and the environment has a domain. A `dev` environment has a domain, and several
workspaces' bootstraps of one environment would each reconcile the one key, each against its own lane. The ops channel
is believed to be Cloudflare's only, so the branch should not run for a `dev` environment on Zerops, but no test says so.

## Approach / acceptance

Confirm that `ZeropsControlProvider.opsChannel` is absent or false for every access, so a laned run never reconciles an
ops key. Add a test that a dev bootstrap on the Zerops provider hands `FABRIKA_OPS_KEY_DIGESTS` as null. If it is not a
no-op, decide the key's scope for a laned run first.

## Touch points

- `packages/control/src/run-lifecycle.ts`
- `packages/control/src/ops-key.ts`
- `packages/provider-zerops/src/control.ts`
