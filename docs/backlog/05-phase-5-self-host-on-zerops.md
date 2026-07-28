---
id: 05
title: Phase 5 — self-host fabrika on Zerops
blocked-by: [./04-phase-4-zerops-driver.md]
---

# 05 — Phase 5 — self-host fabrika on Zerops

**Summary.** Run fabrika itself on Zerops: control plane, IAM service, dashboard —
deployed by fabrika, on Zerops.

## Problem

Phase 4 deploys _apps_ to Zerops. The platform goal is a client running **entirely**
off Cloudflare, which means fabrika's own components run on Zerops too.

## Approach / acceptance

The control plane lives in its own `platform` project, separate from the apps
project, so that a client breaking the apps project cannot take down the thing that
repairs it
([ADR-0006](../decisions/0006-zerops-project-topology-is-a-registry-field.md)).

Self-deploy is the interesting case: the control plane triggers its own redeploy and
**dies**; on restart it reconciles in-flight runs by polling `/app-version`
([ADR-0003](../decisions/0003-no-deploy-runner-on-zerops.md)). No runner split is
needed here — that split exists only to survive self-deploy on Cloudflare.

Acceptance: fabrika deploys a new version of itself on Zerops, the old process
exits mid-run, and the new one comes up and correctly reports the run that killed
it as succeeded.

## Touch points

`@fabrika/control`, `@fabrika/iam`, `@fabrika/dashboard`, import YAML for the
`platform` project.
