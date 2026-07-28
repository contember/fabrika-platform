---
id: 15
title: Reconcile in-flight Zerops runs at startup
blocked-by: [./13-control-plane-cannot-target-zerops.md]
---

# 15 — Reconcile in-flight Zerops runs at startup

[ADR-0003](../decisions/0003-no-deploy-runner-on-zerops.md) makes this a hard
requirement, and it is the thing that lets the control plane deploy **itself** on
Zerops: fabrika triggers its own redeploy, the process dies mid-deploy, and Zerops
finishes the job regardless. Nobody is left to write the terminal status.

The answer recorded in the ADR is that on boot fabrika polls `/app-version` for any
run still `pending`/`running` and completes its record.

## Problem

Not built. `ZeropsApi` exposes `getAppVersion` / `latestAppVersion` for exactly this;
the wiring is control-plane work.

Note this is why the Cloudflare side needed a separate `vozka-runner` worker and
Zerops does not — worth keeping the asymmetry documented where someone will find it.

## Acceptance

Killing the control plane mid-deploy and restarting it leaves the run row correct
(succeeded or failed, matching what Zerops actually did) with no manual step, and
the stale-run sweep does not mark it failed in the meantime.
